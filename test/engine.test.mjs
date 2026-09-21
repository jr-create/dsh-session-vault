/**
 * Engine tests.
 *
 * The export/import engine talks to Cordis services, never to the filesystem
 * layout, so that contract is exercisable with an in-memory fake of
 * `sessionPersistence` and `workspaceRegistry`.
 *
 * Deletion is the exception, and it is why `DSH_HOME` is redirected to a
 * temporary directory below: `purgeSessions` is the one operation that removes
 * files under `<DSH_HOME>/sessions` (no service offers it), so these tests must
 * never be able to reach a real harness home. The fakes describe sessions; the
 * redirected home holds the directories they would be deleted from.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ARCHIVE_FORMAT, ArchiveFormatError, loadArchive, readArchive, writeArchive } from '../lib/archive.js';
import {
  encodeSessionSegment,
  exportSessions,
  fallbackTitle,
  firstPromptTitle,
  importSessions,
  inspectArchive,
  isFile,
  listOrphanSessions,
  listSessions,
  projectKey,
  purgeSessions,
  sessionDirectoryOf,
} from '../lib/engine.js';

/**
 * An in-memory stand-in for the host services the engine uses.
 * @param seed - initial sessions as `[id, { header, events }]` pairs.
 * @param options - `archived` session ids for the registry, `workspaces` to
 *   seed the registry's own view, and an optional `liveStore` exposing
 *   `get(id)` for the live-session check.
 * @returns a fake `ctx` plus handles on its internals.
 */
function fakeContext(seed = [], options = {}) {
  const store = new Map(seed);
  const workspaces = [...(options.workspaces ?? [])];

  const persistence = {
    async list() {
      return [...store.values()].map((entry) => ({
        header: entry.header,
        revision: 'rev-1',
        eventCount: entry.events.length,
        // Deliberately distinct from eventCount so a test that means "bytes"
        // cannot pass by accidentally reading the event count.
        sizeBytes: entry.events.length * 100,
      }));
    },
    async stat(id) {
      const entry = store.get(id);
      if (entry === undefined) return undefined;
      return {
        header: entry.header,
        revision: 'rev-1',
        eventCount: entry.events.length,
        sizeBytes: entry.events.length * 100,
      };
    },
    async open(id) {
      const entry = store.get(id);
      if (entry === undefined) throw new Error(`no such session: ${id}`);
      return {
        id,
        header: entry.header,
        inheritedEventCount: entry.header.isSeeded === true ? 0 : 0,
        access: 'read',
        async read() {
          return { eventState: 'detached', events: entry.events };
        },
        async close() {},
      };
    },
    async create(header) {
      if (store.has(header.id)) throw new Error(`session already exists: ${header.id}`);
      const entry = { header, events: [] };
      store.set(header.id, entry);
      return {
        id: header.id,
        header,
        inheritedEventCount: 0,
        access: 'write',
        async read() {
          return { eventState: 'detached', events: entry.events };
        },
        async append(events) {
          entry.events.push(...events);
        },
        async flush() {},
        async close() {},
      };
    },
  };

  const registry = {
    list() {
      return workspaces;
    },
    get archivedSessionIds() {
      return options.archived ?? [];
    },
    async create(path) {
      let workspace = workspaces.find((candidate) => candidate.path === path);
      if (workspace === undefined) {
        const sessionIds = [];
        workspace = {
          id: `ws-${workspaces.length + 1}`,
          path,
          title: path,
          sessionIds,
          async attachSession(id) {
            if (!sessionIds.includes(id)) sessionIds.push(id);
          },
        };
        workspaces.push(workspace);
      }
      return workspace;
    },
  };

  const ctx = {
    get(key) {
      if (key === 'sessionPersistence') return persistence;
      if (key === 'workspaceRegistry') return registry;
      // The live-session store is only present when a test supplies one; the
      // delete path treats an absent store as "cannot prove it is not live".
      if (key === 'sessions') return options.liveStore;
      return undefined;
    },
    effect(fn) {
      return fn();
    },
  };
  return { ctx, store, workspaces };
}

/** One ordinary unseeded session header. */
function header(id, cwd, createdAt = 1_700_000_000_000) {
  return { version: 3, id, createdAt, cwd, isSeeded: false };
}

/** Two plausible session events. */
function events(prefix) {
  return [
    { type: 'message/user', seq: 0, text: `${prefix} hello` },
    { type: 'message/assistant', seq: 1, text: `${prefix} world` },
  ];
}

let workdir;
let originalHome;

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-session-vault-test-'));
  // `home.js` resolves `$DSH_HOME` per call, so redirecting it here keeps every
  // session-directory operation inside this temporary tree.
  originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = workdir;
});

after(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  await rm(workdir, { recursive: true, force: true });
});

/**
 * Create a plausible on-disk artifact directory for one session.
 * @param id - the session id.
 * @param cwd - its recorded working directory.
 * @returns the directory that was created.
 */
async function seedArtifactDirectory(id, cwd) {
  const directory = sessionDirectoryOf({ id, cwd });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'session.v3.jsonl.zstd'), 'not really zstd, just bytes');
  return directory;
}

/**
 * Write the durable workspace account these tests read.
 * @param workspaces - `{ path, sessionIds }` records to account for.
 * @param archived - session ids to mark archived.
 */
async function writeWorkspaceAccount(workspaces = [], archived = []) {
  const tables = { workspaces: {} };
  workspaces.forEach((record, index) => {
    tables.workspaces[`ws-${index + 1}`] = { path: record.path, sessionIds: record.sessionIds };
  });
  const file = join(workdir, 'storages', 'workspace.json');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { archivedSessionIds: archived }, tables }));
}

