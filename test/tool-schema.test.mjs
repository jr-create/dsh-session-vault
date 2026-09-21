/**
 * Tool-schema tests.
 *
 * `lib/tool-schema.js` replaces `defineTool` from `@deepseek-ai/dsh-tools` so
 * the plugin has no host imports at all. A reimplementation is only trustworthy
 * if it is provably equivalent, so the central test here compiles the plugin's
 * own declarations and compares them **deep-equal** against a checked-in
 * fixture captured from the real `defineTool`.
 *
 * Regenerating the fixture needs the host package to be resolvable, which it is
 * not from this package's own directory (that is the whole point of the local
 * compiler). The procedure that works:
 *
 *  1. copy `lib/` and `package.json` to a scratch directory;
 *  2. in the scratch copy only, patch `defineTool` to record the options object
 *     it is handed — e.g. insert, right after its opening line,
 *     `(globalThis.__defineToolOptions ??= []).push(options);`
 *     That is the seam that gets at the author-facing declarations, because the
 *     plugin does not export them and the registered definitions are already
 *     compiled;
 *  3. run a script from inside a profile directory (any `~/.dsh/profiles/<x>/`,
 *     where `@deepseek-ai/dsh-tools` does resolve) that imports the scratch
 *     `lib/index.js`, calls `apply` with a stub `tools` registry, runs each
 *     recorded options object through the REAL `defineTool`, and writes
 *     `{ parameters, outputSchema }` per tool to `test/fixtures/define-tool-reference.json`.
 *
 * The checked-in file was produced that way against harness 0.1.5-rc.2.
 * Regenerate it whenever a tool's declaration changes: the comparison below is
 * only worth anything if the reference tracks the real compiler, and a stale
 * fixture would happily pass while the two silently diverge.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { apply } from '../lib/index.js';
import {
  ToolArgumentsError,
  compileParameters,
  compileValue,
  defineTool,
  validateValue,
} from '../lib/tool-schema.js';

/** The schemas the host's `defineTool` produced for these exact declarations. */
const REFERENCE = JSON.parse(
  await readFile(new URL('./fixtures/define-tool-reference.json', import.meta.url), 'utf8'),
);

/**
 * Run `apply` and capture the tool definitions it registers.
 * @returns definitions keyed by tool name.
 */
function captureDefinitions() {
  const registered = [];
  const tools = {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
  };
  const ctx = {
    get: (key) => (key === 'tools' ? tools : undefined),
    effect: (callback) => callback(),
    inject: (names, callback) => {
      if (!names.includes('tools')) return { dispose() {} };
      const child = Object.create(ctx);
      child.tools = tools;
      callback(child);
      return { dispose() {} };
    },
  };
  apply(ctx, undefined);
  return Object.fromEntries(registered.map((definition) => [definition.name, definition]));
}

describe('equivalence with the host defineTool', () => {
  const captured = captureDefinitions();

  it('registered exactly the tools the fixture was captured from', () => {
    assert.deepStrictEqual(Object.keys(captured).sort(), Object.keys(REFERENCE).sort());
  });

  for (const name of Object.keys(REFERENCE)) {
    it(`${name}: compiles parameters identically`, () => {
      assert.deepStrictEqual(captured[name].parameters, REFERENCE[name].parameters);
    });

    it(`${name}: compiles the output schema identically`, () => {
      assert.deepStrictEqual(captured[name].output.schema, REFERENCE[name].outputSchema);
    });
  }
});

describe('compileParameters', () => {
  it('produces an implicit open object root', () => {
    const schema = compileParameters({ a: { type: 'string' } });
    assert.equal(schema.type, 'object');
    // No `additionalProperties` at the root: unknown keys are not a violation.
    assert.equal(Object.hasOwn(schema, 'additionalProperties'), false);
    assert.equal(Object.hasOwn(schema, 'required'), false);
  });

  it('collects inline required markers in declaration order', () => {
    const schema = compileParameters({
      first: { type: 'string', required: true },
      optional: { type: 'string' },
      second: { type: 'number', required: true },
    });
    assert.deepStrictEqual(schema.required, ['first', 'second']);
  });

  it('preserves description, enum, and title', () => {
    const schema = compileParameters({
      mode: { type: 'string', enum: ['skip', 'rename'], description: 'pick one', title: 'Mode' },
    });
    assert.deepStrictEqual(schema.properties.mode, {
      type: 'string',
      enum: ['skip', 'rename'],
      description: 'pick one',
      title: 'Mode',
    });
  });
});

describe('compileValue', () => {
  it('emits explicit openness for object nodes', () => {
    assert.equal(compileValue({ type: 'object', additionalProperties: false }).additionalProperties, false);
    assert.equal(compileValue({ type: 'object', additionalProperties: true }).additionalProperties, true);
    // Anything not `true` is closed, so a missing marker cannot silently open a node.
    assert.equal(compileValue({ type: 'object' }).additionalProperties, false);
  });

  it('omits items when an array declares none', () => {
    assert.deepStrictEqual(compileValue({ type: 'array' }), { type: 'array' });
  });

  it('rejects an unsupported node type loudly', () => {
    assert.throws(() => compileValue({ type: 'nonsense' }), /unsupported schema node type/);
  });
});

