/**
 * dsh-session-vault — the host-side export / import engine.
 *
 * Everything here goes through the real DSH host services rather than the
 * storage directory:
 *
 *   ctx.sessionPersistence  — `stat` / `list` / `open` / `create` / `append`
 *   ctx.workspaceRegistry   — workspace records and session membership
 *   ctx.sessionProjectionCache — cached titles, used as a display hint only
 *
 * That is deliberate. Writing `~/.dsh/sessions/**` and `workspace.json` by
 * hand would mean re-implementing the projectKey directory encoding, the
 * session-format generation names, the cross-process write lease, and the
 * workspace domain's write chain — and getting any of them wrong corrupts a
 * session log. The services own all of that; this plugin only shapes data.
 *
 * Consequences worth stating plainly:
 *
 *  - Export is *normalising*: it re-encodes a session as the events the
 *    persistence layer returns, so an archive survives a session-format
 *    migration and can be imported by a newer DSH than it was written by.
 *    A byte-exact copy of the storage directory is a different feature.
 *  - Import cannot overwrite an existing session, because
 *    `SessionPersistence` exposes no delete. Colliding ids are either skipped
 *    or imported under a fresh id; both are safe and neither loses data.
 *  - Delete is the one operation *no* service offers at all. Reclaiming an
 *    unmounted session's disk space therefore means removing its artifact
 *    directory here, which is exactly the write this module otherwise refuses
 *    to make. It is fenced accordingly: only sessions no workspace accounts
 *    for, that are not live, and — unless the caller explicitly opts in — that
 *    are not archived; the path is re-derived from the id and confined to the
 *    sessions root before any recursive remove. Nothing else in this module
 *    writes below `<DSH_HOME>/sessions`.
 *  - A title is presentation, and it is resolved in three rungs: the
 *    projection cache, then the session's own first human message. The cache
 *    is a *hint* — it is empty for a session this process never projected — so
 *    a listing that stopped at its first miss showed every row as untitled.
 *
 * @module dsh-session-vault/engine
 */

import { mkdir, readFile, readdir, rm, stat as statFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

import { dshHomePath } from './home.js';

import { ARCHIVE_EXTENSION, readArchive, writeArchive } from './archive.js';

/** Raised when the host composition lacks a service this engine requires. */
export class EngineServiceError extends Error {
  /**
   * @param service - the missing Cordis service name.
   */
  constructor(service) {
    super(
      `dsh-session-vault requires the "${service}" host service; this profile does not compose it`,
    );
    this.name = 'EngineServiceError';
  }
}

/**
 * Read an optional host service.
 * @param ctx - the plugin context.
 * @param name - exact service name.
 * @returns the service, or `undefined` when this profile does not compose it.
 */
function readService(ctx, name) {
  return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
}

/**
 * The directory archives are written to by default.
 * @returns `<DSH_HOME>/dsh-session-vault/exports`.
 */
export function defaultExportDir() {
  return dshHomePath('dsh-session-vault', 'exports');
}

/* ------------------------------------------------------------------- titles */

/** Events read from the head of a log when no cached title exists. */
const TITLE_SCAN_EVENTS = 32;
/** Sessions whose log one listing opens for a fallback title. */
const TITLE_SCAN_BUDGET = 128;
/** Logs opened at once while deriving fallback titles. */
const TITLE_SCAN_CONCURRENCY = 4;
/** Word cap for a derived title — the same bound DSH's own title fallback uses. */
const FALLBACK_TITLE_WORDS = 5;
/** Byte cap for a derived title — the same bound DSH's own title fallback uses. */
const FALLBACK_TITLE_BYTES = 40;

/** Terminal/OSC escape payloads, stripped before a title is ever displayed. */
const OSC_SEQUENCE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/gu;
/** CSI sequences, likewise. */
const CSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/gu;
/** Bare escape sequences, likewise. */
const ESC_SEQUENCE = /\u001B[@-Z\\-_]/gu;
/** Control characters: invisible, and able to move a terminal's cursor. */
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/gu;
/** Zero-width and directional marks, which make a displayed title deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;

/**
 * Shape one raw first-prompt text into a display title.
 *
 * DSH's own deterministic title fallback (`dsh-session-title`) bounds a title
 * to five words and 40 UTF-8 bytes; matching it keeps a derived title
 * indistinguishable from one the harness generated — including its
 * sanitisation, which is not decoration: a session's first prompt is
 * untrusted text, and an escape sequence or a directional mark left in it can
 * retitle a terminal or make the row read as something it is not.
 *
 * @param text - the raw message text.
 * @returns the bounded title, or `undefined` when nothing displayable remains.
 */
export function fallbackTitle(text) {
  if (typeof text !== 'string') return undefined;
  const clean = text
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (clean.length === 0) return undefined;
  const words = clean.split(' ').filter(Boolean).slice(0, FALLBACK_TITLE_WORDS).join(' ');
  if (Buffer.byteLength(words, 'utf8') <= FALLBACK_TITLE_BYTES) return words;
  // Truncate by code point, never by byte index: cutting a multi-byte sequence
  // in half ends the title in U+FFFD.
  let used = 0;
  let output = '';
  for (const character of words) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > FALLBACK_TITLE_BYTES) break;
    output += character;
    used += bytes;
  }
  return output.trimEnd();
}

/**
 * The first human message in one event slice, as a title.
 *
 * Mirrors `sessionTitleUserMessageOf` in `@deepseek-ai/dsh-session-title`: a
 * `user/message` event whose source is the human, carrying text blocks. The
 * `kind === 'user'` test is what separates a real prompt from the injected
 * context that shares the event type — a runtime-context notice or a file
 * change is `kind: 'plugin'` and must never become a session's title.
 *
 * @param events - the event slice to scan.
 * @param limit - how many leading events to consider.
 * @returns the derived title, or `undefined`.
 */
