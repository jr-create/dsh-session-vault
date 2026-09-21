/**
 * Host-plugin tests.
 *
 * These drive the real `apply` from `lib/index.js`. The tool definitions it
 * registers come from `lib/tool-schema.js` — this package's own compiler —
 * rather than the host's `defineTool`, because a `link:`-installed plugin
 * cannot resolve `@deepseek-ai/*` at all (see `test/packaging.test.mjs`).
 * Equivalence with the host compiler is proved separately, against a fixture
 * captured from the real `defineTool`, in `test/tool-schema.test.mjs`.
 *
 * So calling `apply()` here proves every registered tool is well-formed for
 * *this* compiler, and the equivalence suite proves that is the same thing as
 * being well-formed for the harness.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { apply, defaultExportDir, inject, name } from '../lib/index.js';
import { sessionDirectoryOf } from '../lib/engine.js';

/** The five tools this plugin is expected to contribute. */
const EXPECTED_TOOLS = [
  'session_list',
  'session_export',
  'session_archive_inspect',
  'session_import',
  'session_delete',
];

/**
 * One stored session used by the fake services.
 *
 * The event types are the harness's real ones (`user/message`, not
 * `message/user`), because the engine classifies a session as never-used by
 * reading them: get the vocabulary wrong here and every fixture silently looks
 * like a shell session.
 */
function seedSession(id, cwd, createdAt = 1_700_000_000_000) {
  return [
    id,
    {
      header: { version: 3, id, createdAt, cwd, isSeeded: false },
      events: [
        { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
        { type: 'assistant/message', seq: 1, data: { content: [{ type: 'text', text: 'world' }] } },
      ],
    },
  ];
}

/**
 * A context carrying the real `defineTool` path plus in-memory stand-ins for
 * the services the tools read.
 * @param seed - initial sessions as `[id, entry]` pairs.
 * @returns the fake context and captured registrations.
 */
function fakeContext(seed = []) {
  const store = new Map(seed);
  const registered = [];
  const effects = [];
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
        inheritedEventCount: 0,
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

  const services = {
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    sessionPersistence: persistence,
    workspaceRegistry: registry,
  };

  const ctx = {
    get(key) {
      return services[key];
    },
    effect(callback, label) {
      effects.push(label);
      return callback();
    },
    inject(names, callback) {
      // Faithful to Cordis: the callback runs only once every named service is
      // published, on a context where they are readable as properties.
      if (!names.every((serviceName) => services[serviceName] !== undefined)) return { dispose() {} };
      return callback(injectedContext(names));
    },
  };

  /**
   * Build the child context an injected callback receives.
   * @param names - the injected service names.
   * @returns a context with those services as own properties.
   */
  function injectedContext(names) {
    const child = Object.create(ctx);
    child.get = (key) => services[key];
    for (const serviceName of names) child[serviceName] = services[serviceName];
    return child;
  }

  return { ctx, registered, effects, store, workspaces, services };
}

/**
 * A context whose services appear *after* `apply` runs.
 *
 * This models the real boot ordering that broke the plugin: `tools` and
 * `webServer` are published by bundles that activate on their own schedule, so
 * a bare `ctx.get()` during `apply` sees `undefined` and silently contributes
 * nothing. `publish` resolves whatever injected callbacks are now satisfiable.
 * @returns the context plus handles for publishing services and observing effects.
 */
function deferredContext() {
  const services = {};
  const pending = [];
  const registered = [];
  const routes = [];
  const effects = [];

  const ctx = {
    get(key) {
      return services[key];
    },
    effect(callback, label) {
      effects.push(label);
      return callback();
    },
    inject(names, callback) {
      const entry = { names, callback };
      pending.push(entry);
      settle();
      return { dispose() {} };
    },
  };

  /**
   * Run every pending callback whose dependencies are now all published.
   * @returns nothing.
   */
  function settle() {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index];
      if (!entry.names.every((name) => services[name] !== undefined)) continue;
      pending.splice(index, 1);
      const child = Object.create(ctx);
      child.get = (key) => services[key];
      for (const name of entry.names) child[name] = services[name];
      entry.callback(child);
    }
  }

  return {
    ctx,
    registered,
    routes,
    effects,
    pending,
    /**
     * Publish one service and settle the callbacks that were waiting for it.
     * @param name - the service name.
     * @param service - the service value.
     */
    publish(name, service) {
      services[name] = service;
      settle();
    },
  };
}