describe('archive round-trip', () => {
  it('writes and reads back records in order', async () => {
    const path = join(workdir, 'round-trip.dshsession');
    async function* sessions() {
      yield { meta: { id: 'session-a', header: header('session-a', 'D:\\a'), eventCount: 2 }, events: events('a') };
      yield { meta: { id: 'session-b', header: header('session-b', 'D:\\b'), eventCount: 2 }, events: events('b') };
    }
    const written = await writeArchive(path, { generator: { name: 'test', version: '1' } }, sessions());
    assert.equal(written.sessionCount, 2);
    assert.equal(written.eventCount, 4);
    assert.ok(written.bytes > 0);

    const loaded = await loadArchive(path);
    assert.equal(loaded.header.format, ARCHIVE_FORMAT);
    assert.equal(loaded.sessionCount, 2);
    assert.equal(loaded.sessions.length, 2);
    assert.deepEqual(loaded.sessions.map((session) => session.id), ['session-a', 'session-b']);
    assert.equal(loaded.sessions[1].events[1].text, 'b world');
  });

  it('rejects a file that is not an archive', async () => {
    const path = join(workdir, 'not-an-archive.dshsession');
    await writeFile(path, 'this is plainly not gzip');
    await assert.rejects(() => readArchive(path), ArchiveFormatError);
  });

  it('writes the neutral format marker, not the plugin name', async () => {
    // A format identifier is a wire contract that outlives whatever the product
    // is called; renaming the plugin must not change what it writes into files
    // users already hold.
    const path = join(workdir, 'marker.dshsession');
    async function* sessions() {
      yield { meta: { id: 'session-a', header: header('session-a', workdir) }, events: events('a') };
    }
    await writeArchive(path, { generator: { name: 'dsh-session-vault', version: '1' } }, sessions());
    const loaded = await loadArchive(path);
    assert.equal(ARCHIVE_FORMAT, 'dsh-session-archive');
    assert.equal(loaded.header.format, ARCHIVE_FORMAT);
  });

  it("still reads an archive written under the plugin's former name", async () => {
    // The plugin shipped once as `dsh-session-export` and stamped that string
    // into every archive it produced. Those files stay valid.
    const path = join(workdir, 'legacy-marker.dshsession');
    const { createGzip } = await import('node:zlib');
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    const records = [
      {
        type: 'header',
        format: 'dsh-session-export',
        version: 1,
        generatedAt: '2026-01-01T00:00:00.000Z',
        generator: { name: 'dsh-session-export', version: '0.1.0' },
      },
      {
        type: 'session',
        id: 'session-legacy',
        header: header('session-legacy', workdir),
        inheritedEventCount: 0,
        eventCount: 1,
      },
      { type: 'event', id: 'session-legacy', event: { type: 'message/user', seq: 0, text: 'hi' } },
      { type: 'session-end', id: 'session-legacy', eventCount: 1 },
      { type: 'footer', sessionCount: 1, eventCount: 1 },
    ].map((record) => JSON.stringify(record)).join('\n');
    await pipeline(Readable.from([`${records}\n`]), createGzip(), createWriteStream(path));

    const loaded = await loadArchive(path);
    assert.equal(loaded.sessionCount, 1);
    assert.equal(loaded.sessions[0].id, 'session-legacy');
    assert.equal(loaded.header.format, 'dsh-session-export', 'the legacy marker is preserved on read');
  });

  it('rejects a marker it has never written', async () => {
    const path = join(workdir, 'alien-marker.dshsession');
    const { createGzip } = await import('node:zlib');
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    const records = [
      { type: 'header', format: 'some-other-tool', version: 1 },
      { type: 'footer', sessionCount: 0, eventCount: 0 },
    ].map((record) => JSON.stringify(record)).join('\n');
    await pipeline(Readable.from([`${records}\n`]), createGzip(), createWriteStream(path));
    await assert.rejects(() => readArchive(path), /unexpected archive format/);
  });

  it('rejects an archive whose footer contradicts its body', async () => {
    const path = join(workdir, 'bad-footer.dshsession');
    const { createGzip } = await import('node:zlib');
    const { Readable } = await import('node:stream');
    const { pipeline } = await import('node:stream/promises');
    const { createWriteStream } = await import('node:fs');
    const lines = [
      // Use the constant, not a literal: this archive must be rejected for its
      // footer, so its header has to be one the reader actually accepts.
      { type: 'header', format: ARCHIVE_FORMAT, version: 1 },
      { type: 'footer', sessionCount: 7, eventCount: 7 },
    ].map((record) => JSON.stringify(record)).join('\n');
    await pipeline(Readable.from([`${lines}\n`]), createGzip(), createWriteStream(path));
    await assert.rejects(() => readArchive(path), /footer does not match/);
  });
});