export function firstPromptTitle(events, limit = TITLE_SCAN_EVENTS) {
  const total = Math.min(Array.isArray(events) ? events.length : 0, limit);
  for (let index = 0; index < total; index += 1) {
    const event = events[index];
    if (event === null || event === undefined || event.type !== 'user/message') continue;
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;
    if (data.source?.kind !== 'user' || !Array.isArray(data.content)) continue;
    let text = '';
    for (const block of data.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        text += text.length === 0 ? block.text : `\n${block.text}`;
      }
    }
    const title = fallbackTitle(text);
    if (title !== undefined) return title;
  }
  return undefined;
}

/**
 * Read one stored session's first human message as a title.
 *
 * A read handle is a real resource, so this opens one session at a time and
 * always closes it; a log that cannot be opened or read (an old artifact a
 * migration refuses) is a miss, never an error — the export path reports that
 * separately, and a listing must not fail over a title.
 *
 * @param ctx - the plugin context.
 * @param id - the stored session id.
 * @returns the derived title, or `undefined`.
 */
async function promptTitleFromLog(ctx, id) {
  const persistence = readService(ctx, 'sessionPersistence');
  if (persistence === undefined || typeof persistence.open !== 'function') return undefined;
  let handle;
  try {
    handle = await persistence.open(id, 'read');
  } catch {
    return undefined;
  }
  try {
    const read = await handle.read(0, TITLE_SCAN_EVENTS);
    const events = read?.events;
    return {
      title: firstPromptTitle(events),
      // Whether any conversation was ever recorded. A session can hold events
      // and still have no conversation at all — creating one writes its
      // permission preset, sandbox mode, approval policy and end-seed marker,
      // which is four events and zero messages. Those are exactly the sessions
      // no title can be derived for, so the distinction is worth carrying to
      // the panel instead of leaving the row looking damaged.
      conversation: Array.isArray(events) && events.some(isConversationEvent),
    };
  } catch {
    return undefined;
  } finally {
    try {
      await handle.close();
    } catch {
      // A handle that will not close is not worth failing a title read.
    }
  }
}

/**
 * Whether one event is part of the conversation proper.
 *
 * The harness names these `<subject>/<action>` — `user/message`,
 * `assistant/message`, `tool/call`, `turn/end` — while the events that merely
 * record a session's own setup are `permission/preset`, `sandbox/mode`,
 * `approval/policy` and `session/end-seed`. So the test is on the *subject*,
 * not on a `message/` prefix: getting that backwards would classify every real
 * conversation as unused.
 *
 * @param event - one session event.
 * @returns `true` when the event carries a turn.
 */
function isConversationEvent(event) {
  const type = typeof event?.type === 'string' ? event.type : '';
  const slash = type.indexOf('/');
  if (slash <= 0) return false;
  const subject = type.slice(0, slash);
  return subject === 'user'
    || subject === 'assistant'
    || subject === 'tool'
    || subject === 'turn'
    || subject === 'steering'
    || subject === 'compaction';
}

/* ------------------------------------------------------------- session paths */

/** Code units DSH keeps literal inside one encoded path segment. */
const SEGMENT_SAFE = /^[A-Za-z0-9._-]$/;

/**
 * The absolute root of the session artifact tree.
 * @returns `<DSH_HOME>/sessions`.
 */
export function sessionsRoot() {
  return dshHomePath('sessions');
}

/**
 * Reproduce DSH's project directory name for one working directory.
 *
 * Mirrors `projectKey` in `@deepseek-ai/dsh-session-persistence-jsonl`: runs of
 * separators (and a drive colon) collapse to a single `-`, safe code units stay
 * literal, everything else becomes `~XXXX`, and the result is wrapped in `--`
 * and bounded for filesystem component limits.
 *
 * @param cwd - the session's project directory.
 * @returns the single directory component, or `undefined` for an empty path.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  let readable = '';
  let separatorRun = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (char !== '~' && SEGMENT_SAFE.test(char)) {
      readable += char;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/**
 * Reproduce DSH's encoding of a session id into one path segment.
 *
 * Mirrors `encodeSegment` in the same package. A `SessionId` is an unvalidated
 * branded string, so this is what neutralizes `../`, separators, and NUL before
 * the id ever reaches a filesystem call — which is precisely why a deletion
 * path must derive the name through this function rather than trusting the id.
 *
 * @param id - the raw session id.
 * @returns the encodable path segment, or `undefined` when the id is empty.
 */
export function encodeSessionSegment(id) {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  if (id === '.') return '~002E';
  if (id === '..') return '~002E~002E';
  let out = '';
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index);
    const char = String.fromCharCode(code);
    if (char !== '~' && SEGMENT_SAFE.test(char)) out += char;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * The artifact directory owned by one session.
 * @param header - `{ id, cwd }` for the session.
 * @returns the absolute directory, or `undefined` when a component cannot be encoded.
 */
export function sessionDirectoryOf(header) {
  const segment = encodeSessionSegment(header?.id);
  if (segment === undefined) return undefined;
  const key = header.cwd === undefined ? '_no-cwd' : projectKey(header.cwd);
  if (key === undefined) return undefined;
  return join(sessionsRoot(), key, segment);
}

/**
 * Whether a path is strictly below a root.
 * @param root - the resolved root directory.
 * @param target - the resolved candidate path.
 * @returns `true` only when `target` is a descendant of `root`.
 */
