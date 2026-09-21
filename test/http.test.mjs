/**
 * HTTP route tests.
 *
 * These drive the real route handlers through fake `req`/`res` objects, which
 * is where the two things worth protecting actually live: the loopback +
 * same-origin fence, and the confinement of every browser-supplied file name
 * to the plugin's own staging directories.
 *
 * `DSH_HOME` is redirected to a temporary directory for the duration, because
 * `defaultExportDir()` resolves it per call and the export routes really do
 * write files. No real harness home is touched.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { after, before, describe, it } from 'node:test';

import { ARCHIVE_EXTENSION } from '../lib/archive.js';
import { isFile, sessionDirectoryOf } from '../lib/engine.js';
import { createRoutes, isLoopbackRequest, ROUTE_PREFIX } from '../lib/http.js';

/** Build a response stand-in that captures status, headers, and body. */
function makeResponse() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.status = null;
  res.headers = null;
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers === undefined ? {} : headers;
    return res;
  };
  res.body = () => Buffer.concat(chunks).toString('utf8');
  res.json = () => JSON.parse(res.body());
  return res;
}

/**
 * Build a request stand-in.
 * @param options - method, url, headers, raw body, peer address.
 * @returns a readable stream carrying the request body.
 */
function makeRequest(options = {}) {
  const body = options.body;
  const req = Readable.from(
    body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)],
  );
  req.method = options.method ?? 'GET';
  req.url = options.url ?? '/';
  req.headers = Object.assign({ host: '127.0.0.1:3080' }, options.headers ?? {});
  req.socket = { remoteAddress: options.remoteAddress ?? '127.0.0.1' };
  return req;
}

