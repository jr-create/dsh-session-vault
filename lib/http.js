/**
 * dsh-session-vault — the browser-facing HTTP route family.
 *
 * The browser half never touches the filesystem. It lists sessions, asks the
 * host to build an archive, downloads it, uploads one back, and asks the host
 * to import it. Every route here is therefore a thin, validated wrapper over
 * `lib/engine.js`.
 *
 * Security posture, mirroring the route families already shipped by
 * `dsh-config-manager` and `@linxin666/dsh-ssh`:
 *
 *  - every route carries the loopback-only + same-origin trust fence, so a
 *    LAN-exposed deployment never serves these endpoints;
 *  - the browser half may only name files inside the plugin's own staging
 *    directories (`<DSH_HOME>/dsh-session-vault/{exports,uploads}`); it can
 *    never hand the host an arbitrary absolute path. The model-facing tools
 *    are the only surface that accepts a path, and those run under the
 *    agent's own approval policy.
 *
 * @module dsh-session-vault/http
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { hostname } from 'node:os';

import { resolveDshHome } from './home.js';

import {
  ARCHIVE_EXTENSION,
  ArchiveFormatError,
} from './archive.js';
import {
  defaultExportDir,
  exportSessions,
  importSessions,
  inspectArchive,
  listOrphanSessions,
  listSessions,
  purgeSessions,
  suggestArchiveName,
} from './engine.js';

/** JSON request bodies are tiny (ids and options); anything larger is a mistake. */
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;
/** Upload cap for one archive file. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
/** Route prefix shared by every endpoint below. */
export const ROUTE_PREFIX = '/api/dsh-session-vault';

/**
 * Loopback-only plus same-origin fence.
 *
 * Checks the peer address, the `Host` header, `Sec-Fetch-Site`, and `Origin`
 * so that a page on another origin cannot drive these endpoints through the
 * user's browser even when the server is reachable.
 *
 * @param request - the incoming request.
 * @returns `true` when the request may be served.
 */
export function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') {
    return false;
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/**
 * Read one query parameter as a boolean.
 *
 * Absent means `false`, so every flag defaults to the conservative reading —
 * an option that widens what can be listed or deleted must be asked for.
 *
 * @param value - the raw query value.
 * @returns `true` only for an explicit affirmative.
 */
export function flag(value) {
  if (value === null || value === undefined) return false;
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

/**
 * Write one JSON response.
 * @param res - the response.
 * @param status - HTTP status code.
 * @param body - JSON-serialisable body.
 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

/**
 * Read and parse a request body as JSON.
 * @param req - the request.
 * @returns the parsed object, or `undefined` when absent, oversized, or invalid.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stream a raw request body to a file, enforcing a byte cap.
 * @param req - the request.
 * @param dest - destination file.
 * @param maxBytes - hard limit.
 * @returns bytes written.
 */
async function writeRequestBodyToFile(req, dest, maxBytes) {
  const sink = createWriteStream(dest);
  let size = 0;
  try {
    await new Promise((resolvePromise, reject) => {
      req.on('error', reject);
      sink.on('error', reject);
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          reject(new Error(`upload exceeds the ${maxBytes} byte limit`));
          req.destroy();
          return;
        }
        if (sink.write(chunk) === false) req.pause();
      });
      sink.on('drain', () => req.resume());
      req.on('end', () => sink.end(resolvePromise));
    });
    return size;
  } catch (error) {
    sink.destroy();
    throw error;
  }
}

/** The plugin's own data root under the harness home. */
function dataRoot() {
  return resolve(join(defaultExportDir(), '..'));
}

/** Where the browser half's uploads are staged. */
function uploadDir() {
  return join(dataRoot(), 'uploads');
}

/**
 * Confine a browser-supplied name to the staging roots.
 *
 * Only a bare file name is accepted: separators, drive letters, and `..` are
 * rejected before any filesystem call, so a hostile request cannot escape the
 * plugin's own directories.
 *
 * @param name - the candidate name.
 * @returns the absolute path, or `undefined` when the name is not acceptable.
 */
function stagedPath(name) {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  if (name !== basename(name)) return undefined;
  if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes(':')) return undefined;
  if (!name.endsWith(ARCHIVE_EXTENSION)) return undefined;
  return { name, uploads: join(uploadDir(), name), exports: join(defaultExportDir(), name) };
}

/**
 * Resolve a browser-supplied archive name to a real file, preferring uploads.
 * @param name - the candidate name.
 * @returns `{ name, path, origin }`, or `undefined` when nothing matches.
 */