describe('export and import', () => {
  it('round-trips a session through an archive', async () => {
    const source = fakeContext([
      ['session-one', { header: header('session-one', workdir), events: events('one') }],
    ]);
    const archivePath = join(workdir, 'export-one.dshsession');
    const exported = await exportSessions(source.ctx, { ids: ['session-one'], destPath: archivePath });
    assert.equal(exported.sessionCount, 1);
    assert.equal(exported.eventCount, 2);

    const target = fakeContext();
    const result = await importSessions(target.ctx, { srcPath: archivePath });
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0].id, 'session-one');
    assert.equal(result.imported[0].eventCount, 2);
    assert.equal(result.imported[0].workspaceAttached, true);
    assert.equal(result.failed.length, 0);

    const stored = target.store.get('session-one');
    assert.equal(stored.events.length, 2);
    assert.equal(stored.events[0].text, 'one hello');
    assert.deepEqual(target.workspaces[0].sessionIds, ['session-one']);
  });

  it('exports every session when no ids are named', async () => {
    const source = fakeContext([
      ['session-a', { header: header('session-a', workdir), events: events('a') }],
      ['session-b', { header: header('session-b', workdir), events: events('b') }],
    ]);
    const archivePath = join(workdir, 'export-all.dshsession');
    const exported = await exportSessions(source.ctx, { destPath: archivePath });
    assert.equal(exported.sessionCount, 2);
    assert.deepEqual(exported.ids.sort(), ['session-a', 'session-b']);
  });

  it('refuses an unknown session id instead of writing a partial archive', async () => {
    const source = fakeContext([['session-a', { header: header('session-a', workdir), events: [] }]]);
    await assert.rejects(
      () => exportSessions(source.ctx, { ids: ['session-missing'], destPath: join(workdir, 'nope.dshsession') }),
      /unknown session id: session-missing/,
    );
  });

  it('skips an id that already exists by default', async () => {
    const source = fakeContext([['session-one', { header: header('session-one', workdir), events: events('one') }]]);
    const archivePath = join(workdir, 'collide.dshsession');
    await exportSessions(source.ctx, { ids: ['session-one'], destPath: archivePath });

    const result = await importSessions(source.ctx, { srcPath: archivePath });
    assert.equal(result.imported.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].reason, 'already-present');
    // The original log is untouched, not merged and not replaced.
    assert.equal(source.store.get('session-one').events.length, 2);
  });

  it('imports under a fresh id when mode is rename', async () => {
    const source = fakeContext([['session-one', { header: header('session-one', workdir), events: events('one') }]]);
    const archivePath = join(workdir, 'rename.dshsession');
    await exportSessions(source.ctx, { ids: ['session-one'], destPath: archivePath });

    const result = await importSessions(source.ctx, { srcPath: archivePath, mode: 'rename' });
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0].sourceId, 'session-one');
    assert.notEqual(result.imported[0].id, 'session-one');
    assert.equal(result.imported[0].renamed, true);
    assert.match(result.imported[0].id, /^session-[0-9a-f-]{36}$/);
    // Both copies now exist, and the original still has its own log.
    assert.equal(source.store.size, 2);
    assert.equal(source.store.get('session-one').events.length, 2);
  });

  it('relocates a session to a new workspace path', async () => {
    const origin = join(workdir, 'origin-workspace');
    const destination = join(workdir, 'moved-workspace', 'nested');
    const source = fakeContext([['session-one', { header: header('session-one', origin), events: events('one') }]]);
    const archivePath = join(workdir, 'relocate.dshsession');
    await exportSessions(source.ctx, { ids: ['session-one'], destPath: archivePath });

    const target = fakeContext();
    const result = await importSessions(target.ctx, { srcPath: archivePath, workspacePath: destination });
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0].cwd, destination);
    // The header was rewritten, and the new directory was created on demand.
    assert.equal(target.store.get('session-one').header.cwd, destination);
    assert.equal(target.workspaces[0].path, destination);
  });

  it('writes nothing at all on a dry run', async () => {
    const source = fakeContext([['session-one', { header: header('session-one', workdir), events: events('one') }]]);
    const archivePath = join(workdir, 'dry.dshsession');
    await exportSessions(source.ctx, { ids: ['session-one'], destPath: archivePath });

    const target = fakeContext();
    const result = await importSessions(target.ctx, { srcPath: archivePath, dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0].dryRun, true);
    assert.equal(target.store.size, 0);
    assert.equal(target.workspaces.length, 0);
  });

  it('reports a session record that carries no header, instead of aborting', async () => {
    // A hand-built archive: the record names an id but no header. Importing it
    // must surface a per-session failure, because a header-less session cannot
    // be re-created and the rest of the archive may still be perfectly good.
    const archivePath = join(workdir, 'headerless.dshsession');
    async function* sessions() {
      yield { meta: { id: 'session-no-header' }, events: [] };
      yield { meta: { id: 'session-good', header: header('session-good', workdir) }, events: events('good') };
    }
    await writeArchive(archivePath, { generator: { name: 'test', version: '1' } }, sessions());

    const target = fakeContext();
    const result = await importSessions(target.ctx, { srcPath: archivePath });
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].id, 'session-no-header');
    assert.match(result.failed[0].reason, /no header/);
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0].id, 'session-good');
  });

  it('exports the readable sessions and reports the ones it cannot read', async () => {
    // A real shape: `list` happily reports a stored session whose log `open`
    // then refuses (an old v0 artifact whose subagent descriptor the v0->v1
    // migration rejects). One such session must not cost the user the others.
    const source = fakeContext([
      ['session-a', { header: header('session-a', workdir, 1000), events: events('a') }],
      ['session-broken', { header: header('session-broken', workdir, 2000), events: events('b') }],
      ['session-c', { header: header('session-c', workdir, 3000), events: events('c') }],
    ]);
    const persistence = source.ctx.get('sessionPersistence');
    const realOpen = persistence.open.bind(persistence);
    persistence.open = async (id, access) => {
      if (id === 'session-broken') {
        throw new Error('message/user 12 uses unsupported descriptor version 2');
      }
      return realOpen(id, access);
    };

    const archivePath = join(workdir, 'partial-export.dshsession');
    const result = await exportSessions(source.ctx, { destPath: archivePath });

    assert.equal(result.sessionCount, 2);
    assert.deepEqual([...result.ids].sort(), ['session-a', 'session-c']);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].id, 'session-broken');
    assert.match(result.failed[0].reason, /unsupported descriptor version 2/);

    // The archive is real, and holds exactly the two readable sessions.
    const loaded = await loadArchive(archivePath);
    assert.deepEqual(loaded.sessions.map((session) => session.id).sort(), ['session-a', 'session-c']);
  });

  it('throws instead of leaving an empty archive when nothing can be read', async () => {
    const source = fakeContext([['session-a', { header: header('session-a', workdir), events: events('a') }]]);
    source.ctx.get('sessionPersistence').open = async () => {
      throw new Error('unreadable');
    };

    const archivePath = join(workdir, 'empty-export.dshsession');
    await assert.rejects(
      () => exportSessions(source.ctx, { destPath: archivePath }),
      /none of the 1 selected session\(s\) could be read/,
    );
    // A header-only archive left on disk would look like a successful export
    // of zero sessions.
    assert.equal(await isFile(archivePath), false);
  });

  it('reports per-session failures without abandoning the rest of the archive', async () => {
    const source = fakeContext([
      ['session-one', { header: header('session-one', workdir), events: events('one') }],
      ['session-two', { header: header('session-two', workdir), events: events('two') }],
    ]);
    const archivePath = join(workdir, 'partial.dshsession');
    await exportSessions(source.ctx, { destPath: archivePath });

    const target = fakeContext();
    const realCreate = target.ctx.get('sessionPersistence').create.bind(target.ctx.get('sessionPersistence'));
    target.ctx.get('sessionPersistence').create = async (h, o) => {
      if (h.id === 'session-one') throw new Error('simulated storage fault');
      return realCreate(h, o);
    };

    const result = await importSessions(target.ctx, { srcPath: archivePath });
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].id, 'session-one');
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0].id, 'session-two');
  });
});