/** An in-memory stand-in for the two host services the routes use. */
function fakeContext(seed = []) {
  const store = new Map(seed);
  const workspaces = [];

  const persistence = {
    async list() {
      return [...store.values()].map((entry) => ({
        header: entry.header,
        revision: 'rev',
        eventCount: entry.events.length,
      }));
    },
    async stat(id) {
      const entry = store.get(id);
      return entry === undefined ? undefined : { header: entry.header, revision: 'rev' };
    },
    async open(id) {
      const entry = store.get(id);
      if (entry === undefined) throw new Error(`no such session: ${id}`);
      return {
        id,
        header: entry.header,
        inheritedEventCount: 0,
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
    archivedSessionIds: [],
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

  return {
    get(key) {
      if (key === 'sessionPersistence') return persistence;
      if (key === 'workspaceRegistry') return registry;
      return undefined;
    },
    store,
    workspaces,
  };
}

/** The generated route table plus a dispatcher. */
function makeRoutes(ctx = fakeContext()) {
  const routes = createRoutes({ ctx, generator: { name: 'dsh-session-vault', version: '0.1.0' } });
  return {
    routes,
    /**
     * Invoke one route by its full path.
     * @param path - path below the route prefix, query string included.
     * @param options - request options.
     * @returns the response stand-in.
     */
    async call(path, options) {
      const full = `${ROUTE_PREFIX}${path}`;
      // Routes are keyed by pathname only, exactly as WebServer matches them;
      // the query string belongs to the request URL, not the route table.
      const pathname = full.split('?')[0];
      const route = routes.find((candidate) => candidate.path === pathname);
      assert.ok(route !== undefined, `no route registered for ${pathname}`);
      const res = makeResponse();
      await route.handler(makeRequest(Object.assign({}, options, { url: full })), res);
      return res;
    },
  };
}

let originalHome;
let workdir;

before(async () => {
  originalHome = process.env.DSH_HOME;
  workdir = await mkdtemp(join(tmpdir(), 'dsh-session-vault-http-'));
  // Resolved per call, so redirecting it here keeps every write in the temp tree.
  process.env.DSH_HOME = workdir;
});

after(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  await rm(workdir, { recursive: true, force: true });
});

describe('isLoopbackRequest', () => {
  it('accepts a loopback peer with a loopback Host header', () => {
    assert.equal(isLoopbackRequest(makeRequest()), true);
  });

  it('accepts localhost as the Host header', () => {
    assert.equal(isLoopbackRequest(makeRequest({ headers: { host: 'localhost:3080' } })), true);
  });

  it('refuses a non-loopback peer', () => {
    assert.equal(isLoopbackRequest(makeRequest({ remoteAddress: '192.168.1.20' })), false);
  });

  it('refuses a LAN Host header even from a loopback peer', () => {
    // The deployment may be bound to 0.0.0.0; the Host header is what tells us
    // the request arrived through that exposure rather than through loopback.
    assert.equal(isLoopbackRequest(makeRequest({ headers: { host: '192.168.1.5:3080' } })), false);
  });

  it('refuses a cross-site fetch', () => {
    assert.equal(isLoopbackRequest(makeRequest({ headers: { 'sec-fetch-site': 'cross-site' } })), false);
  });

  it('refuses a mismatched Origin', () => {
    assert.equal(isLoopbackRequest(makeRequest({ headers: { origin: 'https://evil.example' } })), false);
  });

  it('accepts a matching Origin', () => {
    assert.equal(isLoopbackRequest(makeRequest({ headers: { origin: 'http://127.0.0.1:3080' } })), true);
  });
});

describe('trust fence on every route', () => {
  it('answers 403 to a non-loopback caller on each endpoint', async () => {
    const { routes, call } = makeRoutes();
    const paths = [
      ['/status', {}],
      ['/sessions', {}],
      ['/orphans', {}],
      ['/archives', {}],
      ['/export', { method: 'POST', body: '{}' }],
      ['/download?file=a.dshsession', {}],
      ['/upload?name=a.dshsession', { method: 'POST', body: 'x' }],
      ['/inspect', { method: 'POST', body: '{}' }],
      ['/import', { method: 'POST', body: '{}' }],
      ['/purge', { method: 'POST', body: '{}' }],
      ['/delete', { method: 'POST', body: '{}' }],
    ];
    for (const [path, options] of paths) {
      const res = await call(path, Object.assign({ remoteAddress: '10.0.0.7' }, options));
      assert.equal(res.status, 403, `${path} must be fenced`);
      assert.equal(res.json().ok, false);
    }
    // The fence is uniform, so the table covers every registered route.
    assert.equal(routes.length, paths.length);
  });
});

describe('status and listing routes', () => {
  it('reports which host services are available', async () => {
    const { call } = makeRoutes();
    const res = await call('/status');
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.archiveExtension, ARCHIVE_EXTENSION);
    assert.equal(body.services.sessionPersistence, true);
    assert.equal(body.services.workspaceRegistry, true);
    assert.equal(body.services.sessionProjectionCache, false);
    assert.match(body.exportDir, /dsh-session-vault/);
  });

  it('lists stored sessions', async () => {
    const ctx = fakeContext([
      ['session-a', { header: { version: 3, id: 'session-a', createdAt: 5, cwd: workdir, isSeeded: false }, events: [] }],
    ]);
    const { call } = makeRoutes(ctx);
    const res = await call('/sessions');
    const body = res.json();
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].id, 'session-a');
  });

  it('starts with an empty archive list', async () => {
    const { call } = makeRoutes();
    const res = await call('/archives');
    assert.deepEqual(res.json().archives, []);
  });
});

