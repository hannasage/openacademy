// Validator for the learning event contract and the learning event log.
//
// It reuses the size cap and the supported major versions from validate.mjs and does not change that file.
// A call never changes its input and never writes a file. Files are opened for reading only.
//
// A log is JSON Lines text: one event per line, UTF-8, each line at most MAX_LINE_BYTES.
// Lines end at the newline character only.
import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { MAX_BYTES, SUPPORTED_SCHEMA_MAJORS } from './validate.mjs';

export { MAX_BYTES, SUPPORTED_SCHEMA_MAJORS };

/** The largest single log line, in bytes, not counting the newline. */
export const MAX_LINE_BYTES = 4096;

/** The event types of schema major version 1. The set is closed. */
export const EVENT_TYPES = Object.freeze([
  'attempt_submitted', 'check_result', 'hint_requested', 'agent_offer', 'reflection_saved',
  'task_opened', 'task_finished', 'module_completed', 'mode_changed', 'review_result',
]);

const EVENT_SCHEMA_ID = 'urn:schola:contract:learning-event:v1';
const MAX_ERRORS = 100;

const directory = new URL('./', import.meta.url);
const ajv = new Ajv2020({ strict: true, allErrors: true });
for (const name of ['lesson-common.v1.schema.json', 'learning-event.v1.schema.json']) {
  ajv.addSchema(JSON.parse(readFileSync(new URL(name, directory), 'utf8')));
}
const validateSchema = ajv.getSchema(EVENT_SCHEMA_ID);
if (!validateSchema) throw new Error('Missing schema for learning-event.');

const error = (pointer, message) => ({ pointer, message });
const invalid = (errors) => {
  if (errors.length <= MAX_ERRORS) return { ok: false, reason: 'invalid', errors };
  const omitted = errors.length - MAX_ERRORS;
  return { ok: false, reason: 'invalid', errors: [...errors.slice(0, MAX_ERRORS), error('', `${omitted} more errors omitted.`)] };
};
const tooLargeLine = () => ({ ok: false, reason: 'too_large', errors: [error('', 'The line is larger than the 4 KB limit.')] });
const wholeLogFailure = (reason, message) => ({ ok: false, reason, errors: [error('', message)], lines: [], truncatedTail: false });
const tooLargeLog = () => wholeLogFailure('too_large', 'The log is larger than the 5 MB limit.');
const unreadable = (cause) => wholeLogFailure('unreadable', `The file could not be read (${typeof cause?.code === 'string' ? cause.code : 'unknown'}).`);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const byteLength = (text) => Buffer.byteLength(text, 'utf8');

function schemaErrors() {
  return (validateSchema.errors ?? []).map((found) => {
    const escape = (segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
    const missing = found.keyword === 'required' ? `/${escape(found.params.missingProperty)}` : '';
    return error(`${found.instancePath}${missing}`, found.message ?? 'The value is not valid.');
  });
}

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function semanticErrors(event) {
  const errors = [];
  const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(event.time);
  if (match && Number(match[3]) > daysInMonth(Number(match[1]), Number(match[2]))) {
    errors.push(error('/time', 'The time names a day that does not exist.'));
  }
  if (event.type === 'agent_offer' && event.data.triggerEventId === event.eventId) {
    errors.push(error('/data/triggerEventId', 'An offer cannot be triggered by its own event.'));
  }
  return errors;
}

/**
 * Validate one parsed event.
 * @param {unknown} document A parsed JSON value. It is read, never changed.
 * @returns {{ ok: true } | { ok: false, reason: 'invalid' | 'unsupported_version', errors: { pointer: string, message: string }[] }}
 */
export function validateEvent(document) {
  if (!isObject(document)) return invalid([error('', 'The document must be a JSON object.')]);
  // Read the leading major number first. A value such as 2.0 is an unsupported version, not a malformed one.
  const marker = typeof document.schemaVersion === 'string' ? /^(\d+)\./.exec(document.schemaVersion) : null;
  if (marker && !SUPPORTED_SCHEMA_MAJORS.includes(Number(marker[1]))) {
    return {
      ok: false,
      reason: 'unsupported_version',
      errors: [error('/schemaVersion', `This reader supports schema major version ${SUPPORTED_SCHEMA_MAJORS.join(', ')} only.`)],
    };
  }
  if (!validateSchema(document)) return invalid(schemaErrors());
  const errors = semanticErrors(document);
  return errors.length > 0 ? invalid(errors) : { ok: true };
}

// Returns { result, stage, document }. The document is set only when the text parsed.
function runText(text) {
  if (typeof text !== 'string') return { result: invalid([error('', 'The text must be a string.')]), stage: 'parse' };
  if (byteLength(text) > MAX_LINE_BYTES) return { result: tooLargeLine(), stage: 'size' };
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return { result: invalid([error('', 'The text is not complete, valid JSON.')]), stage: 'parse' };
  }
  return { result: validateEvent(document), stage: 'event', document };
}

