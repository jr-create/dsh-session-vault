/**
 * The harness home path, resolved without importing a host package.
 *
 * `@deepseek-ai/dsh-home-paths` is tiny and does exactly this, but a `link:`-
 * installed plugin cannot resolve it (see the header of `./tool-schema.js` for
 * the full explanation). The resolution rule is a stable, documented contract
 * — highest precedence first: an explicit path, `$DSH_HOME`, then `~/.dsh` —
 * so reproducing it here is safe, and it is the last thing standing between
 * this package and having no dependencies at all.
 *
 * @module dsh-session-vault/home
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Environment variable that overrides the default harness home. */
const DSH_HOME_ENV = 'DSH_HOME';
/** Directory name for the default harness home under the OS home. */
const DSH_HOME_DIR_NAME = '.dsh';

/**
 * Expand `~`, `~/`, and `~\` against the operating-system home.
 * @param path - a configured path that may start with a tilde prefix.
 * @returns the expanded path, or the original value when no prefix is present.
 */
function expandHomePath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Resolve the single-root harness home.
 *
 * An empty or whitespace-only `$DSH_HOME` counts as unset, so a blank override
 * never resolves the home to the current working directory.
 *
 * @param configured - explicit override, which has the highest precedence.
 * @param env - environment mapping to read `DSH_HOME` from.
 * @returns the normalized absolute harness home.
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env[DSH_HOME_ENV];
  const useEnv = fromEnv !== undefined && fromEnv.trim().length > 0;
  const chosen = configured ?? (useEnv ? fromEnv : join(homedir(), DSH_HOME_DIR_NAME));
  return resolve(expandHomePath(chosen));
}

/**
 * Join path segments onto the resolved harness home.
 * @param segments - segments appended to the harness home; none returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments) {
  return join(resolveDshHome(), ...segments);
}