async function resolveStaged(name) {
  const candidates = stagedPath(name);
  if (candidates === undefined) return undefined;
  for (const [origin, path] of [['upload', candidates.uploads], ['export', candidates.exports]]) {
    try {
      if ((await stat(path)).isFile()) return { name: candidates.name, path, origin };
    } catch {
      // Missing is the normal miss; keep looking.
    }
  }
  return undefined;
}

/**
 * List the archives currently staged in the exports directory.
 * @returns descriptor list, newest first.
 */
async function listArchives() {
  const files = [];
  const seen = new Set();
  // Uploads are scanned first so that a name present in both directories is
  // reported once, resolving the same way `resolveStaged` resolves it — uploads
  // win. Listing only the export directory was a real defect: an archive the
  // user dragged in lived in uploads, so it never appeared in the picker, and
  // on a machine with no exports the picker was not rendered at all.
  for (const [origin, dir] of [['upload', uploadDir()], ['export', defaultExportDir()]]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(ARCHIVE_EXTENSION)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      try {
        const info = await stat(join(dir, entry.name));
        files.push({
          name: entry.name,
          origin,
          bytes: info.size,
          modifiedAt: info.mtime.toISOString(),
        });
      } catch {
        // A file that vanished between readdir and stat is simply not listed.
      }
    }
  }
  files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  return files;
}

/**
 * Build the plugin's route table.
 *
 * @param options - route dependencies.
 * @param options.ctx - the plugin context (host services are read from it per request).
 * @param options.generator - `{ name, version }` stamped into exported archives.
 * @param options.log - optional logger.
 * @returns route descriptors accepted by `WebServer.register`.
 */
