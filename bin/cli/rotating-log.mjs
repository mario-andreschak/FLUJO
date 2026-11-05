/**
 * A log file that cannot fill the disk. When it passes the size limit it becomes
 * flujo.log.1, the older files move up by one, and the oldest is removed. Disk
 * use is therefore at most maxBytes * (maxFiles + 1).
 *
 * Logging must never stop the instance, so a failed write only counts a failure.
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const DEFAULT_LOG_MAX_FILES = 3;
const MIN_LOG_MAX_BYTES = 64 * 1024;
const MAX_LOG_MAX_FILES = 100;

function wholeNumber(value, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

/** FLUJO_LOG_MAX_BYTES and FLUJO_LOG_MAX_FILES. A bad value keeps the default. */
export function logLimitsFromEnv(env = process.env) {
  return {
    maxBytes: wholeNumber(env.FLUJO_LOG_MAX_BYTES, DEFAULT_LOG_MAX_BYTES, MIN_LOG_MAX_BYTES, Number.MAX_SAFE_INTEGER),
    maxFiles: wholeNumber(env.FLUJO_LOG_MAX_FILES, DEFAULT_LOG_MAX_FILES, 0, MAX_LOG_MAX_FILES),
  };
}

export class RotatingLog {
  constructor(filename, { maxBytes = DEFAULT_LOG_MAX_BYTES, maxFiles = DEFAULT_LOG_MAX_FILES } = {}) {
    this.filename = filename;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.failures = 0;
    this.handle = null;
    this.size = 0;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.open();
    if (this.size >= this.maxBytes) this.rotate();
  }

  open() {
    try {
      this.handle = fs.openSync(this.filename, 'a', 0o600);
      this.size = fs.fstatSync(this.handle).size;
    } catch {
      this.handle = null;
      this.failures += 1;
    }
  }

  rotate() {
    try {
      if (this.handle !== null) fs.closeSync(this.handle);
      this.handle = null;
      if (this.maxFiles === 0) fs.rmSync(this.filename, { force: true });
      else {
        fs.rmSync(`${this.filename}.${this.maxFiles}`, { force: true });
        for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
          if (fs.existsSync(`${this.filename}.${index}`)) {
            fs.renameSync(`${this.filename}.${index}`, `${this.filename}.${index + 1}`);
          }
        }
        fs.renameSync(this.filename, `${this.filename}.1`);
      }
    } catch { this.failures += 1; }
    this.open();
    // Rotation failed (something holds the file): start again rather than grow.
    if (this.size >= this.maxBytes && this.handle !== null) {
      try {
        fs.ftruncateSync(this.handle, 0);
        this.size = 0;
      } catch { this.failures += 1; }
    }
  }

  write(chunk) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    // One huge write must not break the limit either: keep only its end.
    const kept = bytes.length > this.maxBytes ? bytes.subarray(bytes.length - this.maxBytes) : bytes;
    if (this.size + kept.length > this.maxBytes && this.size > 0) this.rotate();
    if (this.handle === null) this.open();
    if (this.handle === null) return;
    try {
      fs.writeSync(this.handle, kept);
      this.size += kept.length;
    } catch { this.failures += 1; }
  }

  line(text) { this.write(`${new Date().toISOString()} [service] ${text}\n`); }

  close() {
    if (this.handle === null) return;
    try { fs.closeSync(this.handle); } catch { this.failures += 1; }
    this.handle = null;
  }
}