function isInside(root, target) {
  return target !== root && target.startsWith(root + sep);
}

/**
 * The durable workspace account, read from the storage domain file.
 *
 * The registry's `Workspace.sessionIds` is its *validated* view: a session whose
 * header it cannot read is filtered out while the durable account still lists
 * it. Deletion is irreversible, so it is bounded by the union of both views —
 * which means reading the domain file, the one piece of workspace state the
 * service does not expose directly.
 *
 * A missing or unreadable file is not fatal: the registry's view alone is still
 * DSH's own answer about membership, and it is the stricter of the two.
 *
 * `owners` is the same account as membership, kept with the workspace it came
 * from. The registry's `sessionIds` is filtered against a canonical-cwd index
 * it builds while starting, so a listing that runs before that index exists
 * sees *no* workspace at all and reports every session as unmounted; the
 * ledger has no such warm-up, so it is what labels a session whose registry
 * view is momentarily (or permanently) empty.
 *
 * @returns `{ sessions, archived, owners, readable }` — the first two `Set`s of
 *   session ids, `owners` a map from session id to `{ id, path, title }`.
 */
async function durableWorkspaceAccount() {
  const empty = { sessions: new Set(), archived: new Set(), owners: new Map(), readable: false };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(dshHomePath('storages', 'workspace.json'), 'utf8'));
  } catch {
    return empty;
  }
  const sessions = new Set();
  const archived = new Set();
  const owners = new Map();
  const workspaces = parsed?.tables?.workspaces;
  if (workspaces !== null && typeof workspaces === 'object') {
    for (const [workspaceId, record] of Object.entries(workspaces)) {
      const owner = { id: String(workspaceId), path: record?.path, title: record?.title };
      for (const id of record?.sessionIds ?? []) {
        if (typeof id !== 'string') continue;
        sessions.add(id);
        if (!owners.has(id)) owners.set(id, owner);
      }
    }
  }
  for (const id of parsed?.global?.archivedSessionIds ?? []) {
    if (typeof id === 'string') archived.add(id);
  }
  return { sessions, archived, owners, readable: true };
}

/**
 * Read the title out of one projection-cache view.
 *
 * `cachedSnapshot` returns `{ asOfSeq, values }`, and `values.title` is
 * *already* the projected value — a string, or `null`. Reading
 * `rows.title.val` (what this plugin did at first) is therefore always
 * `undefined`, and every session displayed as untitled. The row shape is still
 * accepted: a replacement cache service may expose rows, and a title is
 * presentation, so the more permissive read costs nothing.
 *
 * @param snapshot - the view a cache read returned.
 * @returns the title, or `undefined`.
 */
function projectionTitle(snapshot) {
  const value = snapshot?.values?.title ?? snapshot?.rows?.title?.val;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Best-effort display title for one stored session.
 *
 * The projection cache is the only cheap source, and it validates its records
 * against the session's exact log identity — which also means it holds nothing
 * for a session this process never projected. A title is presentation only, so
 * every failure here degrades to `undefined` instead of failing a listing.
 *
 * @param ctx - the plugin context.
 * @param header - the stored session header.
 * @param inheritedEventCount - exact fork-inherited prefix length.
 * @returns the cached title, or `undefined`.
 */
function cachedTitle(ctx, header, inheritedEventCount) {
  const cache = readService(ctx, 'sessionProjectionCache');
  if (cache === undefined) return undefined;
  for (const read of ['cachedSnapshot', 'cachedPredecessorTitle']) {
    if (typeof cache[read] !== 'function') continue;
    try {
      const keys = read === 'cachedSnapshot' ? ['title'] : undefined;
      const snapshot = keys === undefined
        ? cache[read](header, inheritedEventCount)
        : cache[read](header, inheritedEventCount, keys);
      const value = projectionTitle(snapshot);
      if (value !== undefined) return value;
    } catch {
      // A cache that refuses this lifecyle is a miss, not an error.
    }
  }
  return undefined;
}

/**
 * Give untitled sessions a title read from their own log.
 *
 * A listing is a metadata read and this is not: it opens each log, so it is
 * bounded twice — a budget on how many sessions one listing scans, and a
 * concurrency limit on how many logs are open at once. Newest first, because
 * that is the end of the list a user reads; the remainder stays untitled
 * rather than making the panel wait on hundreds of decodes.
 *
 * @param ctx - the plugin context.
 * @param sessions - the descriptors, already in display order.
 */
async function fillFallbackTitles(ctx, sessions) {
  const queue = sessions.filter((session) => session.title === null).slice(0, TITLE_SCAN_BUDGET);
  if (queue.length === 0) return;
  let cursor = 0;

  /** Drain the queue until it is empty. */
  async function worker() {
    while (cursor < queue.length) {
      const index = cursor;
      cursor += 1;
      const session = queue[index];
      const found = await promptTitleFromLog(ctx, session.id);
      if (found === undefined) continue;
      // Emptiness is recorded even when no title was derived from it: an empty
      // session is exactly the case that has no title to find.
      // Recorded even when no title came of it: "has no conversation" is
      // precisely the case that cannot yield a title, and it is the answer the
      // panel needs instead of a bare "untitled".
      if (found.conversation === false) session.conversation = false;
      if (found.title === undefined) continue;
      session.title = found.title;
      session.titleSource = 'first-prompt';
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(TITLE_SCAN_CONCURRENCY, queue.length) }, () => worker()),
  );
}

/**
 * Every workspace keyed by the session ids it accounts for.
 * @param ctx - the plugin context.
 * @returns a map from session id to `{ id, path, title }`.
 */