describe('export, download, inspect, import, delete', () => {
  /** A context holding one exportable session. */
  function seededContext() {
    return fakeContext([
      [
        'session-a',
        {
          header: { version: 3, id: 'session-a', createdAt: 5, cwd: workdir, isSeeded: false },
          events: [
            { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
            { type: 'assistant/message', seq: 1, data: { content: [{ type: 'text', text: 'there' }] } },
          ],
        },
      ],
    ]);
  }

  it('runs the whole round trip through the HTTP surface', async () => {
    const { call } = makeRoutes(seededContext());

    // export
    const exported = await call('/export', {
      method: 'POST',
      body: JSON.stringify({ ids: ['session-a'], fileName: 'trip.dshsession' }),
    });
    assert.equal(exported.status, 200);
    const exportBody = exported.json();
    assert.equal(exportBody.name, 'trip.dshsession');
    assert.equal(exportBody.sessionCount, 1);
    assert.equal(exportBody.eventCount, 2);
    assert.ok(exportBody.bytes > 0);

    // the file really exists under the redirected home
    const onDisk = await readFile(join(workdir, 'dsh-session-vault', 'exports', 'trip.dshsession'));
    assert.ok(onDisk.length > 0);

    // it now shows up in the archive list
    const listed = await call('/archives');
    assert.equal(listed.json().archives.length, 1);
    assert.equal(listed.json().archives[0].name, 'trip.dshsession');

    // download streams the same bytes
    const downloaded = await call('/download?file=trip.dshsession');
    assert.equal(downloaded.status, 200);
    assert.equal(downloaded.headers['content-disposition'], 'attachment; filename="trip.dshsession"');

    // inspect reads it back
    const inspected = await call('/inspect', {
      method: 'POST',
      body: JSON.stringify({ file: 'trip.dshsession' }),
    });
    assert.equal(inspected.json().sessionCount, 1);
    assert.equal(inspected.json().sessions[0].id, 'session-a');

    // import into a fresh deployment
    const target = makeRoutes(fakeContext());
    const preview = await target.call('/import', {
      method: 'POST',
      body: JSON.stringify({ file: 'trip.dshsession', dryRun: true }),
    });
    assert.equal(preview.json().dryRun, true);
    assert.equal(preview.json().imported.length, 1);

    const committed = await target.call('/import', {
      method: 'POST',
      body: JSON.stringify({ file: 'trip.dshsession', workspacePath: join(workdir, 'target-ws') }),
    });
    assert.equal(committed.json().imported.length, 1);
    assert.equal(committed.json().failed.length, 0);

    // delete requires an explicit confirmation
    const unconfirmed = await call('/delete', {
      method: 'POST',
      body: JSON.stringify({ file: 'trip.dshsession' }),
    });
    assert.equal(unconfirmed.status, 500);
    assert.match(unconfirmed.json().error, /confirm/);

    const removed = await call('/delete', {
      method: 'POST',
      body: JSON.stringify({ file: 'trip.dshsession', confirm: true }),
    });
    assert.equal(removed.json().deleted, true);
    assert.deepEqual((await call('/archives')).json().archives, []);
  });

  it('returns the sessions a partial export had to leave out', async () => {
    const ctx = fakeContext([
      [
        'session-a',
        {
          header: { version: 3, id: 'session-a', createdAt: 1, cwd: workdir, isSeeded: false },
          events: [{ type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } }],
        },
      ],
      [
        'session-broken',
        {
          header: { version: 3, id: 'session-broken', createdAt: 2, cwd: workdir, isSeeded: false },
          events: [],
        },
      ],
    ]);
    const persistence = ctx.get('sessionPersistence');
    const realOpen = persistence.open.bind(persistence);
    persistence.open = async (id, access) => {
      if (id === 'session-broken') throw new Error('unsupported descriptor version 2');
      return realOpen(id, access);
    };

    const { call } = makeRoutes(ctx);
    const res = await call('/export', {
      method: 'POST',
      body: JSON.stringify({ fileName: 'partial.dshsession' }),
    });

    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.sessionCount, 1);
    assert.equal(body.eventCount, 1);
    assert.equal(body.failed.length, 1);
    assert.equal(body.failed[0].id, 'session-broken');
    assert.match(body.failed[0].reason, /descriptor version 2/);
  });

  it('lists an uploaded archive even on a deployment with no exports', async () => {
    // The exact "carry an archive to a fresh machine" flow. Uploads are staged
    // in a different directory from exports, so listing only the export
    // directory made a dropped archive invisible in the picker — and on a
    // machine with nothing exported the picker was not rendered at all.
    const source = makeRoutes(seededContext());
    await source.call('/export', {
      method: 'POST',
      body: JSON.stringify({ ids: ['session-a'], fileName: 'carried.dshsession' }),
    });
    const bytes = await readFile(join(workdir, 'dsh-session-vault', 'exports', 'carried.dshsession'));

    const target = makeRoutes(fakeContext());
    const before = (await target.call('/archives')).json().archives.map((archive) => archive.name);
    assert.ok(!before.includes('dropped.dshsession'), 'nothing named that is staged yet');

    await target.call('/upload?name=dropped.dshsession', { method: 'POST', body: bytes });

    const listed = (await target.call('/archives')).json().archives;
    const entry = listed.find((archive) => archive.name === 'dropped.dshsession');
    assert.ok(entry !== undefined, 'an uploaded archive must appear in the archive list');
    assert.equal(entry.origin, 'upload');
    assert.equal(entry.bytes, bytes.length);

    // The UI inspects immediately after uploading; that must find it too.
    const inspected = await target.call('/inspect', {
      method: 'POST',
      body: JSON.stringify({ file: 'dropped.dshsession' }),
    });
    assert.equal(inspected.json().origin, 'upload');
    assert.equal(inspected.json().sessionCount, 1);
  });

  it('uploads a staged archive and imports it', async () => {
    const { call } = makeRoutes(seededContext());
    await call('/export', {
      method: 'POST',
      body: JSON.stringify({ ids: ['session-a'], fileName: 'source.dshsession' }),
    });
    const bytes = await readFile(join(workdir, 'dsh-session-vault', 'exports', 'source.dshsession'));

    const uploaded = await call('/upload?name=incoming.dshsession', { method: 'POST', body: bytes });
    assert.equal(uploaded.json().name, 'incoming.dshsession');
    assert.equal(uploaded.json().bytes, bytes.length);

    const target = makeRoutes(fakeContext());
    const preview = await target.call('/inspect', {
      method: 'POST',
      body: JSON.stringify({ file: 'incoming.dshsession' }),
    });
    assert.equal(preview.json().origin, 'upload');
    assert.equal(preview.json().sessionCount, 1);
  });
});

