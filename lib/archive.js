/**
 * dsh-session-vault — the portable session archive format.
 *
 * An archive is a gzip stream of newline-delimited JSON records (JSONL). The
 * physical encoding stays streaming-friendly in both directions, so a session
 * log of any size can be exported and imported with bounded memory: the writer
 * pulls one session at a time, the reader dispatches one record at a time.
 *
 * Record vocabulary (every line is one object with a `type` tag):
 *
 *   {"type":"header", ...}   exactly one, first   — format/version/generator/source
 *   {"type":"session", ...}  one per session      — header, lineage, workspace, title
 *   {"type":"event", ...}    zero or more         — one session event, in seq order
 *   {"type":"footer", ...}   exactly one, last    — counts, for validation
 *
 * Events always follow the `session` record they belong to, so a reader that
 * only tracks the current session id never has to look ahead.
 *
 * The archive carries *normalised* events as returned by
 * `SessionPersistence.open(id, 'read')`, not the raw on-disk bytes. That is
 * deliberate: it makes an archive portable across DSH session-format
 * generations, which is the entire point of moving a session between machines
 * or deployments. Byte-exact backup of the storage directory is a different
 * job, owned by the storage layer.
 *
 * @module dsh-session-vault/archive
 */

import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createGunzip, createGzip } from 'node:zlib';
import { createInterface } from 'node:readline';

/**
 * Marker written into `header.format`.
 *
 * Deliberately NOT the plugin's name. A format identifier is a wire contract
 * that outlives whatever the product is called this year, so it gets its own
 * neutral name; renaming the plugin must never invalidate archives users
 * already hold. See {@link LEGACY_ARCHIVE_FORMATS} for the one it used to
 * write.
 */
export const ARCHIVE_FORMAT = 'dsh-session-archive';
/**
 * Format markers this build still reads.
 *
 * The plugin shipped once as `dsh-session-export` and wrote that string into
 * every archive it produced. Those files are still perfectly valid, so the
 * reader accepts them and the writer only ever emits the current marker.
 */
const LEGACY_ARCHIVE_FORMATS = new Set(['dsh-session-export']);
/** Archive layout version. Bumped only for a breaking record-shape change. */
export const ARCHIVE_VERSION = 1;
/** Conventional file extension, including the dot. */
export const ARCHIVE_EXTENSION = '.dshsession';
/** Gzip level: a good size/CPU trade-off for JSON text. */
const GZIP_LEVEL = 6;

/** Raised for any archive that is not a readable, well-formed archive. */
export class ArchiveFormatError extends Error {
  /**
   * @param message - human-readable reason.
   */
  constructor(message) {
    super(message);
    this.name = 'ArchiveFormatError';
  }
}

/**
 * Serialise one record and await drain when the gzip buffer is full, so the
 * writer never grows an unbounded in-memory queue on a large session.
 * @param sink - the gzip transform acting as the archive's writable side.
 * @param record - any JSON-serialisable record.
 */
async function writeRecord(sink, record) {
  if (sink.write(`${JSON.stringify(record)}\n`) === false) await once(sink, 'drain');
}

/**
 * Write one archive.
 *
 * `sessions` is consumed lazily: each entry is `{ meta, events }`, where
 * `events` is any iterable or async iterable of session events. The caller is
 * therefore free to open and stream one persisted session at a time.
 *
 * @param destPath - archive file to create (overwritten).
 * @param header - archive-level metadata; `format`/`version` are stamped here.
 * @param sessions - iterable or async iterable of `{ meta, events }` entries.
 * @returns final `{ sessionCount, eventCount, bytes }` statistics.
 */
export async function writeArchive(destPath, header, sessions) {
  const sink = createGzip({ level: GZIP_LEVEL });
  const file = createWriteStream(destPath);
  sink.pipe(file);

  // A failure anywhere must tear the sink down, or the pipeline hangs on a
  // half-written file that the caller would then happily read back.
  let failure;
  const failed = (error) => {
    failure = error;
    sink.destroy();
  };
  file.on('error', failed);

  let sessionCount = 0;
  let eventCount = 0;
  try {
    await writeRecord(sink, {
      type: 'header',
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      generatedAt: new Date().toISOString(),
      ...header,
    });
    for await (const { meta, events } of sessions) {
      sessionCount += 1;
      await writeRecord(sink, { type: 'session', ...meta });
      let count = 0;
      for await (const event of events) {
        await writeRecord(sink, { type: 'event', id: meta.id, event });
        count += 1;
        eventCount += 1;
      }
      await writeRecord(sink, { type: 'session-end', id: meta.id, eventCount: count });
    }
    await writeRecord(sink, { type: 'footer', sessionCount, eventCount });
    sink.end();
    await once(file, 'close');
    if (failure !== undefined) throw failure;
  } catch (error) {
    sink.destroy();
    file.destroy();
    throw error;
  }
  const { size } = await import('node:fs/promises').then((fs) => fs.stat(destPath));
  return { sessionCount, eventCount, bytes: size };
}