function workspaceIndex(ctx) {
  const index = new Map();
  const registry = readService(ctx, 'workspaceRegistry');
  if (registry === undefined) return index;
  let workspaces;
  try {
    workspaces = registry.list();
  } catch {
    return index;
  }
  for (const workspace of workspaces ?? []) {
    let ids;
    try {
      ids = workspace.sessionIds;
    } catch {
      continue;
    }
    for (const id of ids ?? []) {
      if (!index.has(id)) {
        index.set(id, { id: String(workspace.id), path: workspace.path, title: workspace.title });
      }
    }
  }
  return index;
}

/**
 * Which workspace owns each session, across both views.
 *
 * The registry's view is validated but warm-up dependent (its `sessionIds` is
 * filtered against a canonical-cwd index built while starting, so a listing
 * that runs before that index exists sees *no* workspace at all); the durable
 * account is unvalidated but always warm. The union is what "some workspace
 * accounts for this session" means here, with the registry's answer winning
 * when it has one.
 *
 * @param ctx - the plugin context.
 * @returns `{ registry, owners, durable }` — the first two maps from session id
 *   to `{ id, path, title }`, the last the durable account itself.
 */
async function workspaceOwners(ctx) {
  const registry = workspaceIndex(ctx);
  const durable = await durableWorkspaceAccount();
  const owners = new Map(registry);
  for (const [id, owner] of durable.owners) {
    if (!owners.has(id)) owners.set(id, owner);
  }
  return { registry, owners, durable };
}

/**
 * Describe every stored session in this deployment.
 *
 * Reads metadata only: `sessionPersistence.list()` plus the workspace registry,
 * the durable workspace account, and the projection cache. No event log is
 * opened, so this stays cheap enough for the browser half to call on every
 * panel open.
 *
 * Each descriptor carries `mounted` (some workspace accounts for it) and
 * `orphaned` (nothing does, and it is not archived) — the predicate the delete
 * path is fenced on. `workspace` names the owning workspace when either view
 * accounts for the session, and `workspaceClaim` says which one did:
 * `'registry'` for the service's validated view, `'ledger'` for the durable
 * account alone.
 *
 * Titles come from the projection cache, falling back to the session's own
 * first human message; `titleSource` records which (`'cache'`,
 * `'first-prompt'`, or `null` for neither).
 *
 * @param ctx - the plugin context.
 * @returns session descriptors, newest first.
 */
export async function listSessions(ctx) {
  const persistence = readService(ctx, 'sessionPersistence');
  if (persistence === undefined) throw new EngineServiceError('sessionPersistence');
  const registry = readService(ctx, 'workspaceRegistry');
  let archivedByRegistry = new Set();
  try {
    archivedByRegistry = new Set(registry?.archivedSessionIds ?? []);
  } catch {
    archivedByRegistry = new Set();
  }
  const { registry: registryView, owners, durable } = await workspaceOwners(ctx);
  const archived = new Set([...archivedByRegistry, ...durable.archived]);
  const snapshots = await persistence.list();
  const sessions = [];
  for (const snapshot of snapshots ?? []) {
    const header = snapshot.header;
    const id = String(header.id);
    let inheritedEventCount = 0;
    if (header.isSeeded === true) {
      // The exact cut lives in the log, which a listing must not read. Zero is
      // wrong for a seeded session but harmless: the cache read is
      // identity-checked and simply misses, costing the title and nothing else.
      inheritedEventCount = 0;
    }
    const claim = owners.get(id) ?? null;
    const mounted = claim !== null;
    const isArchived = archived.has(id);
    // The registry's claim wins when it has one: it is the view DSH itself
    // validated against the session's real artifact. The ledger only labels a
    // session the registry cannot see, which is exactly the case where the
    // registry's warm-up index has not caught up.
    const cached = cachedTitle(ctx, header, inheritedEventCount);
    sessions.push({
      id,
      createdAt: header.createdAt,
      cwd: header.cwd ?? null,
      title: cached ?? null,
      titleSource: cached === undefined ? null : 'cache',
      isSeeded: header.isSeeded === true,
      parentSession: header.parentSession === undefined ? null : String(header.parentSession),
      origin: header.origin ?? null,
      delegationDepth: header.delegationDepth ?? 0,
      agentPreset: header.agentPreset ?? null,
      // `sessionPersistence.list()` reports `sizeBytes` but no event count, and
      // counting events means decompressing the whole log — which a listing of
      // every stored session must not do. The count is therefore null here and
      // only ever real where the log is already open (export, archive inspect),
      // and the UI omits the column rather than showing a wrong number.
      eventCount: Number.isSafeInteger(snapshot.eventCount) ? snapshot.eventCount : null,
      sizeBytes: Number.isSafeInteger(snapshot.sizeBytes) ? snapshot.sizeBytes : null,
      // Set only by the fallback pass, and only when it saw a log with no turn
      // in it. `null` means "not established", never "has content": the panel
      // must not read an unknown as a fact.
      conversation: null,
      archived: isArchived,
      workspace: claim,
      workspaceClaim: claim === null ? null : (registryView.has(id) ? 'registry' : 'ledger'),
      mounted,
      orphaned: !mounted && !isArchived,
    });
  }
  sessions.sort((left, right) => (right.createdAt ?? 0) - (left.createdAt ?? 0));
  await fillFallbackTitles(ctx, sessions);
  return sessions;
}

/**
 * Resolve one session id to its descriptor, or `undefined` when unknown.
 * @param ctx - the plugin context.
 * @param id - the session id.
 * @returns the descriptor.
 */