describe('validateValue', () => {
  const parameters = compileParameters({
    required_string: { type: 'string', required: true },
    count: { type: 'integer' },
    mode: { type: 'string', enum: ['skip', 'rename'] },
    ids: { type: 'array', items: { type: 'string' } },
    nested: {
      type: 'object',
      additionalProperties: false,
      properties: { inner: { type: 'boolean', required: true } },
    },
  });

  it('accepts a well-formed call', () => {
    assert.deepStrictEqual(
      validateValue(parameters, {
        required_string: 'x',
        count: 3,
        mode: 'rename',
        ids: ['a', 'b'],
        nested: { inner: true },
      }),
      [],
    );
  });

  it('accepts an empty call when nothing is required', () => {
    assert.deepStrictEqual(validateValue(compileParameters({ a: { type: 'string' } }), {}), []);
  });

  it('reports a missing required property', () => {
    const violations = validateValue(parameters, {});
    assert.deepStrictEqual(violations, ['value.required_string is required']);
  });

  it('reports a wrong scalar type with its path', () => {
    const violations = validateValue(parameters, { required_string: 42 });
    assert.deepStrictEqual(violations, ['value.required_string must be a string']);
  });

  it('reports a non-integer for an integer node', () => {
    assert.deepStrictEqual(
      validateValue(parameters, { required_string: 'x', count: 1.5 }),
      ['value.count must be an integer'],
    );
  });

  it('reports a value outside an enum', () => {
    const violations = validateValue(parameters, { required_string: 'x', mode: 'overwrite' });
    assert.deepStrictEqual(violations, ['value.mode must be one of "skip", "rename"']);
  });

  it('reports the index of a bad array element', () => {
    const violations = validateValue(parameters, { required_string: 'x', ids: ['ok', 7] });
    assert.deepStrictEqual(violations, ['value.ids[1] must be a string']);
  });

  it('reports a missing nested required property', () => {
    const violations = validateValue(parameters, { required_string: 'x', nested: {} });
    assert.deepStrictEqual(violations, ['value.nested.inner is required']);
  });

  it('reports an unknown property on a closed object', () => {
    const violations = validateValue(parameters, {
      required_string: 'x',
      nested: { inner: true, extra: 1 },
    });
    assert.deepStrictEqual(violations, ['value.nested.extra is not an allowed property']);
  });

  it('allows unknown properties on the open parameter root', () => {
    assert.deepStrictEqual(validateValue(parameters, { required_string: 'x', surprise: 1 }), []);
  });

  it('treats an explicit undefined as an absent optional property', () => {
    assert.deepStrictEqual(validateValue(parameters, { required_string: 'x', count: undefined }), []);
  });
});

describe('defineTool', () => {
  /**
   * Build a trivial tool around a recording execute.
   * @returns the definition plus its call log.
   */
  function makeTool() {
    const calls = [];
    const definition = defineTool({
      name: 'demo',
      description: 'a demo tool',
      parameters: { input: { type: 'string', required: true } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { echoed: { type: 'string', required: true } },
        },
        render: (_args, value) => [{ type: 'text', text: value.echoed }],
      },
      async execute(args) {
        calls.push(args);
        return { echoed: args.input };
      },
    });
    return { definition, calls };
  }

  it('publishes the compiled schemas', () => {
    const { definition } = makeTool();
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.output.schema.additionalProperties, false);
  });

  it('runs execute and returns its canonical value', async () => {
    const { definition } = makeTool();
    assert.deepStrictEqual(await definition.execute({ input: 'hi' }, {}), { echoed: 'hi' });
  });

  it('refuses invalid arguments before execute runs', async () => {
    const { definition, calls } = makeTool();
    await assert.rejects(() => definition.execute({}, {}), ToolArgumentsError);
    assert.deepStrictEqual(calls, [], 'execute must not run on invalid arguments');
  });

  it('tags argument failures with the host INVALID_ARGS code', async () => {
    const { definition } = makeTool();
    await assert.rejects(
      () => definition.execute({ input: 5 }, {}),
      (error) => error.code === 'INVALID_ARGS' && /invalid arguments/.test(error.message),
    );
  });

  it('renders through the declared projection', () => {
    const { definition } = makeTool();
    const blocks = definition.output.render({ input: 'hi' }, { echoed: 'hi' });
    assert.deepStrictEqual(blocks, [{ type: 'text', text: 'hi' }]);
  });

  it('rejects a malformed definition at definition time', () => {
    assert.throws(() => defineTool({ name: '', parameters: {}, output: { schema: {}, render() {} }, execute() {} }), /name/);
    assert.throws(
      () => defineTool({ name: 'x', parameters: {}, output: { schema: {}, render() {} } }),
      /execute must be a function/,
    );
    assert.throws(
      () => defineTool({ name: 'x', parameters: {}, output: { schema: {} }, execute() {} }),
      /render must be a function/,
    );
  });
});