describe('browser-supplied name confinement', () => {
  it('refuses a traversal attempt in fileName', async () => {
    const { call } = makeRoutes();
    const res = await call('/export', {
      method: 'POST',
      body: JSON.stringify({ ids: [], fileName: '../../evil.dshsession' }),
    });
    assert.equal(res.status, 500);
    assert.match(res.json().error, /bare file name/);
  });

  it('refuses a backslash path in fileName', async () => {
    const { call } = makeRoutes();
    const res = await call('/export', {
      method: 'POST',
      body: JSON.stringify({ ids: [], fileName: 'sub\\evil.dshsession' }),
    });
    assert.match(res.json().error, /bare file name/);
  });

  it('refuses a drive-qualified name in fileName', async () => {
    const { call } = makeRoutes();
    const res = await call('/export', {
      method: 'POST',
      body: JSON.stringify({ ids: [], fileName: 'C:/evil.dshsession' }),
    });
    assert.match(res.json().error, /bare file name/);
  });

  it('refuses a name that is not an archive', async () => {
    const { call } = makeRoutes();
    const res = await call('/export', {
      method: 'POST',
      body: JSON.stringify({ ids: [], fileName: 'notes.txt' }),
    });
    assert.match(res.json().error, /\.dshsession/);
  });

  it('reports an unknown-but-legal name as not found', async () => {
    const { call } = makeRoutes();
    const res = await call('/download?file=absent.dshsession');
    assert.equal(res.status, 404);
  });

  it('refuses a traversal attempt in the download query', async () => {
    const { call } = makeRoutes();
    const res = await call('/download?file=..%2F..%2Fsettings.yaml');
    assert.equal(res.status, 404);
  });

  it('refuses a traversal attempt on inspect and import', async () => {
    const { call } = makeRoutes();
    for (const path of ['/inspect', '/import']) {
      const res = await call(path, {
        method: 'POST',
        body: JSON.stringify({ file: '../../../secrets.dshsession' }),
      });
      assert.equal(res.status, 500, `${path} must refuse a traversal`);
      assert.match(res.json().error, /staging/);
    }
  });

  it('refuses an upload name that escapes the staging directory', async () => {
    const { call } = makeRoutes();
    const res = await call('/upload?name=..%2F..%2Fplanted.dshsession', {
      method: 'POST',
      body: 'payload',
    });
    assert.equal(res.status, 500);
    assert.match(res.json().error, /bare file name/);
  });
});