export async function describeSession(ctx, id) {
  const sessions = await listSessions(ctx);
  return sessions.find((session) => session.id === id);
}

/**
 * Stream one stored session's metadata and complete event log.
 * @param ctx - the plugin context.
 * @param id - the stored session id.
 * @param workspaces - the pre-computed workspace index (optional).
 * @returns `{ meta, events }` for the archive writer.
 */
async function readSessionForExport(ctx, id, workspaces) {
  const persistence = readService(ctx, 'sessionPersistence');
  const handle = await persistence.open(id, 'read');
  try {
    const header = handle.header;
    const inheritedEventCount = Number(handle.inheritedEventCount ?? 0);
    const read = await handle.read();
    const workspace = workspaces?.get(String(header.id)) ?? null;
    return {
      meta: {
        id: String(header.id),
        header: serialiseHeader(header, inheritedEventCount),
        inheritedEventCount,
        eventCount: read.events.length,
        // The whole log is already open and read here, so the second title rung
        // is free — and an archive that carries no title re-imports as untitled
        // on the next machine, which is where a title matters most.
        title: cachedTitle(ctx, header, inheritedEventCount) ?? firstPromptTitle(read.events) ?? null,
        workspace,
      },
      events: read.events,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Project a live `SessionHeader` onto the plain JSON the archive stores.
 *
 * The header is a frozen live value from the persistence service. Copying its
 * scalar fields explicitly keeps the archive schema stable and never leaks a
 * reference into the written record.
 *
 * @param header - the live stored header.
 * @param inheritedEventCount - exact fork-inherited prefix length.
 * @returns a detached, JSON-serialisable header record.
 */
function serialiseHeader(header, inheritedEventCount) {
  const out = {
    version: header.version,
    id: String(header.id),
    createdAt: header.createdAt,
    isSeeded: header.isSeeded === true,
  };
  if (header.cwd !== undefined) out.cwd = header.cwd;
  if (header.parentSession !== undefined) out.parentSession = String(header.parentSession);
  if (header.origin !== undefined) out.origin = header.origin;
  if (header.delegationDepth !== undefined) out.delegationDepth = header.delegationDepth;
  if (header.agentPreset !== undefined) out.agentPreset = header.agentPreset;
  if (out.isSeeded) out.inheritedEventCount = inheritedEventCount;
  return out;
}

/**
 * Export sessions to one archive file.
 *
 * @param ctx - the plugin context.
 * @param options - export request.
 * @param options.ids - session ids to export; an empty list exports everything.
 * @param options.destPath - archive file to create.
 * @param options.source - free-form provenance stamped into the header.
 * @param options.generator - `{ name, version }` of the writing plugin.
 * @returns `{ destPath, sessionCount, eventCount, bytes, ids }`.
 * @throws when no session matches, or any named id is unknown.
 */
export async function exportSessions(ctx, options) {
  const persistence = readService(ctx, 'sessionPersistence');
  if (persistence === undefined) throw new EngineServiceError('sessionPersistence');

  const wanted = Array.isArray(options.ids) ? options.ids.filter((id) => typeof id === 'string' && id.length > 0) : [];
  const available = await persistence.list();
  const known = new Map((available ?? []).map((snapshot) => [String(snapshot.header.id), snapshot.header]));

  if (wanted.length > 0) {
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length > 0) {
      throw new Error(`unknown session id: ${missing.join(', ')}`);
    }
  }
  const ids = wanted.length > 0 ? wanted : [...known.keys()];
  if (ids.length === 0) throw new Error('there are no stored sessions to export');

  const { owners: workspaces } = await workspaceOwners(ctx);
  const failures = [];
  const exported = [];

  async function* sessions() {
    for (const id of ids) {
      // Opened one at a time and closed before the next: a read handle is a
      // real resource, and holding every session open at once would scale with
      // the size of the export rather than with one session.
      let entry;
      try {
        entry = await readSessionForExport(ctx, id, workspaces);
      } catch (error) {
        // One unreadable session must not cost the user the other five. A real
        // case: an old v0 artifact whose subagent descriptor the v0->v1
        // migration refuses, which makes `open` throw even though `list`
        // reports the session happily. Record it and keep exporting.
        failures.push({ id, reason: describeError(error) });
        continue;
      }
      exported.push(id);
      yield entry;
    }
  }

  const stats = await writeArchive(
    options.destPath,
    {
      generator: options.generator ?? { name: 'dsh-session-vault', version: '0.0.0' },
      source: options.source ?? {},
      sessionCount: ids.length,
    },
    sessions(),
  );

  if (stats.sessionCount === 0) {
    // Nothing was written but the file exists; leaving an empty archive behind
    // would look like a successful export of zero sessions.
    await rm(options.destPath, { force: true });
    const detail = failures.map((failure) => `${failure.id}: ${failure.reason}`).join('; ');
    throw new Error(
      detail.length > 0
        ? `none of the ${ids.length} selected session(s) could be read — ${detail}`
        : 'no sessions were exported',
    );
  }

  return { destPath: options.destPath, ids: exported, failed: failures, ...stats };
}

/**
 * Render one thrown value as a single-line reason.
 * @param error - the caught value.
 * @returns a message safe to put in a JSON envelope.
 */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 400);
}

/**
 * Import sessions from one archive file.
 *
 * Sessions are applied one archive entry at a time, so a large archive never
 * has to be resident twice. A failure on one session is recorded and the rest
 * still import: a partially recoverable archive should recover what it can.
 *
 * @param ctx - the plugin context.
 * @param options - import request.
 * @param options.srcPath - archive file to read.
 * @param options.workspacePath - workspace directory to import into; defaults to each session's recorded cwd.
 * @param options.mode - id collision policy: `skip` (default) or `rename`.
 * @param options.createMissingDirectory - create a missing target directory (default `true`).
 * @param options.dryRun - plan the import without writing anything.
 * @param options.signal - optional cancellation.
 * @returns `{ imported, skipped, failed, header }` describing what happened.
 */