describe('listSessions', () => {
  it('describes stored sessions newest first', async () => {
    const { ctx } = fakeContext([
      ['session-old', { header: header('session-old', workdir, 1000), events: events('old') }],
      ['session-new', { header: header('session-new', workdir, 2000), events: events('new') }],
    ]);
    const sessions = await listSessions(ctx);
    assert.deepEqual(sessions.map((session) => session.id), ['session-new', 'session-old']);
    assert.equal(sessions[0].cwd, workdir);
    assert.equal(sessions[0].eventCount, 2);
    assert.equal(sessions[0].archived, false);
  });

  it('reports workspace membership, which is what decides sidebar visibility', async () => {
    // Stored sessions and sidebar sessions are different sets. A session whose
    // log survives a deleted workspace, or a subagent child, is in persistence
    // but in no workspace — and the sidebar groups by workspace. Reporting the
    // membership is what lets the UI explain the gap instead of looking like it
    // invented sessions.
    const source = fakeContext([
      ['session-attached', { header: header('session-attached', workdir, 2000), events: [] }],
      ['session-orphan', { header: header('session-orphan', workdir, 1000), events: [] }],
    ]);
    const workspace = await source.ctx.get('workspaceRegistry').create(workdir);
    await workspace.attachSession('session-attached');

    const sessions = await listSessions(source.ctx);
    const byId = Object.fromEntries(sessions.map((session) => [session.id, session]));

    assert.equal(byId['session-attached'].workspace.title, workdir);
    assert.equal(byId['session-orphan'].workspace, null);
    assert.equal(sessions.filter((session) => session.workspace !== null).length, 1);
  });

  it('carries the subagent marker that keeps a child out of the sidebar', async () => {
    const child = header('session-child', workdir, 1000);
    child.origin = 'subagent';
    child.delegationDepth = 1;
    child.parentSession = 'session-parent';
    const source = fakeContext([['session-child', { header: child, events: [] }]]);

    const [session] = await listSessions(source.ctx);
    assert.equal(session.origin, 'subagent');
    assert.equal(session.delegationDepth, 1);
    assert.equal(session.parentSession, 'session-parent');
  });
});

describe('inspectArchive', () => {
  it('summarises an archive without importing it', async () => {
    const source = fakeContext([['session-one', { header: header('session-one', workdir), events: events('one') }]]);
    const archivePath = join(workdir, 'inspect.dshsession');
    await exportSessions(source.ctx, {
      ids: ['session-one'],
      destPath: archivePath,
      generator: { name: 'dsh-session-vault', version: '9.9.9' },
    });
    const summary = await inspectArchive(archivePath);
    assert.equal(summary.sessionCount, 1);
    assert.equal(summary.eventCount, 2);
    assert.equal(summary.sessions[0].id, 'session-one');
    assert.equal(summary.sessions[0].cwd, workdir);
    assert.equal(summary.header.generator.version, '9.9.9');
  });
});

describe('archive independence', () => {
  it('does not need the source session to still exist at import time', async () => {
    const source = fakeContext([['session-one', { header: header('session-one', workdir), events: events('one') }]]);
    const archivePath = join(workdir, 'durable.dshsession');
    await exportSessions(source.ctx, { ids: ['session-one'], destPath: archivePath });

    // The archive is a real artefact on disk, not a live reference.
    const raw = await readFile(archivePath);
    assert.ok(raw.length > 0);

    const target = fakeContext();
    const result = await importSessions(target.ctx, { srcPath: archivePath });
    assert.equal(result.imported.length, 1);
  });
});

describe('session artifact paths', () => {
  it('reproduces the project directory DSH actually created', () => {
    // Observed on disk: this workspace's sessions live under
    // ~/.dsh/sessions/--D-BaiduSyncdisk-person-dsh-session-export--/
    assert.equal(
      projectKey('D:\\BaiduSyncdisk\\person\\dsh-session-export'),
      '--D-BaiduSyncdisk-person-dsh-session-export--',
    );
  });

  it('collapses a separator run to one dash', () => {
    assert.equal(projectKey('D:\\repo'), '--D-repo--');
    assert.equal(projectKey('/home/me/repo'), '--home-me-repo--');
  });

  it('escapes code units outside the safe set', () => {
    assert.equal(projectKey('/a b'), '--a~0020b--');
  });

  it('refuses an empty working directory', () => {
    assert.equal(projectKey(''), undefined);
  });

  it('leaves an ordinary session id literal', () => {
    assert.equal(encodeSessionSegment('session-1f2e-3d4c'), 'session-1f2e-3d4c');
  });

  it('neutralises traversal-shaped ids', () => {
    // The id is an unvalidated branded string, so this is the only thing
    // standing between a crafted id and a recursive remove somewhere else.
    //
    // Only a segment that is *entirely* `.` or `..` needs escaping: the moment
    // a separator is present it is itself encoded, so the result stays one
    // literal path segment and cannot traverse. Do not "improve" this into
    // escaping every dot — that would stop matching the layout DSH writes.
    assert.equal(encodeSessionSegment('..'), '~002E~002E');
    assert.equal(encodeSessionSegment('.'), '~002E');
    assert.equal(encodeSessionSegment('../evil'), '..~002Fevil');
    assert.equal(encodeSessionSegment('a/b'), 'a~002Fb');
    assert.equal(encodeSessionSegment('a\\b'), 'a~005Cb');
    assert.equal(encodeSessionSegment('a:b'), 'a~003Ab');
    assert.equal(encodeSessionSegment('a\0b'), 'a~0000b');
  });

  it('escapes a tilde so the encoding stays injective', () => {
    assert.equal(encodeSessionSegment('a~b'), 'a~007Eb');
  });

  it('places a session under its workspace key', () => {
    assert.match(sessionDirectoryOf({ id: 'session-abc', cwd: 'D:\\repo' }), /sessions[\\/]--D-repo--[\\/]session-abc$/);
  });

  it('uses _no-cwd for a session with no working directory', () => {
    assert.match(sessionDirectoryOf({ id: 'session-abc' }), /sessions[\\/]_no-cwd[\\/]session-abc$/);
  });
});

