/**
 * Browser-half tests.
 *
 * `lib/client.js` is not a module: DSH serves it as a plain script that
 * registers a lazy CommonJS factory with `window.__ModuleLoader__`. So the
 * only honest way to test it in Node is to reproduce that little contract —
 * a `window` with a `load` sink, a `require` that answers `react`, and a
 * minimal `document` — and then run the real file in a `vm` context.
 *
 * This catches the failures that would otherwise only show up as a blank
 * settings page: a wrong bundle id (the loader matches it against the entry it
 * fetched), a syntax error, a factory that never runs, or a registration that
 * targets the wrong slot with the wrong options.
 */

import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { describe, it } from 'node:test';

import { createRoutes, ROUTE_PREFIX } from '../lib/http.js';

/** The package name; the bundle id must equal it. */
const PACKAGE_NAME = 'dsh-session-vault';

const PACKAGE_ROOT = new URL('../', import.meta.url);

/**
 * Read the package manifest.
 * @returns the parsed manifest.
 */
async function readManifest() {
  return JSON.parse(await readFile(new URL('package.json', PACKAGE_ROOT), 'utf8'));
}

/**
 * A React stand-in good enough for module evaluation. None of the hooks are
 * called here — the section only renders inside the real renderer — but the
 * bundle destructures React at factory time, so the shape must exist.
 * @returns a minimal React namespace.
 */
function reactStub() {
  const createElement = (type, props) => ({ type, props });
  return {
    createElement,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
  };
}

/**
 * Load the real client bundle under a reproduced module-loader contract.
 * @returns the captured registration plus the evaluated exports.
 */
async function loadClientBundle() {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  let captured;
  const appended = [];

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          assert.equal(captured, undefined, 'the bundle must register exactly one factory');
          captured = registration;
        },
      },
    },
    document: {
      createElement: () => ({ setAttribute() {}, textContent: '', remove() {}, style: {} }),
      head: { appendChild: (node) => appended.push(node) },
      body: { appendChild() {}, removeChild() {} },
    },
    navigator: { language: 'zh-CN', languages: ['zh-CN', 'en'] },
    console,
    fetch: async () => {
      throw new Error('the client half must not fetch during module evaluation');
    },
  };
  createContext(sandbox);
  runInContext(source, sandbox, { filename: 'lib/client.js' });

  assert.ok(captured !== undefined, 'the bundle never called window.__ModuleLoader__.load');
  const previousWindow = globalThis.window;
  globalThis.window = sandbox.window;
  let exports;
  try {
    exports = captured.factory((specifier) => {
      if (specifier === 'react') return reactStub();
      throw new Error(`the bundle required an unexpected external module: ${specifier}`);
    });
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  return { captured, exports, appended };
}

/**
 * Run the bundle's `apply` against a captured client context.
 * @returns what the plugin registered, and the stylesheet it installed.
 */
async function runApply() {
  const { exports, appended } = await loadClientBundle();
  const registered = [];
  const injections = [];
  const effects = [];
  const ctx = {
    effect(callback, label) {
      effects.push(label);
      return callback();
    },
    slots: {
      inject(name, callback) {
        injections.push(name);
        return callback();
      },
      register(options, component) {
        registered.push({ options, component });
        return () => {};
      },
    },
  };
  exports.apply(ctx);
  // `installStyles` appends one <style> node whose textContent is the
  // stylesheet the plugin actually ships.
  return { registered, injections, effects, css: appended[0] && appended[0].textContent };
}