describe('malformed requests', () => {
  it('rejects a non-JSON body', async () => {
    const { call } = makeRoutes();
    const res = await call('/export', { method: 'POST', body: 'not json' });
    assert.equal(res.status, 500);
    assert.match(res.json().error, /JSON object/);
  });

  it('rejects import with no file named', async () => {
    const { call } = makeRoutes();
    const res = await call('/import', { method: 'POST', body: '{}' });
    assert.match(res.json().error, /staging/);
  });

  it('reports an unreadable archive as a 400, not a 500', async () => {
    const { call } = makeRoutes();
    const uploads = join(workdir, 'dsh-session-vault', 'uploads');
    await mkdir(uploads, { recursive: true });
    await writeFile(join(uploads, 'broken.dshsession'), 'not gzip');
    const res = await call('/inspect', {
      method: 'POST',
      body: JSON.stringify({ file: 'broken.dshsession' }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.json().ok, false);
  });
});

describe('orphan listing and purge', () => {
  /**
   * A context holding one orphaned session, with a real artifact directory and
   * a durable workspace account that claims nothing.
   * @param id - the session id to create.
   * @returns the context, the artifact directory, and the id.
   */
  async function orphanedSetup(id) {
    const storages = join(workdir, 'storages');
    await mkdir(storages, { recursive: true });
    await writeFile(join(storages, 'workspace.json'), JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
      tables: { workspaces: {} },
    }));
    const ctx = fakeContext([[
      id,
      {
        header: { version: 3, id, createdAt: 1, cwd: `D:\\${id}`, isSeeded: false },
        // A real turn, in the harness's own vocabulary. An orphaned log is
        // normally a session someone actually used whose workspace went away —
        // which is why it is worth rescuing — and leaving this empty would make
        // every one of these fixtures a "never used" session instead.
        events: [
          { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
        ],
      },
    ]]);
    const directory = sessionDirectoryOf({ id, cwd: `D:\\${id}` });
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.v3.jsonl.zstd'), 'artifact bytes');
    return { ctx, directory, id };
  }

  it('lists the deletable sessions and what they would reclaim', async () => {
    const { ctx, id } = await orphanedSetup('orphan-list-1');
    const { call } = makeRoutes(ctx);
    const res = await call('/orphans');
    assert.equal(res.status, 200);
    const body = res.json();
    assert.deepEqual(body.sessions.map((session) => session.id), [id]);
    assert.equal(body.sessions[0].orphaned, true);
    assert.equal(typeof body.reclaimableBytes, 'number');
  });

  it('admits archived sessions into the list only when asked', async () => {
    // The cleanup panel and the export panel disagreed about which sessions
    // exist: unmounted-but-archived sessions were visible in one and invisible
    // in the other. Scope is now a query parameter, and the count is honest
    // either way.
    const { ctx, id } = await orphanedSetup('orphan-archived-1');
    const file = join(workdir, 'storages', 'workspace.json');
    const account = JSON.parse(await readFile(file, 'utf8'));
    account.global.archivedSessionIds = [id];
    await writeFile(file, JSON.stringify(account));
    const { call } = makeRoutes(ctx);

    const hidden = (await call('/orphans')).json();
    assert.deepEqual(hidden.sessions, []);
    assert.equal(hidden.unmountedCount, 1, 'still counted while hidden');
    assert.equal(hidden.archivedCount, 1);

    const shown = (await call('/orphans?includeArchived=1')).json();
    assert.deepEqual(shown.sessions.map((session) => session.id), [id]);
    assert.equal(shown.includeArchived, true);
  });

  it('deletes an archived session only when the caller opts in', async () => {
    const { ctx, directory, id } = await orphanedSetup('orphan-archived-purge-1');
    const file = join(workdir, 'storages', 'workspace.json');
    const account = JSON.parse(await readFile(file, 'utf8'));
    account.global.archivedSessionIds = [id];
    await writeFile(file, JSON.stringify(account));
    const { call } = makeRoutes(ctx);

    const guarded = await call('/purge', { method: 'POST', body: JSON.stringify({ ids: [id], confirm: true }) });
    assert.deepEqual(guarded.json().refused, [{ id, reason: 'archived-session' }]);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);

    const optedIn = await call('/purge', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], confirm: true, includeArchived: true }),
    });
    assert.equal(optedIn.json().deleted.length, 1);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), false);
  });

  it('deletes an orphaned session and reports it', async () => {
    const { ctx, directory, id } = await orphanedSetup('orphan-purge-1');
    const { call } = makeRoutes(ctx);
    const res = await call('/purge', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], confirm: true }),
    });
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.deleted.length, 1);
    assert.equal(body.deleted[0].id, id);
    assert.equal(body.refused.length, 0);
    assert.equal(body.failed.length, 0);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), false);
  });

  it('refuses to delete without confirm', async () => {
    const { ctx, directory, id } = await orphanedSetup('orphan-noconfirm-1');
    const { call } = makeRoutes(ctx);
    const res = await call('/purge', { method: 'POST', body: JSON.stringify({ ids: [id] }) });
    assert.equal(res.status, 500);
    assert.match(res.json().error, /requires confirm: true/);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);
  });

  it('removes nothing on a dry run', async () => {
    const { ctx, directory, id } = await orphanedSetup('orphan-dry-1');
    const { call } = makeRoutes(ctx);
    const res = await call('/purge', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], dryRun: true }),
    });
    assert.equal(res.status, 200);
    const body = res.json();
    assert.equal(body.dryRun, true);
    assert.equal(body.deleted.length, 1);
    assert.equal(body.deleted[0].planned, true);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);
  });

  it('lists and deletes never-used sessions only when asked', async () => {
    // A mounted session with no conversation in it: the "shell" case. It is not
    // unmounted, so the default scope must not offer it, and the opt-in must.
    const storages = join(workdir, 'storages');
    await mkdir(storages, { recursive: true });
    const id = 'shell-http-1';
    await writeFile(join(storages, 'workspace.json'), JSON.stringify({
      global: { archivedSessionIds: [] },
      tables: { workspaces: { ws1: { path: `D:\\${id}`, sessionIds: [id] } } },
    }));
    const ctx = fakeContext([[
      id,
      {
        header: { version: 3, id, createdAt: 1, cwd: `D:\\${id}`, isSeeded: false },
        events: [
          { type: 'permission/preset', seq: 0 },
          { type: 'session/end-seed', seq: 1 },
        ],
      },
    ]]);
    const directory = sessionDirectoryOf({ id, cwd: `D:\\${id}` });
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.v3.jsonl.zstd'), 'bytes');

    const { call } = makeRoutes(ctx);

    const defaultScope = (await call('/orphans')).json();
    assert.deepEqual(defaultScope.sessions.map((session) => session.id), []);
    assert.equal(defaultScope.emptyCount, 1, 'counted even while out of scope');

    const optedIn = (await call('/orphans?includeEmpty=1')).json();
    assert.deepEqual(optedIn.sessions.map((session) => session.id), [id]);
    assert.equal(optedIn.emptyCount, 1);

    // Deleting it needs the same opt-in, not just listing it.
    const withoutOptIn = (await call('/purge', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], confirm: true }),
    })).json();
    assert.equal(withoutOptIn.deleted.length, 0);
    assert.equal(withoutOptIn.refused[0].reason, 'never-used-needs-opt-in');
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);

    const withOptIn = (await call('/purge', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], confirm: true, includeEmpty: true }),
    })).json();
    assert.equal(withOptIn.deleted.length, 1);
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), false);
  });

  it('refuses a session a workspace accounts for', async () => {
    const { ctx, directory, id } = await orphanedSetup('kept-http-1');
    // Account for it durably: the route must not be able to delete it.
    const storages = join(workdir, 'storages');
    await writeFile(join(storages, 'workspace.json'), JSON.stringify({
      global: { archivedSessionIds: [] },
      tables: { workspaces: { ws1: { path: `D:\\${id}`, sessionIds: [id] } } },
    }));
    const { call } = makeRoutes(ctx);
    const res = await call('/purge', {
      method: 'POST',
      body: JSON.stringify({ ids: [id], confirm: true }),
    });
    const body = res.json();
    assert.equal(body.deleted.length, 0);
    assert.equal(body.refused[0].reason, 'attached-to-a-workspace');
    assert.equal(await isFile(join(directory, 'session.v3.jsonl.zstd')), true);
  });

  it('refuses a traversal-shaped id without touching anything outside', async () => {
    const storages = join(workdir, 'storages');
    await mkdir(storages, { recursive: true });
    await writeFile(join(storages, 'workspace.json'), JSON.stringify({
      global: { archivedSessionIds: [] }, tables: { workspaces: {} },
    }));
    const ctx = fakeContext([[
      '../../escaped',
      { header: { version: 3, id: '../../escaped', createdAt: 1, cwd: 'D:\\x', isSeeded: false }, events: [] },
    ]]);
    const outside = join(workdir, 'escaped');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'keep.txt'), 'survives');

    const { call } = makeRoutes(ctx);
    const res = await call('/purge', {
      method: 'POST',
      body: JSON.stringify({ ids: ['../../escaped'], confirm: true }),
    });
    assert.equal(res.status, 200);
    assert.equal(await isFile(join(outside, 'keep.txt')), true);
  });
});