export function createRoutes(options) {
  const { ctx, generator, log } = options;

  /**
   * Wrap one handler with the trust fence and a JSON error envelope, so no
   * route can forget either.
   * @param handler - the route body, returning a JSON value.
   * @returns an HTTP handler.
   */
  function route(handler) {
    return async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'these endpoints are loopback-only' });
        return;
      }
      try {
        const body = await handler(req, res);
        if (body !== undefined && !res.writableEnded) writeJson(res, 200, { ok: true, ...body });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = error instanceof ArchiveFormatError ? 400 : 500;
        if (status === 500) log?.warn?.(`dsh-session-vault: ${message}`);
        if (!res.writableEnded) writeJson(res, status, { ok: false, error: message });
      }
    };
  }

  const routes = [];

  /**
   * Register one exact-path route.
   * @param path - path below the shared prefix.
   * @param handler - route body.
   */
  function on(path, handler) {
    routes.push({ kind: 'exact', path: `${ROUTE_PREFIX}${path}`, handler: route(handler) });
  }

  on('/status', async () => ({
    version: generator.version,
    exportDir: defaultExportDir(),
    uploadDir: uploadDir(),
    archiveExtension: ARCHIVE_EXTENSION,
    services: {
      sessionPersistence: ctx.get('sessionPersistence') !== undefined,
      workspaceRegistry: ctx.get('workspaceRegistry') !== undefined,
      sessionProjectionCache: ctx.get('sessionProjectionCache') !== undefined,
    },
  }));

  on('/sessions', async () => ({ sessions: await listSessions(ctx) }));

  // The cleanup panel's scope is a query parameter rather than a client-side
  // filter: `unmounted` is measured on the host against both workspace views, so
  // "everything no workspace claims" is a question only the host can answer.
  on('/orphans', async (req) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    return listOrphanSessions(ctx, {
      includeArchived: flag(url.searchParams.get('includeArchived')),
      includeEmpty: flag(url.searchParams.get('includeEmpty')),
    });
  });

  on('/archives', async () => ({ archives: await listArchives() }));

  on('/export', async (req) => {
    const body = await readJsonBody(req);
    if (body === undefined) throw new Error('request body must be a JSON object');
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const requested = typeof body.fileName === 'string' && body.fileName.length > 0 ? body.fileName : undefined;
    const name = requested === undefined ? suggestArchiveName(ids.length || 0) : requested;
    const candidates = stagedPath(name);
    if (candidates === undefined) {
      throw new Error(`fileName must be a bare file name ending in ${ARCHIVE_EXTENSION}`);
    }
    await mkdir(defaultExportDir(), { recursive: true });
    const result = await exportSessions(ctx, {
      ids,
      destPath: candidates.exports,
      generator,
      source: { dshHome: resolveDshHome(), hostname: hostname(), platform: process.platform },
    });

    // When the caller let us choose the name, that name states a session count
    // and it must state the count actually written. A partial export otherwise
    // leaves an archive called "6-sessions" holding five.
    let finalName = basename(result.destPath);
    let finalPath = result.destPath;
    if (requested === undefined && result.sessionCount !== ids.length) {
      const renamed = suggestArchiveName(result.sessionCount);
      finalPath = join(defaultExportDir(), renamed);
      await rename(result.destPath, finalPath);
      finalName = renamed;
    }

    return {
      name: finalName,
      path: finalPath,
      sessionCount: result.sessionCount,
      eventCount: result.eventCount,
      bytes: result.bytes,
      ids: result.ids,
      failed: result.failed,
    };
  });

  on('/download', async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const staged = await resolveStaged(url.searchParams.get('file'));
    if (staged === undefined) {
      writeJson(res, 404, { ok: false, error: 'no such archive' });
      return undefined;
    }
    const info = await stat(staged.path);
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': String(info.size),
      'content-disposition': `attachment; filename="${staged.name}"`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    await new Promise((resolvePromise, reject) => {
      const source = createReadStream(staged.path);
      source.on('error', reject);
      res.on('close', resolvePromise);
      source.pipe(res);
    });
    return undefined;
  });

  on('/upload', async (req) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const candidates = stagedPath(url.searchParams.get('name'));
    if (candidates === undefined) {
      throw new Error(`name must be a bare file name ending in ${ARCHIVE_EXTENSION}`);
    }
    await mkdir(uploadDir(), { recursive: true });
    const bytes = await writeRequestBodyToFile(req, candidates.uploads, MAX_UPLOAD_BYTES);
    return { name: candidates.name, bytes };
  });

  on('/inspect', async (req) => {
    const body = await readJsonBody(req);
    if (body === undefined) throw new Error('request body must be a JSON object');
    const staged = await resolveStaged(body.file);
    if (staged === undefined) throw new Error('no such archive in the plugin staging directories');
    return { name: staged.name, origin: staged.origin, ...(await inspectArchive(staged.path)) };
  });

  on('/import', async (req) => {
    const body = await readJsonBody(req);
    if (body === undefined) throw new Error('request body must be a JSON object');
    const staged = await resolveStaged(body.file);
    if (staged === undefined) throw new Error('no such archive in the plugin staging directories');
    const result = await importSessions(ctx, {
      srcPath: staged.path,
      workspacePath: typeof body.workspacePath === 'string' ? body.workspacePath : undefined,
      mode: body.mode === 'rename' ? 'rename' : 'skip',
      createMissingDirectory: body.createMissingDirectory !== false,
      dryRun: body.dryRun === true,
    });
    return {
      name: staged.name,
      dryRun: result.dryRun,
      archive: result.archive,
      imported: result.imported,
      skipped: result.skipped,
      failed: result.failed,
    };
  });

  on('/delete', async (req) => {
    const body = await readJsonBody(req);
    if (body === undefined) throw new Error('request body must be a JSON object');
    if (body.confirm !== true) throw new Error('delete requires confirm: true');
    const staged = await resolveStaged(body.file);
    if (staged === undefined) throw new Error('no such archive in the plugin staging directories');
    // Confinement is already proved by resolveStaged; the extra prefix check
    // makes that invariant explicit at the destructive call site.
    if (!resolve(staged.path).startsWith(resolve(dataRoot()) + sep)) {
      throw new Error('refusing to delete a file outside the plugin data directory');
    }
    await rm(staged.path);
    return { name: staged.name, deleted: true };
  });

  // Deleting a *session* is a different, sharper operation than deleting a
  // staged archive: it removes a stored session's artifacts from the harness
  // home, and there is no undo. It stays behind the same fences the engine
  // enforces — unmounted only, never live, and never archived unless the caller
  // says so — plus an explicit `confirm` here, and `dryRun` is the default
  // posture the browser half offers first.
  on('/purge', async (req) => {
    const body = await readJsonBody(req);
    if (body === undefined) throw new Error('request body must be a JSON object');
    return purgeSessions(ctx, {
      ids: Array.isArray(body.ids) ? body.ids : [],
      dryRun: body.dryRun === true,
      confirm: body.confirm === true,
      includeArchived: body.includeArchived === true,
      includeEmpty: body.includeEmpty === true,
    });
  });

  return routes;
}