describe('manifest contract', () => {
  it('declares a web client half', async () => {
    const manifest = await readManifest();
    // `client-modules` scans loader entries for exactly this declaration and
    // skips any entry whose platform is not "web".
    assert.equal(manifest.dsh.client.platform, 'web');
  });

  it('keeps the package name and the bundle id identical', async () => {
    const manifest = await readManifest();
    const { captured } = await loadClientBundle();
    // The loader matches a served bundle against the entry it fetched by id;
    // these two drifting apart yields a silent no-op in the browser.
    assert.equal(captured.id, manifest.name);
  });

  it('resolves exports["./client"] to a file that exists', async () => {
    const manifest = await readManifest();
    const target = manifest.exports['./client'];
    assert.equal(typeof target, 'string');
    const resolved = new URL(target.replace(/^\.\//, ''), PACKAGE_ROOT);
    assert.equal((await stat(fileURLToPath(resolved))).isFile(), true);
  });

  it('resolves exports["."] to the host entry that exists', async () => {
    const manifest = await readManifest();
    const resolved = new URL(manifest.exports['.'].replace(/^\.\//, ''), PACKAGE_ROOT);
    assert.equal((await stat(fileURLToPath(resolved))).isFile(), true);
  });

  it('declares dsh.bundle.patch and ships that file', async () => {
    const manifest = await readManifest();
    // Without this field the CLI treats the package as a plain dependency and
    // never appends it to the profile's bundle list.
    const patch = manifest.dsh.bundle.patch;
    assert.equal(typeof patch, 'string');
    const resolved = new URL(patch.replace(/^\.\//, ''), PACKAGE_ROOT);
    assert.equal((await stat(fileURLToPath(resolved))).isFile(), true);
  });

  it('declares only string package names as client dependencies', async () => {
    const manifest = await readManifest();
    for (const entry of manifest.dsh.client.inject) {
      assert.equal(typeof entry, 'string');
      assert.ok(entry.length > 0);
    }
  });

  it('does not list its own package as an external', async () => {
    const manifest = await readManifest();
    // The module graph rejects a row that requests a module it answers itself.
    const external = manifest.dsh.client.external ?? [];
    assert.ok(!external.includes(manifest.name));
  });
});

describe('client bundle contract', () => {
  it('registers one factory under the package name', async () => {
    const { captured } = await loadClientBundle();
    // The loader matches a served bundle against the entry it fetched by id,
    // so a mismatch here means the page loads the script and nothing happens.
    assert.equal(captured.id, PACKAGE_NAME);
    assert.equal(typeof captured.factory, 'function');
  });

  it('requires react and nothing else', async () => {
    // Any other bare specifier would have to be declared in dsh.client.external
    // or bundled; requiring one that is neither fails at load time.
    await assert.doesNotReject(() => loadClientBundle());
  });

  it('exports apply and inject', async () => {
    const { exports } = await loadClientBundle();
    assert.equal(typeof exports.apply, 'function');
    // Spread first: the bundle builds this array inside the vm realm, so its
    // prototype is not this realm's Array.prototype.
    assert.deepStrictEqual([...exports.inject], ['slots']);
  });

  it('touches no network during module evaluation', async () => {
    // The factory is lazy by design; anything eager here would run on every
    // page load, before the user ever opens the settings page.
    await assert.doesNotReject(() => loadClientBundle());
  });
});

describe('client apply', () => {
  it('registers into the settings.section slot', async () => {
    const { injections } = await runApply();
    assert.deepEqual(injections, ['settings.section']);
  });

  it('registers exactly one section under its own id', async () => {
    const { registered } = await runApply();
    assert.equal(registered.length, 1);
    const { options, component } = registered[0];
    assert.equal(options.name, 'settings.section');
    // Reusing a shipped id would replace that section instead of adding one.
    assert.equal(options.id, 'session-vault');
    assert.equal(typeof options.order, 'number');
    assert.equal(typeof component, 'function');
  });

  it('supplies a label the shell can re-read on locale change', async () => {
    const { registered } = await runApply();
    const label = registered[0].options.label;
    assert.equal(typeof label, 'function');
    assert.equal(typeof label(), 'string');
    assert.ok(label().length > 0);
  });

  it('orders itself after the shipped sections', async () => {
    const { registered } = await runApply();
    // Shipped sections occupy 0-20 and the other management plugins sit at 60.
    assert.ok(registered[0].options.order >= 60);
  });

  it('installs its stylesheet as a plugin-owned effect', async () => {
    const { effects } = await runApply();
    assert.ok(effects.includes('dsh-session-vault: styles'));
  });

  it('places its own order alongside, not on top of, other plugins', async () => {
    const { registered } = await runApply();
    // config-manager and dsh-plugin both use 60; a distinct value keeps the
    // nav order deterministic rather than dependent on activation order.
    assert.equal(registered[0].options.order, 62);
  });
});

describe('host route contract', () => {
  // The browser half and the host half are two files that agree on a route
  // table by convention alone. A renamed or mistyped endpoint does not fail to
  // compile anywhere: the fetch simply falls through to the framework's /api
  // channel and comes back as a bare-text 401, which is exactly the shape of a
  // bug that already shipped once. So the agreement is asserted instead.

  it('only calls endpoints the host actually registers', async () => {
    const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
    const called = [...source.matchAll(/(?:api|postJson)\(\s*'(\/[^']*)'/g)].map((match) => match[1]);
    assert.ok(called.length >= 8, `expected several endpoints, found ${called.length}`);

    const ctx = { get: () => undefined };
    const registered = new Set(
      createRoutes({ ctx, generator: { name: 'dsh-session-vault', version: '0.0.0' } })
        .map((route) => route.path.slice(ROUTE_PREFIX.length)),
    );

    for (const target of called) {
      const pathname = target.split('?')[0];
      assert.ok(
        registered.has(pathname),
        `the client calls ${pathname} but the host registers no such route`,
      );
    }
  });

  it('wires the destructive cleanup panel to its endpoints', async () => {
    const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
    // A tab that silently lost its wiring would otherwise just look empty.
    assert.match(source, /postJson\('\/purge'/);
    // The scope travels as a query parameter, so the literal is a prefix.
    assert.match(source, /api\('\/orphans/);
    assert.match(source, /id: 'cleanup'/);
  });

  it('keeps the archived scope reachable when the deletable list is empty', async () => {
    // Archived sessions are the only way the list can be empty while unmounted
    // sessions still exist, and they are exactly what the Export tab shows for
    // "no workspace". So the control that reveals them has to render in the
    // empty branch too, or that state is a dead end — which is the bug this
    // guards. Asserting on the shared node rather than a variable name keeps
    // the check about behaviour instead of about how it is spelled.
    const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
    assert.match(source, /var scopeBar = h\(/);
    assert.match(source, /scopeChip\('archived'/);
    assert.match(source, /\/orphans\?includeArchived=/);

    // One definition of the scope bar, rendered from both branches.
    const renders = source.match(/^\s*scopeBar,\s*$/gm) ?? [];
    assert.equal(renders.length, 2, `expected the scope bar in both branches, saw ${renders.length}`);
  });

  it('offers the never-used bucket as its own scope, not as an orphan', async () => {
    // A session created and abandoned is *mounted*, so it belongs to no orphan
    // bucket — folding it into the unmounted count is what would break the
    // reconciliation with the Export tab again. It gets its own chip.
    const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
    assert.match(source, /scopeChip\('empty'/);
    assert.match(source, /includeEmpty=/);
    assert.match(source, /emptyCount/);
    // The opt-in travels to both listing and deleting, or a row could be shown
    // and then refused.
    assert.match(source, /includeEmpty: includeEmpty/);
  });

  it('asks the host for the unmounted set rather than re-deriving it', async () => {
    // The Export tab once filtered on `workspace === null` (the registry's
    // view) while the host filtered on `mounted` (the registry plus the durable
    // account). The two disagreed silently. Both now ask the host.
    const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
    assert.match(source, /function unmountedOf\(session\)/);
    assert.match(source, /typeof session\.mounted === 'boolean'/);
    // No leftover hand-rolled predicates over `workspace` for this question.
    assert.doesNotMatch(source, /function orphanOnly\(s\) \{ return s\.workspace === null/);
    assert.doesNotMatch(source, /function attachedOnly\(s\) \{ return s\.workspace !== null/);
  });

  it('distinguishes an unused session from a merely untitled one', async () => {
    // Both render as a title-less row. They are not the same state: a session
    // that recorded only its own setup events was never used, while one with a
    // conversation whose opening message yields no title is merely unnamed.
    const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
    assert.match(source, /function titleText\(session\)/);
    assert.match(source, /session\.conversation === false/);
  });
});

describe('stylesheet contract', () => {
  // These pin the two ways this stylesheet shipped visually broken, neither of
  // which any amount of host-side testing would have caught:
  //
  //  1. A `var(--dsw-…)` without a fallback is invalid at computed-value time
  //     when the token is absent, so the declaration silently drops to its
  //     initial value instead of degrading.
  //  2. `--dsw-alias-brand-primary` is *white* in the dark theme. Pairing a
  //     brand-filled surface with a literal `color:#fff` therefore renders
  //     invisible white-on-white text. The paired foreground token is the only
  //     correct partner.

  it('gives every theme token a fallback', async () => {
    const { css } = await runApply();
    assert.ok(typeof css === 'string' && css.length > 0, 'no stylesheet was installed');
    const bare = [...css.matchAll(/var\((--dsw-[a-z0-9-]+)\)/g)].map((match) => match[1]);
    assert.deepEqual(bare, [], `used without a fallback: ${[...new Set(bare)].join(', ')}`);
  });

  it('routes every theme reference through a locally-named property', async () => {
    const { css } = await runApply();
    // All `--dsw-` references should live in the one `.dsv-root` alias block,
    // so a theme change is a single place to look.
    const ruleBodies = css.split('}').filter((chunk) => !chunk.includes('.dsv-root'));
    const strays = ruleBodies.flatMap((chunk) => [...chunk.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]));
    assert.deepEqual(strays, [], `theme tokens used outside the alias block: ${[...new Set(strays)].join(', ')}`);
  });

  it('pairs the primary button fill with the foreground token, not a literal', async () => {
    const { css } = await runApply();
    const rule = css.match(/\.dsv-btn\[data-variant="primary"\]\{([^}]*)\}/);
    assert.ok(rule !== null, 'the primary button rule is missing');
    assert.match(rule[1], /background:var\(--dsv-accent-fill\)/);
    assert.match(rule[1], /color:var\(--dsv-accent-fg\)/);
    assert.doesNotMatch(rule[1], /#fff/i, 'a literal white foreground is invisible on a white brand fill');
  });

  it('resolves the accent foreground to the paired theme token', async () => {
    const { css } = await runApply();
    assert.match(css, /--dsv-accent-fg:var\(--dsw-alias-label-primary-foreground,/);
    // The fill token is the shipped primary-button fill, which itself aliases
    // the brand colour; using the fill keeps light and dark in step.
    assert.match(css, /--dsv-accent-fill:var\(--dsw-alias-button-primary-fill,/);
  });

  it('styles the scope selector and the warning badges', async () => {
    // These carry the explanation for why a stored session is absent from the
    // sidebar; unstyled, the reason becomes invisible again.
    const { css } = await runApply();
    for (const selector of [
      '.dsv-scopes{',
      '.dsv-scope{',
      '.dsv-scope[data-active="true"]{',
      '.dsv-tag[data-kind="warn"]{',
    ]) {
      assert.ok(css.includes(selector), `missing stylesheet rule ${selector}`);
    }
  });
});

describe('import flow structure', () => {
  // This package has no React or DOM dependency on purpose — a node_modules is
  // what broke the plugin on a second machine — so these cannot be render
  // tests. They are narrow structural guards for one specific lifecycle defect
  // that a render test would have caught, and they say so rather than
  // pretending to be more than they are.
  //
  // The defect: uploading an archive calls back to refresh the archive list,
  // the refresh toggled a flag the panels were gated on, the import panel
  // unmounted, and its panel-local selection was destroyed a tick after the
  // user made it. On a machine with no existing archives — where the file
  // picker is the only way in, because the "pick an existing archive" dropdown
  // is not rendered — the panel came back empty and the drop looked inert.

  /** The client bundle's source. */
  async function clientSource() {
    return readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  }

  it('never gates a panel on an in-flight fetch', async () => {
    const source = await clientSource();
    assert.doesNotMatch(
      source,
      /!\s*loading\s*&&\s*tab/,
      'panels must be gated on "first load finished", not on "a fetch is in flight": '
      + 'a background refresh would unmount the open panel and discard the user\'s work',
    );
  });

  it('owns the import selection above the panel it renders in', async () => {
    const source = await clientSource();
    assert.doesNotMatch(
      source,
      /useState\(\s*props\.initialFile/,
      'the selected archive must be owned by the section: a panel-local copy is '
      + 'destroyed by any remount, including the refresh that follows an upload',
    );
  });

  it('keeps the file input outside the element whose click opens it', async () => {
    const source = await clientSource();
    // A file input's synthetic click bubbles, so nesting it inside the onClick
    // that calls `.click()` re-enters the handler.
    const dropStart = source.indexOf("className: 'dsv-drop'");
    const dropEnd = source.indexOf('h(\'input\'', dropStart);
    const inputEnd = source.indexOf('}),', dropEnd);
    assert.ok(dropStart !== -1 && dropEnd !== -1, 'the drop target and its input must both exist');
    const dropBlock = source.slice(dropStart, dropEnd);
    assert.ok(
      !dropBlock.includes("type: 'file'"),
      'the file input must not be nested inside the drop target',
    );
    assert.ok(source.slice(dropEnd, inputEnd).includes("type: 'file'"));
  });

  it('does not filter the picker by extension', async () => {
    // `accept` makes browsers grey out non-matching files, so a renamed archive
    // becomes unselectable and the picker looks broken even though it opened.
    const source = await clientSource();
    assert.doesNotMatch(source, /accept:\s*['"]\.dshsession/, 'the picker must accept any file');
  });
});
