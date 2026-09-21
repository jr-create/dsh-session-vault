/**
 * dsh-session-vault — host half.
 *
 * Contributes two things to the host composition:
 *
 *  1. The `/api/dsh-session-vault/*` route family the browser half calls.
 *  2. Five model-facing tools, so an agent can manage sessions without the GUI:
 *     `session_list`, `session_export`, `session_import`,
 *     `session_archive_inspect`, `session_delete`.
 *
 * Neither is a hard dependency. `webServer` only exists in Web deployments and
 * `workspaceRegistry` only in profiles that compose a workspace; both are read
 * with `ctx.get()` at call time, so this plugin still loads — and still offers
 * its tools — in a profile that has neither.
 *
 * @module dsh-session-vault
 */

import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { defineTool } from './tool-schema.js';

import { createRoutes } from './http.js';
import {
  defaultExportDir,
  exportSessions,
  importSessions,
  inspectArchive,
  listSessions,
  purgeSessions,
  suggestArchiveName,
} from './engine.js';

/** Stable loader identity; must match the `cordis.patch.yml` row id. */
export const name = 'session-vault';

/**
 * Hard service dependencies: none.
 *
 * `sessionPersistence`, `workspaceRegistry`, and `webServer` are each absent
 * from some valid profile, and a plugin that waited on all three would simply
 * never load in those. Every service is therefore read through `service(ctx, …)`
 * at call time, and a missing one degrades to a clear error or a skipped
 * contribution rather than a stalled fiber.
 */
export const inject = [];

/**
 * Read an optional host service without declaring a hard dependency.
 * @param ctx - the plugin context.
 * @param key - exact service name.
 * @returns the service, or `undefined`.
 */
function service(ctx, key) {
  return typeof ctx.get === 'function' ? ctx.get(key) : undefined;
}

/**
 * A logger that exists even when the profile composes none.
 * @param ctx - the plugin context.
 * @returns an object with `info` / `warn` methods.
 */
function loggerOf(ctx) {
  const candidate = service(ctx, 'logger');
  if (candidate !== undefined && typeof candidate.warn === 'function') return candidate;
  return { info() {}, warn() {}, error() {} };
}

/**
 * The plugin's own version, read from its manifest.
 * @returns the version string, or `'0.0.0'` when the manifest is unreadable.
 */
function pluginVersion() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Shared parameter: a session id. */
const SESSION_ID = {
  type: 'string',
  description: 'A stored session id, as returned by session_list (for example "session-1f2e3d4c-...").',
};

/**
 * Register the model-facing tools.
 *
 * @param ctx - the plugin context.
 * @param options - registration dependencies.
 * @param options.generator - `{ name, version }` stamped into exported archives.
 * @returns nothing; every registration is an effect of the plugin fiber.
 */