describe('session titles', () => {
  /** One human `user/message` event, shaped the way the harness logs it. */
  function prompt(text, kind = 'user') {
    return { type: 'user/message', seq: 0, data: { source: { kind }, content: [{ type: 'text', text }] } };
  }

  it('bounds a derived title the way the harness does', () => {
    assert.equal(fallbackTitle('one two three four five six seven'), 'one two three four five');
    assert.equal(fallbackTitle('  spaced   out  '), 'spaced out');
    // Tabs and newlines are control characters: they are stripped *before*
    // whitespace is collapsed, exactly as the harness does it.
    assert.equal(fallbackTitle('a\tb'), 'ab');
  });

  it('never splits a code point when enforcing the byte budget', () => {
    // 14 three-byte characters = 42 bytes, two over the budget: the cut has to
    // land on a character boundary, not in the middle of one.
    const title = fallbackTitle('一'.repeat(20));
    assert.equal(Buffer.byteLength(title, 'utf8') <= 40, true);
    assert.ok(!title.includes('\uFFFD'), 'no replacement character from a half-cut sequence');
    assert.equal(title.length, 13);
  });

  it('strips escape and directional marks before a title is displayed', () => {
    // The first prompt is untrusted text: left as-is it could retitle a
    // terminal or make the row read as something it is not.
    assert.equal(fallbackTitle('\u001B]0;pwned\u0007 real title'), 'real title');
    assert.equal(fallbackTitle('a\u200Bb\u202E mirror'), 'ab mirror');
  });

  it('derives nothing from whitespace alone', () => {
    assert.equal(fallbackTitle('   \n\t  '), undefined);
    assert.equal(fallbackTitle(undefined), undefined);
  });

  it('takes the first *human* message, not injected context', () => {
    // A runtime-context notice shares the event type; only `kind: 'user'` is a
    // real prompt, and only a real prompt may become a session's title.
    const events = [prompt('the injected context', 'plugin'), prompt('what I actually asked')];
    assert.equal(firstPromptTitle(events), 'what I actually asked');
  });

  it('joins the text blocks of one message into one line', () => {
    const event = {
      type: 'user/message',
      seq: 0,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first' }, { type: 'image' }, { type: 'text', text: 'second' }] },
    };
    // Both blocks contribute, in order, and the joiner is stripped by the same
    // sanitisation: a title is one line, so a newline cannot survive it.
    assert.equal(firstPromptTitle([event]), 'firstsecond');
  });

  it('reads the projected title out of the cache view', async () => {
    // `cachedSnapshot` returns `{ asOfSeq, values }` and `values.title` is
    // already the projected value. Reading `rows.title.val` — what this plugin
    // did at first — is always `undefined`, and every row displayed untitled.
    const base = fakeContext([['cached-1', { header: header('cached-1', 'D:\\x'), events: [] }]]);
    const cache = {
      cachedSnapshot() {
        return { asOfSeq: 3, values: { title: 'From the cache' } };
      },
    };
    const ctx = {
      get(key) {
        return key === 'sessionProjectionCache' ? cache : base.ctx.get(key);
      },
      effect: base.ctx.effect,
    };
    const [session] = await listSessions(ctx);
    assert.equal(session.title, 'From the cache');
    assert.equal(session.titleSource, 'cache');
  });

  it('falls back to the session log when the cache holds nothing', async () => {
    // The cache only holds sessions this process projected, so a miss is the
    // common case for a session stored by an earlier run.
    const { ctx } = fakeContext([
      ['logged-1', { header: header('logged-1', 'D:\\x'), events: [prompt('the real first prompt')] }],
    ]);
    const [session] = await listSessions(ctx);
    assert.equal(session.title, 'the real first prompt');
    assert.equal(session.titleSource, 'first-prompt');
  });

  it('reports no title and no source when neither rung resolves', async () => {
    const { ctx } = fakeContext([['blank-1', { header: header('blank-1', 'D:\\x'), events: [] }]]);
    const [session] = await listSessions(ctx);
    assert.equal(session.title, null);
    assert.equal(session.titleSource, null);
  });

  it('marks a session that was created but never used', async () => {
    // The real shape, taken off disk: creating a session writes these four
    // events and no message. There is no first prompt to title it with, and the
    // row must be able to say *why* rather than showing a bare "untitled".
    const { ctx } = fakeContext([[
      'unused-1',
      {
        header: header('unused-1', 'D:\\x'),
        events: [
          { type: 'permission/preset', seq: 0 },
          { type: 'sandbox/mode', seq: 1 },
          { type: 'approval/policy', seq: 2 },
          { type: 'session/end-seed', seq: 3 },
        ],
      },
    ]]);
    const [session] = await listSessions(ctx);
    assert.equal(session.title, null);
    assert.equal(session.conversation, false, 'setup events are not a conversation');
  });

  it('does not call a session with turns unconversational', async () => {
    const { ctx } = fakeContext([
      ['talked-1', { header: header('talked-1', 'D:\\x'), events: [prompt('hello there')] }],
    ]);
    const [session] = await listSessions(ctx);
    assert.equal(session.conversation, null, 'unset once any turn is present');
  });

  it('survives a log that cannot be opened', async () => {
    // An old artifact a migration refuses: a listing must not fail over a
    // title, and it must not leave the handle open either.
    const { ctx } = fakeContext([['broken-1', { header: header('broken-1', 'D:\\x'), events: [] }]]);
    const ctxWithBrokenPersistence = {
      get(key) {
        if (key !== 'sessionPersistence') return ctx.get(key);
        return { ...ctx.get('sessionPersistence'), open() { throw new Error('unreadable log'); } };
      },
      effect: ctx.effect,
    };
    const [session] = await listSessions(ctxWithBrokenPersistence);
    assert.equal(session.title, null);
  });
});

