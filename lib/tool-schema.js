/**
 * A minimal, dependency-free replacement for `defineTool` from
 * `@deepseek-ai/dsh-tools`.
 *
 * ## Why this exists
 *
 * A plugin installed with `dsh plugin --profile web add link:<path>` is
 * imported from the linked directory. Node resolves that module's own bare
 * imports by walking up from *its real path* — and a linked directory can live
 * anywhere (`D:\src\...`, `C:\Users\me\Downloads\...`), which is not under
 * `~/.dsh/profiles/**` where the harness keeps its shared `node_modules`. So
 * `import '@deepseek-ai/dsh-tools'` from such a plugin cannot resolve, and
 * because the failure happens at module-import time the *entire plugin tree*
 * fails to load and `dsh web` refuses to boot.
 *
 * That is not a packaging accident to work around; it is the load-bearing
 * constraint on a portable DSH plugin. Depending on nothing outside this
 * package is what lets it be linked from anywhere and copied between machines.
 * `lib/http.js` and `lib/engine.js` are already dependency-free for the same
 * reason; this module removes the last two host imports.
 *
 * ## What it reproduces
 *
 * Only the subset this plugin declares — string/number/integer/boolean/array/
 * object nodes, an inline `required: true` marker, and `enum`. The compiled
 * output is verified byte-for-byte against schemas produced by the real
 * `defineTool`; see `test/tool-schema.test.mjs` and its fixture.
 *
 * The author-facing DSL is kept (rather than pasting compiled JSON Schema into
 * the source) so the tool declarations stay readable. `required: true` remains
 * an inline property annotation, and the parameter map is an implicit open
 * object root — both matching the host dialect.
 *
 * @module dsh-session-vault/tool-schema
 */

/**
 * Raised when model-supplied arguments fail the declared parameter schema.
 *
 * Carries the same `INVALID_ARGS` code the host's `ToolArgsError` uses, so any
 * downstream handling that keys off the code behaves identically.
 */
export class ToolArgumentsError extends Error {
  /**
   * @param violations - path-qualified descriptions of what was wrong.
   */
  constructor(violations) {
    super(`invalid arguments: ${violations.join('; ')}`);
    this.name = 'ToolArgumentsError';
    this.code = 'INVALID_ARGS';
    this.violations = violations;
  }
}

/** Schema node types this compiler understands. */
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean']);

/**
 * Compile one author-facing value node.
 * @param spec - the DSL node.
 * @returns raw JSON Schema.
 * @throws when the node is not a shape this compiler supports.
 */
export function compileValue(spec) {
  if (spec === null || typeof spec !== 'object') {
    throw new TypeError(`schema node must be an object, received ${typeof spec}`);
  }
  const out = {};
  if (typeof spec.description === 'string') out.description = spec.description;
  if (typeof spec.title === 'string') out.title = spec.title;
  if (spec.default !== undefined) out.default = spec.default;

  if (SCALAR_TYPES.has(spec.type)) {
    out.type = spec.type;
    if (Array.isArray(spec.enum)) out.enum = [...spec.enum];
    if (spec.const !== undefined) out.const = spec.const;
    return out;
  }

  if (spec.type === 'array') {
    out.type = 'array';
    // An omitted `items` accepts any lossless JSON item, matching the host.
    if (spec.items !== undefined) out.items = compileValue(spec.items);
    return out;
  }

  if (spec.type === 'object') {
    out.type = 'object';
    // Openness is explicit on every object node: an accidental JSON Schema
    // default would silently admit or reject unknown keys.
    out.additionalProperties = spec.additionalProperties === true;
    if (spec.properties !== undefined) {
      const compiled = compilePropertyMap(spec.properties);
      out.properties = compiled.properties;
      if (compiled.required !== undefined) out.required = compiled.required;
    }
    return out;
  }

  throw new TypeError(
    `unsupported schema node type ${JSON.stringify(spec.type)}; expected one of `
    + `${[...SCALAR_TYPES].join('/')}/array/object`,
  );
}