function registerTools(ctx, options) {
  const tools = service(ctx, 'tools');
  if (tools === undefined) return;

  const disposers = [
    tools.register(defineTool({
      name: 'session_list',
      description:
        'List the DSH sessions stored in this deployment, newest first. Returns each session id, its '
        + 'workspace directory, title, creation time, event count, on-disk size, and whether any '
        + 'workspace accounts for it. Use this before session_export to discover session ids, and '
        + 'before session_delete: `orphaned: true` marks the sessions session_delete accepts, while '
        + '`mounted: false` is the wider set of sessions no workspace claims — including archived '
        + 'ones, which session_delete refuses unless you ask it to include them. '
        + '`conversation: false` marks a session that is mounted but was never used — created and '
        + 'abandoned, with no message in its log at all; session_delete accepts those too, but only '
        + 'with includeEmpty. Read-only.',
      parameters: {
        includeArchived: {
          type: 'boolean',
          description: 'Include sessions that are archived. Defaults to true.',
        },
        orphansOnly: {
          type: 'boolean',
          description: 'Return only orphaned sessions — the deletable ones. Defaults to false.',
        },
        emptyOnly: {
          type: 'boolean',
          description:
            'Return only never-used sessions: mounted, but with no conversation in the log. These are '
            + 'the "shell" sessions that clutter a sidebar. Defaults to false.',
        },
        unmountedOnly: {
          type: 'boolean',
          description:
            'Return only the sessions no workspace accounts for, archived ones included. '
            + 'Defaults to false.',
        },
        limit: {
          type: 'number',
          description: 'Return at most this many sessions. Omit for all of them.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true, description: 'Number of sessions returned.' },
            unmountedCount: {
              type: 'integer',
              required: true,
              description: 'Number of the returned sessions that no workspace accounts for.',
            },
            reclaimableBytes: {
              type: 'integer',
              required: true,
              description:
                'Total size of the returned sessions that no workspace accounts for; the archived '
                + 'part of it needs an explicit opt-in to delete.',
            },
            sessions: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string' },
                  cwd: { type: 'string' },
                  createdAt: { type: 'number', required: true, description: 'Unix epoch milliseconds.' },
                  eventCount: { type: 'number' },
                  sizeBytes: { type: 'number' },
                  conversation: {
                    type: 'boolean',
                    description:
                      'False when the log holds no conversation at all — only the events that '
                      + 'creating a session writes — so no title can be derived from it. Absent means '
                      + 'this was not established, not that the session has content.',
                  },
                  archived: { type: 'boolean', required: true },
                  mounted: {
                    type: 'boolean',
                    required: true,
                    description: 'Some workspace accounts for this session.',
                  },
                  orphaned: {
                    type: 'boolean',
                    required: true,
                    description:
                      'No workspace accounts for this session and it is not archived — the only '
                      + 'kind session_delete accepts.',
                  },
                  isSeeded: { type: 'boolean', required: true },
                  workspaceTitle: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.sessions.length === 0
            ? 'No stored sessions.'
            : value.sessions
              .map((session) => {
                // Same distinction the settings UI draws: a log holding only its
                // header has no first prompt to title it, and reporting that as
                // "untitled" hides the fact that there is nothing to open.
                const title = session.title
                  ?? (session.conversation === false ? '(unused session · no conversation)' : '(untitled)');
                const where = session.cwd ?? '(no workspace)';
                const size = session.sizeBytes === undefined ? '' : `, ${session.sizeBytes} bytes`;
                const events = session.eventCount === undefined ? '' : `, ${session.eventCount} events`;
                // "unmounted" is the wider set: everything no workspace claims,
                // which is what a caller looking for reclaimable space wants.
                // "orphaned" is the subset that can actually be deleted now.
                const tags = (session.archived ? '  [archived]' : '')
                  + (session.orphaned ? '  [orphaned]' : (session.mounted ? '' : '  [unmounted]'));
                return `${session.id}  ${title}\n    ${where}${events}${size}${tags}`;
              })
              .join('\n'),
        }],
      },
      async execute(args) {
        const includeArchived = args.includeArchived !== false;
        let sessions = await listSessions(ctx);
        if (args.unmountedOnly === true) sessions = sessions.filter((session) => !session.mounted);
        else if (args.orphansOnly === true) sessions = sessions.filter((session) => session.orphaned);
        else if (args.emptyOnly === true) sessions = sessions.filter((session) => session.mounted && session.conversation === false);
        else if (!includeArchived) sessions = sessions.filter((session) => !session.archived);
        if (typeof args.limit === 'number' && Number.isSafeInteger(args.limit) && args.limit >= 0) {
          sessions = sessions.slice(0, args.limit);
        }
        return {
          count: sessions.length,
          unmountedCount: sessions.filter((session) => !session.mounted).length,
          reclaimableBytes: sessions.reduce(
            (total, session) => total
              + (!session.mounted && Number.isSafeInteger(session.sizeBytes) ? session.sizeBytes : 0),
            0,
          ),
          sessions: sessions.map((session) => ({
            id: session.id,
            ...(session.title === null ? {} : { title: session.title }),
            ...(session.cwd === null ? {} : { cwd: session.cwd }),
            createdAt: session.createdAt ?? 0,
            ...(session.eventCount === null ? {} : { eventCount: session.eventCount }),
            ...(session.sizeBytes === null ? {} : { sizeBytes: session.sizeBytes }),
            ...(session.conversation === false ? { conversation: false } : {}),
            archived: session.archived,
            mounted: session.mounted,
            orphaned: session.orphaned,
            isSeeded: session.isSeeded,
            ...(session.workspace === null ? {} : { workspaceTitle: session.workspace.title }),
          })),
        };
      },
    })),

    tools.register(defineTool({
      name: 'session_export',
      description:
        'Export one or more DSH sessions into a single portable .dshsession archive (gzip-compressed '
        + 'JSONL, normalised to the current session format so it imports into any DSH version). Omit '
        + '"ids" to export every stored session. Returns the archive path and its statistics. Use '
        + 'session_list first to obtain ids.',
      parameters: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Session ids to export. Omit or pass an empty array to export every stored session.',
        },
        outputPath: {
          type: 'string',
          description:
            'Archive file to create. Defaults to an auto-named file in '
            + '<DSH_HOME>/dsh-session-vault/exports. Must end in .dshsession.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: 'Absolute path of the written archive.' },
            sessionCount: { type: 'integer', required: true },
            eventCount: { type: 'integer', required: true },
            bytes: { type: 'integer', required: true },
            ids: { type: 'array', required: true, items: { type: 'string' } },
            failed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  reason: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = [
            `Exported ${value.sessionCount} session(s), ${value.eventCount} events, `
            + `${value.bytes} bytes to ${value.path}`,
          ];
          // A partial export is not a failure, but it must never look like one:
          // the caller has to know which sessions are missing from the archive.
          for (const failure of value.failed) {
            lines.push(`  ! ${failure.id} could not be read: ${failure.reason}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args) {
        const ids = Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === 'string' && id.length > 0) : [];
        let destPath;
        if (typeof args.outputPath === 'string' && args.outputPath.trim().length > 0) {
          destPath = resolve(args.outputPath.trim());
          if (!destPath.endsWith('.dshsession')) throw new Error('outputPath must end in .dshsession');
          await mkdir(dirname(destPath), { recursive: true });
        } else {
          await mkdir(defaultExportDir(), { recursive: true });
          const name = suggestArchiveName(ids.length);
          destPath = join(defaultExportDir(), name);
        }
        const result = await exportSessions(ctx, {
          ids,
          destPath,
          generator: options.generator,
          source: { initiatedBy: 'agent' },
        });
        return {
          path: resolve(result.destPath),
          sessionCount: result.sessionCount,
          eventCount: result.eventCount,
          bytes: result.bytes,
          ids: result.ids,
          failed: result.failed.map((failure) => ({ id: failure.id, reason: failure.reason })),
        };
      },
    })),

    tools.register(defineTool({
      name: 'session_archive_inspect',
      description:
        'Read a .dshsession archive without importing it: returns the archive header plus one entry per '
        + 'archived session (id, title, workspace directory, event count). Use this to check what an '
        + 'archive contains before calling session_import. Read-only.',
      parameters: {
        archivePath: {
          type: 'string',
          required: true,
          description: 'Absolute path of the .dshsession archive to inspect.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sessionCount: { type: 'integer', required: true },
            eventCount: { type: 'integer', required: true },
            exportedAt: { type: 'string' },
            generatorVersion: { type: 'string' },
            sessions: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string' },
                  cwd: { type: 'string' },
                  eventCount: { type: 'number' },
                  isSeeded: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Archive holds ${value.sessionCount} session(s), ${value.eventCount} events:\n`
            + value.sessions
              .map((session) => `  ${session.id}  ${session.title ?? '(untitled)'}\n    ${session.cwd ?? '(no workspace)'}`)
              .join('\n'),
        }],
      },
      async execute(args) {
        const path = resolve(String(args.archivePath));
        const result = await inspectArchive(path);
        return {
          sessionCount: result.sessionCount,
          eventCount: result.eventCount,
          ...(typeof result.header?.generatedAt === 'string' ? { exportedAt: result.header.generatedAt } : {}),
          ...(typeof result.header?.generator?.version === 'string'
            ? { generatorVersion: result.header.generator.version }
            : {}),
          sessions: result.sessions.map((session) => ({
            id: session.id,
            ...(session.title === null ? {} : { title: session.title }),
            ...(session.cwd === null ? {} : { cwd: session.cwd }),
            ...(session.eventCount === null ? {} : { eventCount: session.eventCount }),
            isSeeded: session.isSeeded,
          })),
        };
      },
    })),

    tools.register(defineTool({
      name: 'session_import',
      description:
        'Import sessions from a .dshsession archive into this deployment. Each session is re-created '
        + 'through the session persistence service and attached to a workspace, so it appears in the '
        + 'sidebar. A session id that already exists is skipped, or imported under a fresh id when '
        + 'mode is "rename" — this build never overwrites an existing session. Set dryRun to preview '
        + 'without writing.',
      parameters: {
        archivePath: {
          type: 'string',
          required: true,
          description: 'Absolute path of the .dshsession archive to import.',
        },
        workspacePath: {
          type: 'string',
          description:
            'Workspace directory to import into. Defaults to each session\'s recorded working '
            + 'directory. Set this to relocate sessions to a different path, for example after moving '
            + 'to another machine.',
        },
        mode: {
          type: 'string',
          enum: ['skip', 'rename'],
          description: 'What to do when a session id already exists. Defaults to "skip".',
        },
        createMissingDirectory: {
          type: 'boolean',
          description: 'Create a missing workspace directory. Defaults to true.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Plan the import and report what would happen, without writing anything.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dryRun: { type: 'boolean', required: true },
            imported: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  sourceId: { type: 'string', required: true },
                  id: { type: 'string', required: true },
                  cwd: { type: 'string' },
                  eventCount: { type: 'integer', required: true },
                  title: { type: 'string' },
                  renamed: { type: 'boolean' },
                  workspaceAttached: { type: 'boolean', required: true },
                  workspaceError: { type: 'string' },
                },
              },
            },
            skipped: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  reason: { type: 'string', required: true },
                },
              },
            },
            failed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  reason: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = [
            `${value.dryRun ? 'Would import' : 'Imported'} ${value.imported.length} session(s); `
            + `${value.skipped.length} skipped; ${value.failed.length} failed.`,
          ];
          for (const entry of value.imported) {
            lines.push(`  + ${entry.id}${entry.renamed === true ? ` (renamed from ${entry.sourceId})` : ''}`);
          }
          for (const entry of value.skipped) lines.push(`  = ${entry.id} skipped (${entry.reason})`);
          for (const entry of value.failed) lines.push(`  ! ${entry.id} failed: ${entry.reason}`);
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args) {
        const path = resolve(String(args.archivePath));
        const workspacePath = typeof args.workspacePath === 'string' && args.workspacePath.trim().length > 0
          ? resolve(args.workspacePath.trim())
          : undefined;
        // A relative workspacePath would otherwise be resolved against the host
        // process's cwd, which is never what the caller means.
        if (typeof args.workspacePath === 'string' && args.workspacePath.trim().length > 0
          && !isAbsolute(args.workspacePath.trim())) {
          throw new Error('workspacePath must be an absolute path');
        }
        const result = await importSessions(ctx, {
          srcPath: path,
          workspacePath,
          mode: args.mode === 'rename' ? 'rename' : 'skip',
          createMissingDirectory: args.createMissingDirectory !== false,
          dryRun: args.dryRun === true,
        });
        return {
          dryRun: result.dryRun,
          imported: result.imported.map((entry) => ({
            sourceId: entry.sourceId,
            id: entry.id,
            ...(entry.cwd === null ? {} : { cwd: entry.cwd }),
            eventCount: entry.eventCount,
            ...(entry.title === null ? {} : { title: entry.title }),
            ...(entry.renamed === true ? { renamed: true } : {}),
            workspaceAttached: entry.workspaceAttached,
            ...(entry.workspaceError === undefined ? {} : { workspaceError: entry.workspaceError }),
          })),
          skipped: result.skipped.map((entry) => ({ id: entry.id, reason: entry.reason })),
          failed: result.failed.map((entry) => ({ id: entry.id, reason: entry.reason })),
        };
      },
    })),

    tools.register(defineTool({
      name: 'session_delete',
      description:
        'Permanently delete stored sessions that no workspace accounts for, reclaiming their disk space. '
        + 'DSH\'s persistence layer has no delete, so this removes the session artifacts directly — there '
        + 'is no undo and no archive is produced. Only unmounted sessions qualify: one attached to a '
        + 'workspace, or one currently live, is always refused; an archived one is refused unless you pass '
        + 'includeArchived, and a never-used one (mounted, but its log holds no conversation) unless you '
        + 'pass includeEmpty. Run with dryRun first to see exactly what would be removed, then pass '
        + 'confirm: true to actually delete. Use session_list and look for "orphaned", or for entries '
        + 'with "conversation": false, to find candidates; consider session_export first if the sessions '
        + 'might be wanted later.',
      parameters: {
        ids: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'Ids of the orphaned sessions to delete.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Report what would be deleted without removing anything. Do this first.',
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true to delete. Ignored when dryRun is true.',
        },
        includeArchived: {
          type: 'boolean',
          description:
            'Also delete archived sessions that no workspace accounts for. Defaults to false, '
            + 'because an archive may be the only copy left.',
        },
        includeEmpty: {
          type: 'boolean',
          description:
            'Also delete never-used sessions: mounted sessions whose log holds no conversation at all, '
            + 'only the events that creating a session writes. Defaults to false. This is the only way '
            + 'a session attached to a workspace can be deleted, and it applies only to sessions the '
            + 'host established as conversation-free — never to one whose contents it could not read.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dryRun: { type: 'boolean', required: true },
            reclaimedBytes: { type: 'integer', required: true },
            deleted: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  bytes: { type: 'integer' },
                  spillRemoved: { type: 'boolean' },
                },
              },
            },
            refused: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  reason: { type: 'string', required: true },
                },
              },
            },
            failed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  reason: { type: 'string', required: true },
                },
              },
            },
            survivors: {
              type: 'array',
              required: true,
              items: { type: 'string' },
              description:
                'Ids still listed after their files were removed, meaning a running process is serving '
                + 'them from an in-memory index; restarting dsh is what clears them.',
            },
          },
        },
        render: (_args, value) => {
          const lines = [
            `${value.dryRun ? 'Would delete' : 'Deleted'} ${value.deleted.length} session(s), `
            + `reclaiming ${value.reclaimedBytes} bytes.`,
          ];
          for (const entry of value.deleted) {
            lines.push(`  - ${entry.id}${entry.bytes === undefined ? '' : ` (${entry.bytes} bytes)`}`);
          }
          for (const entry of value.refused) lines.push(`  = ${entry.id} refused: ${entry.reason}`);
          for (const entry of value.failed) lines.push(`  ! ${entry.id} failed: ${entry.reason}`);
          if (value.survivors.length > 0) {
            lines.push(
              `  Note: ${value.survivors.length} deleted session(s) are still listed by the running `
              + 'process and will disappear after restarting dsh.',
            );
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args) {
        const ids = Array.isArray(args.ids) ? args.ids.filter((id) => typeof id === 'string' && id.length > 0) : [];
        const dryRun = args.dryRun === true;
        const result = await purgeSessions(ctx, {
          ids,
          dryRun,
          confirm: args.confirm === true,
          includeArchived: args.includeArchived === true,
          includeEmpty: args.includeEmpty === true,
        });
        return {
          dryRun: result.dryRun,
          reclaimedBytes: result.reclaimedBytes,
          deleted: result.deleted.map((entry) => ({
            id: entry.id,
            ...(Number.isSafeInteger(entry.bytes) ? { bytes: entry.bytes } : {}),
            ...(entry.spillRemoved === true ? { spillRemoved: true } : {}),
          })),
          refused: result.refused.map((entry) => ({ id: entry.id, reason: entry.reason })),
          failed: result.failed.map((entry) => ({ id: entry.id, reason: entry.reason })),
          survivors: result.survivors,
        };
      },
    })),
  ];

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
  }, 'dsh-session-vault: model tools');
}

/**
 * Mount the plugin.
 *
 * Both capabilities this plugin contributes are *late* services: `tools` and
 * `webServer` are published by bundles that activate on their own schedule, and
 * a bare `ctx.get()` inside `apply` returns `undefined` for a service that is
 * not yet published — which silently dropped both the tools and every route.
 * `ctx.inject()` is the Cordis mechanism for that case: it runs the callback
 * once the named services exist, and tears the contributions down again if they
 * disappear, so each capability is mounted exactly when it can be.
 *
 * @param ctx - the plugin context.
 * @param _config - the row config; this plugin takes none.
 */
export function apply(ctx, _config) {
  const generator = { name: 'dsh-session-vault', version: pluginVersion() };
  const log = loggerOf(ctx);

  ctx.inject(['tools'], (toolsCtx) => {
    registerTools(toolsCtx, { generator });
  });

  ctx.inject(['webServer'], (webCtx) => {
    const routes = createRoutes({ ctx: webCtx, generator, log });
    webCtx.effect(() => {
      const disposers = routes.map((route) => webCtx.webServer.register(route));
      log.info(`dsh-session-vault: mounted ${disposers.length} routes`);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-session-vault: routes');
  });
}

export { defaultExportDir, suggestArchiveName };