describe('orphan classification', () => {
  it('marks a session no workspace accounts for as orphaned', async () => {
    await writeWorkspaceAccount([{ path: 'D:\\kept', sessionIds: ['kept-1'] }], []);
    const { ctx } = fakeContext([
      ['kept-1', { header: header('kept-1', 'D:\\kept'), events: [] }],
      ['loose-1', { header: header('loose-1', 'D:\\loose'), events: [] }],
    ]);
    const sessions = await listSessions(ctx);
    const byId = Object.fromEntries(sessions.map((session) => [session.id, session]));
    assert.equal(byId['kept-1'].mounted, true);
    assert.equal(byId['kept-1'].orphaned, false);
    assert.equal(byId['loose-1'].mounted, false);
    assert.equal(byId['loose-1'].orphaned, true);
  });

  it('treats an archived session as not orphaned, even with no workspace', async () => {
    await writeWorkspaceAccount([], ['archived-1']);
    const { ctx } = fakeContext([['archived-1', { header: header('archived-1', 'D:\\x'), events: [] }]]);
    const [session] = await listSessions(ctx);
    assert.equal(session.archived, true);
    assert.equal(session.mounted, false);
    // Archiving is a deliberate "keep, but hide" — deleting it would be a
    // surprise, so it is excluded from the deletable set.
    assert.equal(session.orphaned, false);
  });

  it('honours the durable account even when the registry does not expose it', async () => {
    // The registry filters sessions whose header it cannot read, so its view is
    // a subset. Deletion is bounded by the union, which is what this checks —
    // and the same union must also *label* the session, or a listing reports it
    // as having no workspace while refusing to delete it on the grounds that
    // some workspace has it.
    await writeWorkspaceAccount([{ path: 'D:\\hidden', sessionIds: ['hidden-1'] }], []);
    const { ctx } = fakeContext([['hidden-1', { header: header('hidden-1', 'D:\\hidden'), events: [] }]]);
    const [session] = await listSessions(ctx);
    assert.equal(session.mounted, true, 'the durable account still claims it');
    assert.equal(session.orphaned, false);
    assert.equal(session.workspaceClaim, 'ledger', 'labelled by the view that actually claimed it');
    assert.equal(session.workspace.path, 'D:\\hidden');
  });

  it('prefers the registry claim and says so', async () => {
    await writeWorkspaceAccount([{ path: 'D:\\ledger', sessionIds: ['both-1'] }], []);
    const { ctx } = fakeContext([['both-1', { header: header('both-1', 'D:\\registry'), events: [] }]], {
      workspaces: [{ id: 'ws-registry', path: 'D:\\registry', title: 'Registry', sessionIds: ['both-1'] }],
    });
    const [session] = await listSessions(ctx);
    assert.equal(session.mounted, true);
    assert.equal(session.workspaceClaim, 'registry');
    assert.equal(session.workspace.id, 'ws-registry');
  });

  it('lists archived, unmounted sessions on request and counts them always', async () => {
    // The cleanup panel used to show nothing at all while the export panel
    // listed these sessions, because "unmounted" and "deletable" were the same
    // predicate. They are not: an archived session is still unmounted.
    await writeWorkspaceAccount([], ['archived-1']);
    const { ctx } = fakeContext([
      ['archived-1', { header: header('archived-1', 'D:\\x'), events: events('a') }],
      ['loose-1', { header: header('loose-1', 'D:\\y'), events: events('b') }],
    ]);

    const hidden = await listOrphanSessions(ctx);
    assert.deepEqual(hidden.sessions.map((session) => session.id), ['loose-1']);
    assert.equal(hidden.unmountedCount, 2, 'the hidden ones are still counted');
    assert.equal(hidden.archivedCount, 1);
    assert.equal(hidden.includeArchived, false);

    const shown = await listOrphanSessions(ctx, { includeArchived: true });
    assert.deepEqual(shown.sessions.map((session) => session.id).sort(), ['archived-1', 'loose-1']);
    assert.equal(shown.includeArchived, true);
  });

  it('never disagrees with the session list about what is unmounted', async () => {
    // The measured complaint: the export tab listed unmounted sessions while
    // the cleanup tab listed none, and nothing on screen reconciled them. Both
    // surfaces now derive from one predicate, so this pins them together — the
    // cleanup count is the export count, split, and the split always adds up.
    await writeWorkspaceAccount([{ path: 'D:\\kept', sessionIds: ['kept-1'] }], ['archived-1']);
    const { ctx } = fakeContext([
      ['kept-1', { header: header('kept-1', 'D:\\kept'), events: events('k') }],
      ['loose-1', { header: header('loose-1', 'D:\\loose'), events: events('l') }],
      ['archived-1', { header: header('archived-1', 'D:\\x'), events: events('a') }],
    ]);

    const listed = await listSessions(ctx);
    const unmountedFromList = listed.filter((session) => !session.mounted).length;
    const summary = await listOrphanSessions(ctx);
    const everything = await listOrphanSessions(ctx, { includeArchived: true });

    assert.equal(summary.unmountedCount, unmountedFromList);
    assert.equal(everything.sessions.length, unmountedFromList, 'the widened scope is exactly the unmounted set');
    assert.equal(
      summary.sessions.length + summary.archivedCount,
      summary.unmountedCount,
      'the two chips the panel shows must reconstruct the total',
    );
  });

  it('summarises orphans and their reclaimable bytes', async () => {
    await writeWorkspaceAccount([{ path: 'D:\\kept', sessionIds: ['kept-1'] }], []);
    const { ctx } = fakeContext([
      ['kept-1', { header: header('kept-1', 'D:\\kept'), events: [] }],
      ['loose-1', { header: header('loose-1', 'D:\\loose'), events: events('one') }],
      ['loose-2', { header: header('loose-2', 'D:\\loose'), events: events('two') }],
    ]);
    const { sessions, reclaimableBytes } = await listOrphanSessions(ctx);
    assert.deepEqual(sessions.map((session) => session.id).sort(), ['loose-1', 'loose-2']);
    // Two orphaned sessions of two events each, and the fake reports 100 bytes
    // per event; the mounted one contributes nothing.
    assert.equal(reclaimableBytes, 400);
  });
});