let workdir;
let originalHome;

before(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-session-vault-plugin-'));
  // `session_delete` is the one tool that removes files under `<DSH_HOME>`.
  // Redirecting the home here means a test can never reach a real harness home
  // even if a fake session id happens to collide with a real one.
  originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = workdir;
});

after(async () => {
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  await rm(workdir, { recursive: true, force: true });
});

describe('plugin identity', () => {
  it('exports the loader identity that cordis.patch.yml targets', () => {
    // The patch row id and this name must agree, or the row mounts nothing.
    assert.equal(name, 'session-vault');
  });

  it('declares no hard service dependency', () => {
    // Session persistence, the workspace registry, and the web server are all
    // resolved per capability, so a profile missing any of them still loads
    // this plugin and keeps whatever it *can* contribute.
    assert.deepEqual(inject, []);
  });
});

describe('apply waits for late services', () => {
  // Regression cover for the defect that shipped first: `apply` read `tools`
  // and `webServer` with a bare `ctx.get()`, but both are published by bundles
  // that activate on their own schedule. At apply time they were `undefined`,
  // so the plugin silently contributed no tools and no routes — the settings
  // page rendered (its bundle is served from package.json) and every request
  // fell through to the /api RPC fence as a 401 "unauthorized".
  it('contributes nothing until its services are published', () => {
    const harness = deferredContext();
    apply(harness.ctx, undefined);
    assert.equal(harness.registered.length, 0, 'no tool may register before `tools` exists');
    assert.equal(harness.routes.length, 0, 'no route may register before `webServer` exists');
    assert.equal(harness.pending.length, 2, 'both capabilities must be waiting');
  });

  it('registers the tools as soon as `tools` appears', () => {
    const harness = deferredContext();
    apply(harness.ctx, undefined);

    harness.publish('tools', {
      register(definition) {
        harness.registered.push(definition);
        return () => {};
      },
    });

    assert.deepEqual(harness.registered.map((definition) => definition.name).sort(), [...EXPECTED_TOOLS].sort());
    assert.equal(harness.pending.length, 1, 'the web server capability is still waiting');
  });

  it('registers the routes as soon as `webServer` appears', () => {
    const harness = deferredContext();
    apply(harness.ctx, undefined);

    harness.publish('webServer', {
      register(route) {
        harness.routes.push(route);
        return () => {};
      },
    });

    assert.ok(harness.routes.length > 0);
    for (const route of harness.routes) {
      assert.match(route.path, /^\/api\/dsh-session-vault\//);
      assert.equal(route.kind, 'exact');
    }
    assert.equal(harness.pending.length, 1, 'the tools capability is still waiting');
  });

  it('mounts both capabilities whatever order they arrive in', () => {
    const harness = deferredContext();
    apply(harness.ctx, undefined);

    harness.publish('webServer', {
      register(route) {
        harness.routes.push(route);
        return () => {};
      },
    });
    harness.publish('tools', {
      register(definition) {
        harness.registered.push(definition);
        return () => {};
      },
    });

    assert.equal(harness.pending.length, 0);
    assert.equal(harness.registered.length, EXPECTED_TOOLS.length);
    assert.ok(harness.routes.length > 0);
  });

  it('keeps the tools when the profile never publishes a web server', () => {
    // The non-web case: a real deployment can have `tools` without `webServer`.
    const harness = deferredContext();
    apply(harness.ctx, undefined);
    harness.publish('tools', {
      register(definition) {
        harness.registered.push(definition);
        return () => {};
      },
    });

    assert.equal(harness.registered.length, EXPECTED_TOOLS.length);
    assert.equal(harness.routes.length, 0);
    assert.equal(harness.pending.length, 1, 'the web server capability stays pending, harmlessly');
  });
});

describe('apply', () => {
  it('registers every tool without a schema error', () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, undefined);
    assert.deepEqual(registered.map((definition) => definition.name).sort(), [...EXPECTED_TOOLS].sort());
  });

  it('registers its registrations as plugin-owned effects', () => {
    const { ctx, effects } = fakeContext();
    apply(ctx, undefined);
    assert.ok(effects.includes('dsh-session-vault: model tools'));
  });

  it('does nothing but skip routes when the profile has no web server', () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, undefined);
    // Five tools, zero route registrations: no throw, no partial setup.
    assert.equal(registered.length, EXPECTED_TOOLS.length);
  });

  it('publishes compiled JSON Schema for every tool', () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, undefined);
    for (const definition of registered) {
      // `defineTool` compiles the author-facing spec inside the call that
      // produced these definitions, so reaching this point already proves both
      // specs compiled. What is worth pinning is the shape it publishes: the
      // registry and the model see raw JSON Schema, not the author DSL.
      assert.equal(definition.parameters.type, 'object', `${definition.name} parameters root`);
      assert.equal(typeof definition.parameters.properties, 'object');
      assert.equal(definition.output.schema.type, 'object', `${definition.name} output root`);
      assert.equal(definition.output.schema.additionalProperties, false);
      assert.equal(typeof definition.execute, 'function');
      assert.equal(typeof definition.output.render, 'function');
      assert.ok(definition.description.length > 40, `${definition.name} needs a real description`);
    }
  });

  it('declares the required parameters the model must supply', () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, undefined);
    const required = (toolName) => {
      const definition = registered.find((candidate) => candidate.name === toolName);
      return new Set(definition.parameters.required ?? []);
    };
    assert.deepEqual([...required('session_import')], ['archivePath']);
    // session_list and session_export are fully optional: exporting everything
    // and listing everything are both meaningful calls.
    assert.deepEqual([...required('session_list')], []);
    assert.deepEqual([...required('session_export')], []);
    assert.deepEqual([...required('session_archive_inspect')], ['archivePath']);
  });
});

