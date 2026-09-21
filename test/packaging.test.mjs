/**
 * Packaging tests — the guard against the failure that broke `dsh web`.
 *
 * A plugin installed with `link:` is imported from wherever it happens to live.
 * Node resolves that module's own bare imports by walking up from *its real
 * path*, which is outside `~/.dsh/profiles/**` where the harness keeps its
 * shared `node_modules`. So any static `@deepseek-ai/*` import fails to
 * resolve — and because it fails at module-import time, the whole plugin tree
 * fails and the harness refuses to boot. Not a degraded feature: no `dsh web`
 * at all.
 *
 * These assertions make that impossible to reintroduce. The load test is the
 * load-bearing one: it does not pattern-match the source, it actually imports
 * every module with no `node_modules` anywhere in the package, so a stray host
 * import fails here instead of on a user's machine.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const PACKAGE_ROOT = new URL('../', import.meta.url);
const LIB_DIR = new URL('../lib/', import.meta.url);

/**
 * Read the package manifest.
 * @returns the parsed manifest.
 */
async function readManifest() {
  return JSON.parse(await readFile(new URL('package.json', PACKAGE_ROOT), 'utf8'));
}

describe('the package resolves nothing outside itself', () => {
  it('ships no node_modules that could shadow the host install', () => {
    // The original defect: a hand-made node_modules for local tests was copied
    // between machines, shadowed the install closure, and — containing only
    // partial packages — made `@deepseek-ai/dsh-tools` fail to load its own
    // dependencies.
    assert.equal(
      existsSync(new URL('node_modules', PACKAGE_ROOT)),
      false,
      'the package must not ship a node_modules directory',
    );
  });

  it('loads every host-half module with no node_modules present', async () => {
    // The real proof. Each of these is imported for real; a remaining host
    // import would reject with ERR_MODULE_NOT_FOUND.
    const modules = ['archive.js', 'engine.js', 'home.js', 'http.js', 'index.js', 'tool-schema.js'];
    for (const module of modules) {
      await assert.doesNotReject(
        () => import(new URL(module, LIB_DIR).href),
        `lib/${module} must load without any host package`,
      );
    }
  });

  it('declares no dependencies of any kind', async () => {
    const manifest = await readManifest();
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
      assert.equal(manifest[field], undefined, `${field} must stay absent`);
    }
  });

  // There is deliberately no source-pattern assertion here for "no bare
  // specifiers". It was tried and it is the wrong tool: it cannot tell an
  // import from the same text inside a doc comment, and it would have to
  // special-case the browser bundle's `require('react')`, which is a
  // module-loader external rather than a Node import.
  //
  // The two tests that actually cover this are behavioural and cannot be
  // fooled by formatting:
  //   - the load test above imports every host module for real, so a stray
  //     host import rejects with ERR_MODULE_NOT_FOUND — exactly the failure
  //     that took `dsh web` down;
  //   - `client.test.mjs` runs the browser bundle with a `require` that throws
  //     on anything but `react`.

  it('keeps the browser module-graph declaration intact', async () => {
    const manifest = await readManifest();
    // Unlike a Node import, `dsh.client.inject` is read by the host's
    // client-modules service to order browser bundles. These names must stay.
    assert.equal(manifest.dsh.client.platform, 'web');
    assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'));
  });
});

describe('the manifest describes real files', () => {
  it('resolves every exports target', async () => {
    const manifest = await readManifest();
    for (const [key, target] of Object.entries(manifest.exports)) {
      const relative = typeof target === 'string' ? target : target.default;
      const resolved = new URL(relative.replace(/^\.\//, ''), PACKAGE_ROOT);
      assert.equal(
        (await stat(fileURLToPath(resolved))).isFile(),
        true,
        `exports["${key}"] -> ${relative} must exist`,
      );
    }
  });

  it('ships every file the plugin needs at runtime', async () => {
    const manifest = await readManifest();
    for (const required of ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
      assert.ok(manifest.files.includes(required), `${required} must be in files[]`);
    }
  });

  it('points dsh.bundle.patch at the shipped patch file', async () => {
    const manifest = await readManifest();
    const resolved = new URL(manifest.dsh.bundle.patch.replace(/^\.\//, ''), PACKAGE_ROOT);
    assert.equal((await stat(fileURLToPath(resolved))).isFile(), true);
  });
});