describe('purging orphaned sessions', () => {
  it('removes an orphaned session directory and its projection cache', async () => {
    await writeWorkspaceAccount([], []);
    const { ctx } = fakeContext([['loose-1', { header: header('loose-1', 'D:\\loose'), events: [] }]]);
    const directory = await seedArtifactDirectory('loose-1', 'D:\\loose');
    const cacheFile = join(workdir, 'storages', 'session_projcache', 'sessions', 'loose-1.json');
    await mkdir(dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, '{}');

    const result = await purgeSessions(ctx, { ids: ['loose-1'], confirm: true });
    assert.equal(result.deleted.length, 1);
    assert.equal(result.refused.length, 0);
    assert.equal(result.failed.length, 0);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), false);
    assert.equal(await isFile(cacheFile), false, 'the derived cache entry goes too');
  });

  it('refuses an archived session unless the caller opts in', async () => {
    await writeWorkspaceAccount([], ['archived-1']);
    const { ctx } = fakeContext([['archived-1', { header: header('archived-1', 'D:\\x'), events: [] }]]);
    const directory = await seedArtifactDirectory('archived-1', 'D:\\x');

    const guarded = await purgeSessions(ctx, { ids: ['archived-1'], confirm: true });
    assert.deepEqual(guarded.refused, [{ id: 'archived-1', reason: 'archived-session' }]);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);

    const optedIn = await purgeSessions(ctx, { ids: ['archived-1'], confirm: true, includeArchived: true });
    assert.equal(optedIn.deleted.length, 1);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), false);
  });

  it('refuses a session a workspace accounts for', async () => {
    await writeWorkspaceAccount([{ path: 'D:\\kept', sessionIds: ['kept-1'] }], []);
    // Seeded with a real turn, so this is an ordinary in-use session and not a
    // never-used one that merely happens to have no events.
    const { ctx } = fakeContext([[
      'kept-1',
      {
        header: header('kept-1', 'D:\\kept'),
        events: [{ type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: 'busy' }] } }],
      },
    ]]);
    const directory = await seedArtifactDirectory('kept-1', 'D:\\kept');

    const result = await purgeSessions(ctx, { ids: ['kept-1'], confirm: true });
    assert.equal(result.deleted.length, 0);
    assert.deepEqual(result.refused, [{ id: 'kept-1', reason: 'attached-to-a-workspace' }]);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);
  });

  it('says a mounted never-used session needs the opt-in, not that it is in use', async () => {
    // The reason string is what the panel shows. "Attached to a workspace" is
    // true here but useless: the session is empty and a switch would release
    // it, so the refusal has to name that instead.
    await writeWorkspaceAccount([{ path: 'D:\\kept', sessionIds: ['idle-1'] }], []);
    const { ctx } = fakeContext([['idle-1', { header: header('idle-1', 'D:\\kept'), events: [] }]]);
    const directory = await seedArtifactDirectory('idle-1', 'D:\\kept');

    const result = await purgeSessions(ctx, { ids: ['idle-1'], confirm: true });
    assert.equal(result.deleted.length, 0);
    assert.deepEqual(result.refused, [{ id: 'idle-1', reason: 'never-used-needs-opt-in' }]);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true, 'the default must not touch it');
  });

  it('deletes a never-used session when the caller opts in', async () => {
    await writeWorkspaceAccount([{ path: 'D:\\kept', sessionIds: ['idle-2'] }], []);
    const { ctx } = fakeContext([[
      'idle-2',
      {
        header: header('idle-2', 'D:\\kept'),
        // The real shape: creating a session writes these and no message.
        events: [
          { type: 'permission/preset', seq: 0 },
          { type: 'sandbox/mode', seq: 1 },
          { type: 'approval/policy', seq: 2 },
          { type: 'session/end-seed', seq: 3 },
        ],
      },
    ]]);
    const directory = await seedArtifactDirectory('idle-2', 'D:\\kept');

    const result = await purgeSessions(ctx, { ids: ['idle-2'], confirm: true, includeEmpty: true });
    assert.equal(result.refused.length, 0);
    assert.equal(result.deleted.length, 1);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), false);
  });

  it('never deletes an in-use mounted session, opt-in or not', async () => {
    // The whole width of the exception: `includeEmpty` must release exactly the
    // sessions proved to hold no conversation, and nothing adjacent to them.
    await writeWorkspaceAccount([{ path: 'D:\\kept', sessionIds: ['busy-1'] }], []);
    const { ctx } = fakeContext([[
      'busy-1',
      {
        header: header('busy-1', 'D:\\kept'),
        events: [
          { type: 'permission/preset', seq: 0 },
          { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'real work' }] } },
        ],
      },
    ]]);
    const directory = await seedArtifactDirectory('busy-1', 'D:\\kept');

    const result = await purgeSessions(ctx, { ids: ['busy-1'], confirm: true, includeEmpty: true });
    assert.deepEqual(result.refused, [{ id: 'busy-1', reason: 'attached-to-a-workspace' }]);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);
  });

  it('never deletes a mounted session whose contents were not established', async () => {
    // `conversation` stays null when the log could not be read. Absence of a
    // finding must never be read as the finding itself.
    await writeWorkspaceAccount([{ path: 'D:\\kept', sessionIds: ['opaque-1'] }], []);
    const { ctx } = fakeContext([['opaque-1', { header: header('opaque-1', 'D:\\kept'), events: [] }]]);
    ctx.get = ((original) => (key) => (key === 'sessionPersistence'
      ? {
        list: () => original('sessionPersistence').list(),
        open: async () => { throw new Error('read refused'); },
      }
      : original(key)))(ctx.get.bind(ctx));
    const directory = await seedArtifactDirectory('opaque-1', 'D:\\kept');

    const result = await purgeSessions(ctx, { ids: ['opaque-1'], confirm: true, includeEmpty: true });
    assert.deepEqual(result.refused, [{ id: 'opaque-1', reason: 'attached-to-a-workspace' }]);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);
  });

  it('refuses an archived session', async () => {
    await writeWorkspaceAccount([], ['archived-1']);
    const { ctx } = fakeContext([['archived-1', { header: header('archived-1', 'D:\\x'), events: [] }]]);
    const directory = await seedArtifactDirectory('archived-1', 'D:\\x');
    const result = await purgeSessions(ctx, { ids: ['archived-1'], confirm: true });
    assert.deepEqual(result.refused, [{ id: 'archived-1', reason: 'archived-session' }]);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);
  });

  it('refuses a live session', async () => {
    await writeWorkspaceAccount([], []);
    const liveStore = { get: (id) => (id === 'loose-1' ? { id } : undefined) };
    const { ctx } = fakeContext(
      [['loose-1', { header: header('loose-1', 'D:\\loose'), events: [] }]],
      { liveStore },
    );
    const directory = await seedArtifactDirectory('loose-1', 'D:\\loose');

    const result = await purgeSessions(ctx, { ids: ['loose-1'], confirm: true });
    assert.deepEqual(result.refused, [{ id: 'loose-1', reason: 'session-is-live' }]);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);
  });

  it('refuses when it cannot prove the session is not live', async () => {
    await writeWorkspaceAccount([], []);
    const throwingStore = { get: () => { throw new Error('store unavailable'); } };
    const { ctx } = fakeContext(
      [['loose-1', { header: header('loose-1', 'D:\\loose'), events: [] }]],
      { liveStore: throwingStore },
    );
    await seedArtifactDirectory('loose-1', 'D:\\loose');
    const result = await purgeSessions(ctx, { ids: ['loose-1'], confirm: true });
    assert.deepEqual(result.refused, [{ id: 'loose-1', reason: 'session-is-live' }]);
  });

  it('cannot be aimed outside the sessions root', async () => {
    await writeWorkspaceAccount([], []);
    // A traversal-shaped id: the encoder must keep the computed path inside
    // the root, so this is refused for being unknown rather than escaping.
    const { ctx } = fakeContext([['../escape', { header: header('../escape', 'D:\\x'), events: [] }]]);
    const outside = join(workdir, 'escape');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'must survive');

    const result = await purgeSessions(ctx, { ids: ['../escape'], confirm: true });
    assert.equal(result.failed.length, 0);
    assert.equal(await isFile(join(outside, 'keep.txt')), true, 'nothing outside the root may be touched');
    // The derived directory is confined, so the removal is a no-op rather than
    // a successful escape.
    assert.equal(deletedOutsideSessionsRoot(result), false);
  });

  it('removes nothing on a dry run', async () => {
    await writeWorkspaceAccount([], []);
    const { ctx } = fakeContext([['loose-1', { header: header('loose-1', 'D:\\loose'), events: [] }]]);
    const directory = await seedArtifactDirectory('loose-1', 'D:\\loose');

    const result = await purgeSessions(ctx, { ids: ['loose-1'], dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.deleted.length, 1);
    assert.equal(result.deleted[0].planned, true);
    assert.equal(result.deleted[0].directory, directory);
    assert.equal(result.reclaimedBytes, 0, 'a dry run reclaims nothing');
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);
  });

  it('refuses to delete without confirm', async () => {
    await writeWorkspaceAccount([], []);
    const { ctx } = fakeContext([['loose-1', { header: header('loose-1', 'D:\\loose'), events: [] }]]);
    const directory = await seedArtifactDirectory('loose-1', 'D:\\loose');
    await assert.rejects(
      () => purgeSessions(ctx, { ids: ['loose-1'] }),
      /requires confirm: true/,
    );
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);
  });

  it('refuses an unknown id and an empty request', async () => {
    await writeWorkspaceAccount([], []);
    const { ctx } = fakeContext();
    const result = await purgeSessions(ctx, { ids: ['nobody'], confirm: true });
    assert.deepEqual(result.refused, [{ id: 'nobody', reason: 'unknown-session' }]);
    await assert.rejects(() => purgeSessions(ctx, { ids: [], confirm: true }), /no session ids were given/);
  });

  it('reports survivors when a listing still returns a deleted session', async () => {
    await writeWorkspaceAccount([], []);
    const { ctx } = fakeContext([['loose-1', { header: header('loose-1', 'D:\\loose'), events: [] }]]);
    await seedArtifactDirectory('loose-1', 'D:\\loose');
    // Simulate a process serving a session from an in-memory index: the files
    // are gone but `list()` still reports it.
    const persistence = ctx.get('sessionPersistence');
    // Simulate a process serving a session from an in-memory index: the files
    // are gone but `list()` still reports it.
    persistence.list = async () => [{ header: header('loose-1', 'D:\\loose'), revision: 'stale' }];

    const result = await purgeSessions(ctx, { ids: ['loose-1'], confirm: true });
    assert.equal(result.deleted.length, 1, 'the files really were removed');
    assert.deepEqual(result.survivors, ['loose-1']);
  });

  it('counts the bytes it reclaimed', async () => {
    await writeWorkspaceAccount([], []);
    const { ctx } = fakeContext([['loose-1', { header: header('loose-1', 'D:\\loose'), events: events('x') }]]);
    await seedArtifactDirectory('loose-1', 'D:\\loose');
    const result = await purgeSessions(ctx, { ids: ['loose-1'], confirm: true });
    // The fake reports 100 bytes per event, and this session has two.
    assert.equal(result.reclaimedBytes, 200);
  });
});

/**
 * Whether a purge result reports removing anything outside the sessions root.
 * @param result - the purge result.
 * @returns `true` when some reported directory is outside `<DSH_HOME>/sessions`.
 */
function deletedOutsideSessionsRoot(result) {
  const root = join(workdir, 'sessions');
  return result.deleted.some((entry) => !entry.directory.startsWith(root));
}