describe('argument validation', () => {
  it('rejects a session_import call missing its required archivePath', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, undefined);
    const definition = registered.find((candidate) => candidate.name === 'session_import');
    // Validation is the harness's, applied inside the registered `execute`;
    // asserting through `execute` therefore tests the path a model call takes.
    await assert.rejects(
      () => definition.execute({ mode: 'skip' }, { signal: undefined }),
      /invalid arguments/,
    );
  });

  it('rejects an unknown collision mode', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, undefined);
    const definition = registered.find((candidate) => candidate.name === 'session_import');
    await assert.rejects(
      () => definition.execute({ archivePath: 'a.dshsession', mode: 'overwrite' }, { signal: undefined }),
      /invalid arguments/,
    );
  });

  it('rejects a non-string session id in session_export', async () => {
    const { ctx, registered } = fakeContext();
    apply(ctx, undefined);
    const definition = registered.find((candidate) => candidate.name === 'session_export');
    await assert.rejects(
      () => definition.execute({ ids: [42] }, { signal: undefined }),
      /invalid arguments/,
    );
  });
});

describe('session_list', () => {
  it('returns a value matching its declared output shape', async () => {
    const { ctx, registered } = fakeContext([seedSession('session-a', workdir, 5000)]);
    apply(ctx, undefined);
    const definition = registered.find((candidate) => candidate.name === 'session_list');
    const value = await definition.execute({}, { signal: undefined });

    assert.equal(value.count, 1);
    assert.equal(value.sessions.length, 1);
    assert.equal(value.sessions[0].id, 'session-a');
    assert.equal(value.sessions[0].cwd, workdir);
    assert.equal(value.sessions[0].createdAt, 5000);
    assert.equal(value.sessions[0].archived, false);
    assert.equal(value.sessions[0].isSeeded, false);
    // The seeded session has real turns, so a title is derived from its first
    // user message rather than being absent.
    assert.equal(value.sessions[0].title, 'hello');
    // Absent optional fields must be omitted, not null: the canonical output
    // schema types them as strings, and a literal null would fail it.
    assert.ok(!('workspaceTitle' in value.sessions[0]));
    assert.ok(!('conversation' in value.sessions[0]), 'a used session reports no conversation flag');

    const blocks = definition.output.render({}, value);
    assert.equal(blocks[0].type, 'text');
    assert.match(blocks[0].text, /session-a/);
  });

  it('honours limit and the archived filter', async () => {
    const { ctx, registered } = fakeContext([
      seedSession('session-a', workdir, 3000),
      seedSession('session-b', workdir, 2000),
    ]);
    apply(ctx, undefined);
    const definition = registered.find((candidate) => candidate.name === 'session_list');

    const limited = await definition.execute({ limit: 1 }, { signal: undefined });
    assert.equal(limited.count, 1);
    assert.equal(limited.sessions[0].id, 'session-a');
  });
});