/**
 * Parse one line of JSON, then validate it. Text over MAX_LINE_BYTES is refused before parsing.
 * Text that is not JSON is an invalid result.
 * @param {string} text
 */
export function validateEventText(text) {
  return runText(text).result;
}

const lineResult = (line, result) => (result.ok
  ? { line, ok: true }
  : { line, ok: false, reason: result.reason, errors: result.errors });

/**
 * Validate JSON Lines text, one event per line. Text over MAX_BYTES is refused before parsing.
 * A final line with no newline that is not complete JSON is reported as truncated_tail.
 * A repeated event id is reported on the later line.
 * @param {string | Uint8Array} text A string, or the bytes of a log, which must be strict UTF-8.
 * @returns {{ ok: boolean, lines: object[], truncatedTail: boolean } | { ok: false, reason: string, errors: object[], lines: [], truncatedTail: false }}
 */
export function validateLogText(text) {
  let source = text;
  if (source instanceof Uint8Array) {
    if (source.byteLength > MAX_BYTES) return tooLargeLog();
    try {
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source);
    } catch {
      return wholeLogFailure('invalid', 'The text is not valid UTF-8.');
    }
  }
  if (typeof source !== 'string') return wholeLogFailure('invalid', 'The text must be a string.');
  if (byteLength(source) > MAX_BYTES) return tooLargeLog();
  const parts = source.split('\n');
  // Text that ends with a newline leaves one empty piece at the end. It is not a line.
  const tailHasNewline = parts.at(-1) === '';
  if (tailHasNewline) parts.pop();
  const lines = [];
  const seen = new Set();
  let truncatedTail = false;
  parts.forEach((part, index) => {
    const line = index + 1;
    const isTail = index === parts.length - 1 && !tailHasNewline;
    if (byteLength(part) > MAX_LINE_BYTES) {
      lines.push(lineResult(line, tooLargeLine()));
      return;
    }
    let { result, stage, document } = runText(part);
    if (isTail && stage === 'parse') {
      truncatedTail = true;
      result = { ok: false, reason: 'truncated_tail', errors: [error('', 'The last line is cut short. It has no newline and is not complete JSON.')] };
    } else if (result.ok) {
      if (seen.has(document.eventId)) result = invalid([error('/eventId', 'Each event id must be unique in a log. This one is repeated.')]);
      seen.add(document.eventId);
    }
    lines.push(lineResult(line, result));
  });
  return { ok: lines.every((entry) => entry.ok), lines, truncatedTail };
}

/**
 * Read a log file and validate it. The file is opened for reading only, so it stays as it was.
 * A file over MAX_BYTES is refused after a size check and is never read.
 * @param {string | URL} file
 */
export async function validateLogFile(file) {
  let bytes;
  try {
    const info = await stat(file);
    if (info.size > MAX_BYTES) return tooLargeLog();
    bytes = await readFile(file);
  } catch (cause) {
    return unreadable(cause);
  }
  return validateLogText(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}