/**
 * Compile an implicit property map, collecting inline `required: true` markers.
 * @param spec - property name to DSL node.
 * @returns `{ properties, required }`, where `required` is omitted when empty.
 */
function compilePropertyMap(spec) {
  const properties = {};
  const required = [];
  for (const key of Object.keys(spec)) {
    const node = spec[key];
    properties[key] = compileValue(node);
    if (node.required === true) required.push(key);
  }
  return { properties, required: required.length > 0 ? required : undefined };
}

/**
 * Compile a parameter map into its raw, object-rooted JSON Schema.
 *
 * The root is deliberately open (`additionalProperties` is not emitted), which
 * is what "implicit open object root" means: unknown keys are not a schema
 * violation.
 *
 * @param spec - per-property parameter definitions.
 * @returns raw JSON Schema for the parameter object.
 */
export function compileParameters(spec) {
  const compiled = compilePropertyMap(spec);
  const schema = { type: 'object', properties: compiled.properties };
  if (compiled.required !== undefined) schema.required = compiled.required;
  return schema;
}

/**
 * Validate one value against a schema this module compiled.
 * @param schema - raw JSON Schema from {@link compileValue} or {@link compileParameters}.
 * @param value - the candidate value.
 * @param path - path prefix used in violation messages.
 * @returns path-qualified violations; empty means valid.
 */
export function validateValue(schema, value, path = 'value') {
  const violations = [];
  collect(schema, value, path, violations);
  return violations;
}

/**
 * Walk one value against one schema node, appending violations.
 * @param schema - the schema node.
 * @param value - the candidate value.
 * @param path - path prefix for messages.
 * @param out - accumulator.
 */
function collect(schema, value, path, out) {
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    out.push(`${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`);
    return;
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') out.push(`${path} must be a string`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) out.push(`${path} must be a number`);
      return;
    case 'integer':
      if (!Number.isSafeInteger(value)) out.push(`${path} must be an integer`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') out.push(`${path} must be a boolean`);
      return;
    case 'array':
      if (!Array.isArray(value)) {
        out.push(`${path} must be an array`);
        return;
      }
      if (schema.items !== undefined) {
        value.forEach((item, index) => collect(schema.items, item, `${path}[${index}]`, out));
      }
      return;
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        out.push(`${path} must be an object`);
        return;
      }
      for (const key of schema.required ?? []) {
        if (!Object.hasOwn(value, key)) out.push(`${path}.${key} is required`);
      }
      const properties = schema.properties ?? {};
      for (const key of Object.keys(properties)) {
        // An explicit `undefined` is treated as absent so an omitted optional
        // property never fails its own type check.
        if (Object.hasOwn(value, key) && value[key] !== undefined) {
          collect(properties[key], value[key], `${path}.${key}`, out);
        }
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(properties, key)) out.push(`${path}.${key} is not an allowed property`);
        }
      }
      return;
    }
    default:
      // `json` nodes and unknown types accept anything, matching the host's
      // annotation-only projection.
      return;
  }
}

/**
 * Build a registry-ready tool definition from author-facing options.
 *
 * Shaped like the host's `defineTool`: it compiles both schemas and wraps
 * `execute` so every accepted call has already passed argument validation.
 *
 * @param options - tool name, description, parameter map, output schema+render, and execute.
 * @returns the tool definition to hand to `ctx.tools.register`.
 */
export function defineTool(options) {
  if (typeof options?.name !== 'string' || options.name.length === 0) {
    throw new TypeError('defineTool requires a non-empty name');
  }
  if (typeof options.execute !== 'function') {
    throw new TypeError(`defineTool(${options.name}): execute must be a function`);
  }
  if (typeof options.output?.render !== 'function') {
    throw new TypeError(`defineTool(${options.name}): output.render must be a function`);
  }

  const parameters = compileParameters(options.parameters ?? {});
  const outputSchema = compileValue(options.output.schema);
  const validate = (args) => validateValue(parameters, args);

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
    },
    async execute(args, exec) {
      const violations = validate(args);
      if (violations.length > 0) throw new ToolArgumentsError(violations);
      return options.execute(args, exec);
    },
  };
}