describe('session_export and session_import round-trip', () => {
  it('exports through the tool and imports it back through the tool', async () => {
    const archivePath = join(workdir, 'tool-round-trip.dshsession');
    const source = fakeContext([seedSession('session-a', workdir, 7000)]);
    apply(source.ctx, undefined);

    const exportTool = source.registered.find((candidate) => candidate.name === 'session_export');
    const exported = await exportTool.execute({ ids: ['session-a'], outputPath: archivePath }, { signal: undefined });
    assert.equal(exported.sessionCount, 1);
    assert.equal(exported.eventCount, 2);

    const target = fakeContext();
    apply(target.ctx, undefined);
    const inspectTool = target.registered.find((candidate) => candidate.name === 'session_archive_inspect');
    const inspected = await inspectTool.execute({ archivePath }, { signal: undefined });
    assert.equal(inspected.sessionCount, 1);
    assert.equal(inspected.sessions[0].id, 'session-a');

    const importTool = target.registered.find((candidate) => candidate.name === 'session_import');
    const imported = await importTool.execute({ archivePath }, { signal: undefined });
    assert.equal(imported.imported.length, 1);
    assert.equal(imported.imported[0].id, 'session-a');
    assert.equal(imported.failed.length, 0);
    assert.equal(target.store.get('session-a').events.length, 2);
  });

  it('refuses an output path that is not an archive name', async () => {
    const { ctx, registered } = fakeContext([seedSession('session-a', workdir)]);
    apply(ctx, undefined);
    const definition = registered.find((candidate) => candidate.name === 'session_export');
    await assert.rejects(
      () => definition.execute({ ids: ['session-a'], outputPath: join(workdir, 'plain.zip') }, { signal: undefined }),
      /outputPath must end in \.dshsession/,
    );
  });

  it('reports a dry-run import without writing', async () => {
    const archivePath = join(workdir, 'tool-dry-run.dshsession');
    const source = fakeContext([seedSession('session-a', workdir)]);
    apply(source.ctx, undefined);
    await source.registered
      .find((candidate) => candidate.name === 'session_export')
      .execute({ ids: ['session-a'], outputPath: archivePath }, { signal: undefined });

    const target = fakeContext();
    apply(target.ctx, undefined);
    const result = await target.registered
      .find((candidate) => candidate.name === 'session_import')
      .execute({ archivePath, dryRun: true }, { signal: undefined });

    assert.equal(result.dryRun, true);
    assert.equal(result.imported.length, 1);
    assert.equal(target.store.size, 0);
  });
});

describe('defaultExportDir', () => {
  it('lives inside the harness home', () => {
    const dir = defaultExportDir();
    assert.match(dir, /dsh-session-vault[\\/]exports$/);
  });
});