export async function importSessions(ctx, options) {
  const persistence = readService(ctx, 'sessionPersistence');
  if (persistence === undefined) throw new EngineServiceError('sessionPersistence');
  const registry = readService(ctx, 'workspaceRegistry');
  const mode = options.mode === 'rename' ? 'rename' : 'skip';
  const createMissingDirectory = options.createMissingDirectory !== false;
  const dryRun = options.dryRun === true;

  const imported = [];
  const skipped = [];
  const failed = [];
  let plan;
  let current;

  /**
   * Apply one buffered session. Runs once per archive `session-end` record.
   * @param entry - the buffered session: meta plus its complete event list.
   */
  async function applySession(entry) {
    if (typeof entry.meta.id !== 'string' || entry.meta.id.length === 0) {
      failed.push({ id: String(entry.meta.id), reason: 'archive session record declares no id' });
      return;
    }
    if (entry.meta.header === null || typeof entry.meta.header !== 'object') {
      failed.push({ id: entry.meta.id, reason: 'archive session record declares no header' });
      return;
    }
    const requestedId = entry.meta.id;
    const sourceCwd = entry.meta.header.cwd;
    const targetCwd = typeof options.workspacePath === 'string' && options.workspacePath.length > 0
      ? options.workspacePath
      : sourceCwd;

    const existing = await persistence.stat(requestedId);
    let targetId = requestedId;
    if (existing !== undefined) {
      if (mode === 'skip') {
        skipped.push({ id: requestedId, reason: 'already-present', title: entry.meta.title ?? null });
        return;
      }
      // `rename` keeps both copies. The id is the only thing that has to move:
      // events carry no session id of their own, so a fresh id plus the
      // original log is a complete, valid session.
      do {
        targetId = `session-${randomUUID()}`;
      } while ((await persistence.stat(targetId)) !== undefined);
    }

    if (targetCwd !== undefined && createMissingDirectory) {
      try {
        await mkdir(targetCwd, { recursive: true });
      } catch (error) {
        failed.push({
          id: requestedId,
          reason: `could not create workspace directory ${targetCwd}: ${error instanceof Error ? error.message : String(error)}`,
        });
        return;
      }
    }

    if (dryRun) {
      imported.push({
        sourceId: requestedId,
        id: targetId,
        cwd: targetCwd ?? null,
        eventCount: entry.events.length,
        title: entry.meta.title ?? null,
        workspaceAttached: false,
        dryRun: true,
      });
      return;
    }

    const header = { ...entry.meta.header, id: targetId };
    if (targetCwd === undefined) delete header.cwd;
    else header.cwd = targetCwd;

    const createOptions = {};
    // A seeded header must carry its exact inherited cut, or the backend
    // refuses the create; an unseeded one must not carry one at all.
    if (header.isSeeded === true) createOptions.inheritedEventCount = entry.meta.inheritedEventCount ?? 0;
    if (options.signal !== undefined) createOptions.signal = options.signal;

    const handle = await persistence.create(
      header,
      Object.keys(createOptions).length > 0 ? createOptions : undefined,
    );
    try {
      // One append keeps seq contiguity trivially true, and seq 0 is exactly
      // the next-seq of a freshly created session.
      if (entry.events.length > 0) {
        await handle.append(entry.events, options.signal === undefined ? undefined : { signal: options.signal });
      }
      await handle.flush();
    } finally {
      await handle.close();
    }

    let workspaceAttached = false;
    let workspaceError;
    if (registry !== undefined && targetCwd !== undefined) {
      try {
        const workspace = await registry.create(targetCwd);
        await workspace.attachSession(targetId);
        workspaceAttached = true;
      } catch (error) {
        // The session itself is safely stored; only its sidebar placement
        // failed. Reporting it beats rolling back a successful import.
        workspaceError = error instanceof Error ? error.message : String(error);
      }
    }

    imported.push({
      sourceId: requestedId,
      id: targetId,
      cwd: targetCwd ?? null,
      eventCount: entry.events.length,
      title: entry.meta.title ?? null,
      workspaceAttached,
      renamed: targetId !== requestedId,
      ...(workspaceError === undefined ? {} : { workspaceError }),
    });
  }

  const read = await readArchive(options.srcPath, {
    onHeader(header) {
      plan = header;
    },
    onSession(meta) {
      current = { meta, events: [] };
    },
    onEvent(record) {
      current.events.push(record.event);
    },
    async onSessionEnd() {
      const entry = current;
      current = undefined;
      try {
        await applySession(entry);
      } catch (error) {
        failed.push({
          id: String(entry.meta.id),
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  return { header: plan, archive: read, imported, skipped, failed, dryRun };
}

/**
 * Delete stored sessions from storage.
 *
 * This is the one place the plugin writes below `<DSH_HOME>/sessions`, and it
 * only ever removes. `SessionPersistence` has no delete, so there is no service
 * to delegate to; the fences below are what make doing it here safe:
 *
 *  - an unmounted session qualifies — no workspace accounts for it, in either
 *    the registry's validated view or the durable account;
 *  - an archived one is refused *unless* the caller passes `includeArchived`,
 *    because archiving is a deliberate "keep, but hide" and the archive may be
 *    the only copy left;
 *  - a *mounted* session is refused, with one exception: `includeEmpty` admits
 *    a session the log proved holds no conversation at all. Being mounted is
 *    exactly what makes this the widest reach the function has, so it is gated
 *    on a positive finding — `conversation === false` is only ever set by
 *    reading the log — and never on a missing one;
 *  - a live session is refused: deleting a log out from under an open write
 *    handle corrupts rather than reclaims;
 *  - the directory is re-derived from the id through DSH's own segment encoder
 *    and then proved to be strictly inside the sessions root, so no crafted id
 *    can aim the recursive remove anywhere else;
 *  - a non-dry-run call must pass `confirm: true`, so a caller cannot delete by
 *    forgetting a flag.
 *
 * `survivors` is measured, not assumed: the session list is read again after
 * the files are gone, and any id still present means a running process is
 * serving it from an in-memory index and a restart is what clears it.
 *
 * @param ctx - the plugin context.
 * @param options - `{ ids, dryRun, confirm, includeArchived, includeEmpty }`.
 * @returns `{ dryRun, deleted, refused, failed, reclaimedBytes, survivors }`.
 */
export async function purgeSessions(ctx, options) {
  const persistence = readService(ctx, 'sessionPersistence');
  if (persistence === undefined) throw new EngineServiceError('sessionPersistence');
  const dryRun = options.dryRun === true;
  // Archived-but-unmounted sessions are listed only on request, and they are
  // deletable only on the same request: an archive exists so the session can be
  // restored, and silently making it deletable would undo that.
  const includeArchived = options.includeArchived === true;
  // Never-used sessions are usually *mounted*, so admitting them is a wider
  // reach than an orphan and needs its own explicit opt-in. It is still narrow:
  // the engine only ever sets `conversation === false` from reading the log, so
  // a session whose contents were not established can never qualify.
  const includeEmpty = options.includeEmpty === true;
  if (!dryRun && options.confirm !== true) {
    throw new Error('deleting sessions requires confirm: true');
  }

  const requested = Array.isArray(options.ids) ? options.ids : [];
  const ids = [...new Set(requested.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) throw new Error('no session ids were given');

  const known = new Map((await listSessions(ctx)).map((session) => [session.id, session]));
  const store = readService(ctx, 'sessions');
  const root = resolve(sessionsRoot());
  const deleted = [];
  const refused = [];
  const failed = [];
  let reclaimedBytes = 0;

  for (const id of ids) {
    const session = known.get(id);
    if (session === undefined) {
      refused.push({ id, reason: 'unknown-session' });
      continue;
    }
    // Two admissible kinds, and the second is narrower than the first:
    //
    //  - unmounted (an orphaned log), optionally including archived ones when
    //    the caller opted in;
    //  - a never-used session, which is normally *mounted* and so reaches here
    //    only because the log was read and found to hold no turn at all. That
    //    is a positive finding about the content, not an absence of one, which
    //    is why it can be admitted where a plain mounted session cannot.
    const deletable = session.mounted
      ? (includeEmpty && session.conversation === false)
      : (includeArchived || !session.archived);
    if (!deletable) {
      refused.push({
        id,
        reason: session.mounted
          ? (session.conversation === false ? 'never-used-needs-opt-in' : 'attached-to-a-workspace')
          : 'archived-session',
      });
      continue;
    }

    let live = false;
    try {
      live = store !== undefined && typeof store.get === 'function' && store.get(id) !== undefined;
    } catch {
      // A store that cannot answer must not be read as "not live": refusing is
      // the only safe default when an open log cannot be ruled out.
      live = true;
    }
    if (live) {
      refused.push({ id, reason: 'session-is-live' });
      continue;
    }

    const directory = sessionDirectoryOf({ id, cwd: session.cwd === null ? undefined : session.cwd });
    if (directory === undefined) {
      refused.push({ id, reason: 'unresolvable-artifact-path' });
      continue;
    }
    const target = resolve(directory);
    if (!isInside(root, target)) {
      refused.push({ id, reason: 'artifact-path-escapes-the-sessions-root' });
      continue;
    }

    if (dryRun) {
      deleted.push({ id, directory: target, bytes: session.sizeBytes, planned: true });
      continue;
    }

    try {
      await rm(target, { recursive: true, force: true });
      await removeProjectionEntries(ctx, id);
      const spillRemoved = await removeSpillEntries(ctx, id);
      reclaimedBytes += Number.isSafeInteger(session.sizeBytes) ? session.sizeBytes : 0;
      deleted.push({
        id,
        directory: target,
        bytes: session.sizeBytes,
        ...(spillRemoved ? { spillRemoved: true } : {}),
      });
    } catch (error) {
      failed.push({ id, reason: describeError(error) });
    }
  }

  let survivors = [];
  if (!dryRun) {
    const gone = new Set(deleted.map((entry) => entry.id));
    // Deduplicated: a listing that reports the same id twice must not read as
    // "two sessions still need a restart".
    survivors = [...new Set(
      (await listSessions(ctx))
        .filter((session) => gone.has(session.id))
        .map((session) => session.id),
    )];
  }

  return { dryRun, deleted, refused, failed, reclaimedBytes, survivors };
}

/**
 * Drop one session's projection-cache records.
 *
 * Prefers a real service method when the composed cache offers one (the
 * archive manager's replacement does); otherwise removes the cache files
 * directly. A projection cache is derived state, so a missing or stale entry
 * costs a rebuild and never data.
 *
 * @param ctx - the plugin context.
 * @param id - the deleted session id.
 * @returns how the cleanup was performed: `service`, `files`, or `none`.
 */
async function removeProjectionEntries(ctx, id) {
  const cache = readService(ctx, 'sessionProjectionCache');
  if (cache !== undefined && typeof cache.delete === 'function') {
    try {
      if (typeof cache.whenIdle === 'function') await cache.whenIdle();
      await cache.delete(id);
      return 'service';
    } catch {
      // Fall through to the files: the service refused, which is not fatal.
    }
  }
  const storages = dshHomePath('storages');
  let entries;
  try {
    entries = await readdir(storages, { withFileTypes: true });
  } catch {
    return 'none';
  }
  // The domain directory name is a deployment choice — the archive manager
  // renames it — so every `storages/<domain>/sessions/` is checked rather than
  // one hard-coded path.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await rm(join(storages, entry.name, 'sessions', `${id}.json`), { force: true });
    } catch {
      // Best effort: a cache file that cannot be removed is not worth failing a delete.
    }
  }
  return 'files';
}

/**
 * Drop one session's spilled tool output, when a spill root is reachable.
 *
 * `dsh-spill-local` stores under `<root>/session-<sha256(id)[0:12]>/`, and it
 * has its own age-based sweep, so this is belt-and-braces rather than the only
 * reclaim. It is best-effort and never fails a delete.
 *
 * @param ctx - the plugin context.
 * @param id - the deleted session id.
 * @returns `true` when a spill directory was removed.
 */
async function removeSpillEntries(ctx, id) {
  const spill = readService(ctx, 'spill');
  const configured = spill?.root;
  if (typeof configured !== 'string' || configured.length === 0) return false;
  const root = resolve(configured);
  const name = `session-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`;
  const target = resolve(join(root, name));
  if (!isInside(root, target)) return false;
  try {
    await rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Summarise the sessions that can be cleaned up.
 *
 * Three questions, deliberately kept apart, because the panel has to answer all
 * of them without conflating them:
 *
 *  - *Unmounted*: no workspace accounts for it. These are the orphaned logs a
 *    deleted workspace leaves behind, and they are what the export tab means by
 *    "no workspace".
 *  - *Archived*: still unmounted, but the archive may be its only copy, so it is
 *    deletable only when the caller asks for it (`includeArchived`).
 *  - *Never used*: a session that was created and abandoned. It holds only the
 *    events creation writes — permission preset, sandbox mode, approval policy,
 *    end-seed — and not one message. Unlike an orphan it *is* attached to a
 *    workspace, so it must not be counted as unmounted or the export tab's
 *    "no workspace" total would stop reconciling; it is its own bucket, reached
 *    with `includeEmpty`.
 *
 * The counts are always the unfiltered truth, never the filtered one: a panel
 * showing "nothing to clean" while sessions are sitting there unmounted is the
 * exact confusion this shape exists to prevent.
 *
 * @param ctx - the plugin context.
 * @param options - `includeArchived` and `includeEmpty` (both default `false`)
 *   admit those buckets into the returned `sessions`.
 * @returns `{ sessions, reclaimableBytes, unmountedCount, archivedCount,
 *   emptyCount, includeArchived, includeEmpty }`.
 */
export async function listOrphanSessions(ctx, options = {}) {
  const includeArchived = options.includeArchived === true;
  const includeEmpty = options.includeEmpty === true;
  const stored = await listSessions(ctx);
  const unmounted = stored.filter((session) => !session.mounted);
  // A never-used session is normally mounted, so it is *not* part of the
  // unmounted population; an unmounted one that was also never used is already
  // covered by the orphan rules and is not double-counted here.
  const empty = stored.filter((session) => session.conversation === false && session.mounted);

  const selected = new Set();
  for (const session of unmounted) {
    if (session.archived && !includeArchived) continue;
    selected.add(session.id);
  }
  if (includeEmpty) for (const session of empty) selected.add(session.id);

  const sessions = stored.filter((session) => selected.has(session.id));
  const bytes = (rows) => rows.reduce(
    (total, session) => total + (Number.isSafeInteger(session.sizeBytes) ? session.sizeBytes : 0),
    0,
  );
  return {
    sessions,
    reclaimableBytes: bytes(sessions),
    unmountedCount: unmounted.length,
    archivedCount: unmounted.filter((session) => session.archived).length,
    emptyCount: empty.length,
    includeArchived,
    includeEmpty,
  };
}

/**
 * Read a `.dshsession` archive's header and session index without importing it.
 * @param srcPath - archive file to read.
 * @returns the archive header and one descriptor per archived session.
 */
export async function inspectArchive(srcPath) {
  const sessions = [];
  let current;
  let header;
  const stats = await readArchive(srcPath, {
    onHeader(value) {
      header = value;
    },
    onSession(meta) {
      current = {
        id: String(meta.id),
        createdAt: meta.header?.createdAt ?? null,
        cwd: meta.header?.cwd ?? null,
        title: meta.title ?? null,
        eventCount: meta.eventCount ?? null,
        workspace: meta.workspace ?? null,
        isSeeded: meta.header?.isSeeded === true,
      };
      sessions.push(current);
    },
  });
  return { header, sessions, sessionCount: stats.sessionCount, eventCount: stats.eventCount };
}

/**
 * Whether a path exists and is a regular file.
 * @param path - the path to test.
 * @returns `true` when a regular file is present.
 */
export async function isFile(path) {
  try {
    return (await statFile(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Build a default archive file name for an export.
 * @param count - number of sessions being exported.
 * @returns `<timestamp>-<count>-sessions.dshsession`.
 */
export function suggestArchiveName(count) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  return `${stamp}-${count}-sessions${ARCHIVE_EXTENSION}`;
}