/**
 * Read one archive, dispatching each record to `visitor`.
 *
 * The visitor may return a promise; the reader awaits it before pulling the
 * next record, which is what lets an importer apply backpressure to the
 * persistence layer.
 *
 * @param srcPath - archive file to read.
 * @param visitor - record handlers; omitted handlers are ignored.
 * @param visitor.onHeader - called once with the header record.
 * @param visitor.onSession - called once per session, before its events.
 * @param visitor.onEvent - called for every event, in archive order.
 * @param visitor.onSessionEnd - called after a session's last event.
 * @param visitor.onFooter - called once with the footer record.
 * @returns `{ sessionCount, eventCount }` as actually read.
 */
export async function readArchive(srcPath, visitor = {}) {
  const file = createReadStream(srcPath);
  const source = createGunzip();
  file.pipe(source);

  // Surface a bad gzip stream as an archive problem rather than a raw zlib
  // code, and never let the read stream's error escape as an unhandled event.
  let streamError;
  const record = (error) => {
    streamError = error;
  };
  file.on('error', record);
  source.on('error', record);

  const lines = createInterface({ input: source, crlfDelay: Number.POSITIVE_INFINITY });
  let header;
  let footer;
  let sessionCount = 0;
  let eventCount = 0;
  let currentId;
  let openEventCount = 0;

  try {
    for await (const line of lines) {
      const text = line.trim();
      if (text.length === 0) continue;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new ArchiveFormatError('archive contains a line that is not valid JSON');
      }
      switch (parsed.type) {
        case 'header':
          if (header !== undefined) throw new ArchiveFormatError('archive declares more than one header');
          if (parsed.format !== ARCHIVE_FORMAT && !LEGACY_ARCHIVE_FORMATS.has(parsed.format)) {
            throw new ArchiveFormatError(`unexpected archive format: ${String(parsed.format)}`);
          }
          if (parsed.version !== ARCHIVE_VERSION) {
            throw new ArchiveFormatError(
              `unsupported archive version ${String(parsed.version)}; this build reads version ${ARCHIVE_VERSION}`,
            );
          }
          header = parsed;
          if (visitor.onHeader !== undefined) await visitor.onHeader(parsed);
          break;
        case 'session':
          if (header === undefined) throw new ArchiveFormatError('archive body appeared before its header');
          if (currentId !== undefined) {
            throw new ArchiveFormatError(`session ${currentId} ended without a session-end record`);
          }
          currentId = parsed.id;
          openEventCount = 0;
          sessionCount += 1;
          if (visitor.onSession !== undefined) await visitor.onSession(parsed);
          break;
        case 'event': {
          if (currentId === undefined) throw new ArchiveFormatError('event record appeared outside a session');
          if (parsed.id !== currentId) {
            throw new ArchiveFormatError('event record is tagged with a different session id');
          }
          openEventCount += 1;
          eventCount += 1;
          if (visitor.onEvent !== undefined) await visitor.onEvent(parsed, currentId);
          break;
        }
        case 'session-end':
          if (currentId === undefined) throw new ArchiveFormatError('session-end record appeared outside a session');
          if (parsed.id !== currentId) {
            throw new ArchiveFormatError('session-end record is tagged with a different session id');
          }
          if (parsed.eventCount !== openEventCount) {
            throw new ArchiveFormatError(
              `session ${currentId} declares ${String(parsed.eventCount)} events but carries ${openEventCount}`,
            );
          }
          if (visitor.onSessionEnd !== undefined) await visitor.onSessionEnd(parsed);
          currentId = undefined;
          break;
        case 'footer':
          if (currentId !== undefined) throw new ArchiveFormatError('archive ended in the middle of a session');
          footer = parsed;
          if (visitor.onFooter !== undefined) await visitor.onFooter(parsed);
          break;
        default:
          // Unknown record types are forward-compatible additions: skipping
          // them keeps a newer writer's archive readable by this build.
          break;
      }
    }
  } catch (error) {
    if (error instanceof ArchiveFormatError) throw error;
    throw new ArchiveFormatError(`could not read archive: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    lines.close();
    source.destroy();
    file.destroy();
  }

  if (streamError !== undefined && header === undefined) {
    throw new ArchiveFormatError(
      `archive is not a readable gzip stream: ${streamError instanceof Error ? streamError.message : String(streamError)}`,
    );
  }
  if (header === undefined) throw new ArchiveFormatError('archive is missing its header record');
  if (footer === undefined) throw new ArchiveFormatError('archive is incomplete: no footer record');
  if (footer.sessionCount !== sessionCount || footer.eventCount !== eventCount) {
    throw new ArchiveFormatError('archive footer does not match the records actually read');
  }
  return { header, sessionCount, eventCount };
}

/**
 * Read a whole archive into memory.
 *
 * Convenience for small archives and tests. Import never uses this: it streams
 * one session at a time so a multi-hundred-megabyte session log does not have
 * to fit in the heap twice.
 *
 * @param srcPath - archive file to read.
 * @returns `{ header, footer, sessions }`, each session carrying its events.
 */
export async function loadArchive(srcPath) {
  const sessions = [];
  let current;
  const result = await readArchive(srcPath, {
    onSession(meta) {
      current = { ...meta, events: [] };
      delete current.type;
      sessions.push(current);
    },
    onEvent(record) {
      current.events.push(record.event);
    },
  });
  return { header: result.header, sessionCount: result.sessionCount, eventCount: result.eventCount, sessions };
}