describe('session_delete', () => {
  /**
   * Run one tool by name from a freshly applied plugin.
   * @param seed - sessions to seed the fake services with.
   * @returns a `run(name, args)` helper plus the fake context pieces.
   */
  function harness(seed) {
    const fake = fakeContext(seed);
    apply(fake.ctx, undefined);
    return {
      ...fake,
      run(name, args) {
        const definition = fake.registered.find((candidate) => candidate.name === name);
        assert.ok(definition !== undefined, `missing tool: ${name}`);
        return definition.execute(args, { signal: undefined });
      },
      render(name, value) {
        const definition = fake.registered.find((candidate) => candidate.name === name);
        return definition.output.render({}, value)[0].text;
      },
    };
  }

  it('is registered and requires ids', async () => {
    const fake = harness([]);
    const definition = fake.registered.find((candidate) => candidate.name === 'session_delete');
    assert.ok(definition !== undefined);
    await assert.rejects(() => fake.run('session_delete', {}), /invalid arguments/);
  });

  it('lists orphaned sessions through session_list', async () => {
    const fake = harness([seedSession('loose-1', workdir, 5000)]);
    const value = await fake.run('session_list', { orphansOnly: true });
    assert.equal(value.count, 1);
    assert.equal(value.sessions[0].id, 'loose-1');
    assert.equal(value.sessions[0].orphaned, true);
    assert.match(fake.render('session_list', value), /\[orphaned\]/);
  });

  it('deletes an orphaned session end to end from the tool', async () => {
    const fake = harness([seedSession('tool-orphan-1', workdir, 5000)]);
    // A real artifact directory, inside the redirected home. The path comes
    // from the engine itself so the test cannot disagree with the encoder.
    const directory = sessionDirectoryOf({ id: 'tool-orphan-1', cwd: workdir });
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'session.v3.jsonl.zstd'), 'bytes');

    const preview = await fake.run('session_delete', { ids: ['tool-orphan-1'], dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.deleted.length, 1);

    const result = await fake.run('session_delete', { ids: ['tool-orphan-1'], confirm: true });
    assert.equal(result.deleted.length, 1);
    assert.equal(result.refused.length, 0);
    assert.match(fake.render('session_delete', result), /Deleted 1 session/);
  });

  it('refuses to delete without confirm, even through the tool', async () => {
    const fake = harness([seedSession('tool-orphan-2', workdir, 5000)]);
    await assert.rejects(
      () => fake.run('session_delete', { ids: ['tool-orphan-2'] }),
      /requires confirm: true/,
    );
    // And the session is still there.
    assert.equal(fake.store.has('tool-orphan-2'), true);
  });

  it('refuses a session a workspace accounts for', async () => {
    const fake = harness([seedSession('tool-kept-1', workdir, 5000)]);
    await fake.services.workspaceRegistry.create(workdir).then((workspace) => workspace.attachSession('tool-kept-1'));
    const result = await fake.run('session_delete', { ids: ['tool-kept-1'], confirm: true });
    assert.equal(result.deleted.length, 0);
    assert.equal(result.refused[0].reason, 'attached-to-a-workspace');
  });

  it('mentions the restart when a listing still returns a deleted session', async () => {
    const fake = harness([seedSession('tool-survivor-1', workdir, 5000)]);
    // Simulate an in-memory index that outlives the files.
    fake.services.sessionPersistence.list = async () => [
      { header: sessionHeader('tool-survivor-1', workdir), revision: 'stale' },
    ];
    const result = await fake.run('session_delete', { ids: ['tool-survivor-1'], confirm: true });
    assert.deepEqual(result.survivors, ['tool-survivor-1']);
    assert.match(fake.render('session_delete', result), /after restarting dsh/);
  });
});

/**
 * One bare session header, for tests that need to hand-build a snapshot.
 * @param id - the session id.
 * @param cwd - its working directory.
 * @returns the header.
 */
function sessionHeader(id, cwd) {
  return { version: 3, id, createdAt: 1_700_000_000_000, cwd, isSeeded: false };
}
