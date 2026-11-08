#!/usr/bin/env node

/**
 * archive-public-sessions.mjs
 *
 * Collects local Claude Code and Codex CLI sessions that belong to PUBLIC
 * GitHub repositories, sanitizes them with
 * https://github.com/link-foundation/sensitive-data-sanitizer, converts them
 * to Links Notation archives with https://github.com/link-assistant/conversation
 * and uploads the sanitized sources (.jsonl) plus the archives (.lino) to a
 * shared GitHub repository (default: konard/public-repositories-sessions-archive),
 * in the spirit of https://github.com/link-foundation/gh-upload-log.
 *
 * Requirements: Node.js >= 22, git, authenticated GitHub CLI (`gh auth login`).
 *
 * Usage:
 *   node archive-public-sessions.mjs --list                 # show what would be archived
 *   node archive-public-sessions.mjs --dry-run              # sanitize + convert locally, no push
 *   node archive-public-sessions.mjs                        # full run (creates the repo if missing)
 *   node archive-public-sessions.mjs --filter konard/p-vs-np --only claude --limit 3 --verbose
 *
 * Archive layout:
 *   <owner>/<repo>/claude/<session-id>.jsonl              sanitized Claude Code session
 *   <owner>/<repo>/claude/<session-id>.lino               conversation archive
 *   <owner>/<repo>/claude/<session-id>.meta.json          provenance (hashes, counts, versions)
 *   <owner>/<repo>/claude/<session-id>/subagents/*.jsonl  sub-agent transcripts (+ .lino)
 *   <owner>/<repo>/claude/<session-id>/tool-results/*     saved tool outputs (sanitized text)
 *   <owner>/<repo>/codex/<YYYY>/<MM>/<DD>/rollout-*.jsonl sanitized Codex session (+ .lino)
 *   Files larger than --chunk-size are split at line boundaries into .part-NNN files.
 */

import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, cpus, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const SCRIPT_PATH = fileURLToPath(import.meta.url);

// Commits of the two unpublished libraries this script was verified with.
const DEFAULT_CONVERSATION_REF = 'e548823507862f237ce58cb2915bf336f29a725c';
const DEFAULT_SANITIZER_REF = '5f06c7debd80376460729bfec4476894bc2a53ca';
const DEFAULT_REPOSITORY = 'konard/public-repositories-sessions-archive';
const DEFAULT_BRANCH = 'main';
// Sessions of these repositories handle real identity documents (passport
// scans, family names in file names) that no generic rule can redact.
// Override with SESSIONS_ARCHIVE_EXCLUDE='' only after a manual review.
const DEFAULT_EXCLUDES = 'konard/documents-processing';
const META_SUFFIX = '.meta.json';
const REDACTED = '[REDACTED]';
// Identity-document data the sanitizer does not recognize (found in a
// published archive): passport MRZ lines, passport/visa numbers, booking
// references and birth dates written next to their labels. Real values are
// masked as `ab***yz` (first two and last two characters); values shorter
// than 5 characters are replaced completely. Explicitly fake test data is
// kept: see isExplicitlyFake().
const IDENTITY_RULES = [
  { type: 'MRZ_NAME_LINE', re: /[PIACV][A-Z<][A-Z]{3}[A-Z]{2,}(?:<[A-Z]+)*<<[A-Z][A-Z<]*/g },
  { type: 'MRZ_DATA_LINE', re: /[A-Z0-9<]{9}[0-9<][A-Z<]{3}[0-9]{6}[0-9][MFX<][0-9]{6}[0-9]?[A-Z0-9<]{0,16}/g },
  { type: 'RU_PASSPORT', re: /(?<![\d.,:-])\d{2} \d{2} \d{6}(?![\d.,:-])/g },
  { type: 'PASSPORT_NUMBER', re: /(?<=(?:passport|паспорт|visa|виза|document|документ)[^\n]{0,24}?(?:no\.?|number|num|#|№|номер|серия)[^A-Za-z0-9\n]{0,8})[A-Z]{0,2}[0-9][0-9 ]{2,12}[0-9]/giu },
  { type: 'BOOKING_REFERENCE', re: /(?<=(?:booking ref(?:erence)?|reservation (?:code|number)|pnr|бронирован[^\s]*)[^A-Za-z0-9\n]{1,8})[A-Z0-9]{3,8}\b/giu },
  { type: 'PHONE', re: /(?<=(?:whatsapp|zalo|viber|telegram|signal|wechat|kakaotalk|тел(?:ефон)?\.?|phone|mobile|звоните|пишите|номер телефона)[^0-9+\n]{0,12})\+?\d[\d ()-]{7,16}\d/giu },
  { type: 'DATE_OF_BIRTH', re: /(?<=(?:date of birth|birth ?date|dob|born|дата рождения|д\.р\.)[^0-9\n]{0,12})[0-9]{1,4}[./-][0-9]{1,2}[./-][0-9]{1,4}/giu },
];
// ICAO Doc 9303 specimen documents and well-known sample identities.
const SPECIMEN_MARKERS = /UTO|UTOPIA|SPECIMEN|ОБРАЗЕЦ|MUSTERMANN|ERIKSSON|L898902C3|D23145890|XI85935F8|STORGATAN|SAMPLE|TESTER|DUMMY|FAKE/;
const FAKE_VALUES = new Set();
export function setFakeValues(values) {
  FAKE_VALUES.clear();
  for (const value of values) if (value) FAKE_VALUES.add(value.trim());
}
/**
 * True only for data that is explicitly fake: an ICAO/known specimen, a value
 * reviewed into the fake-values list, or an obviously synthetic number
 * (one repeated digit, or 6+ consecutive ascending/descending digits).
 * Context words such as "test" are NOT enough: real documents get tested too.
 */
export function isExplicitlyFake(value) {
  const v = value.trim();
  if (FAKE_VALUES.has(v)) return true;
  if (SPECIMEN_MARKERS.test(v.toUpperCase())) return true;
  const digits = v.replace(/\D/g, '');
  // For MRZ data lines only the document number field decides.
  const core = /^[A-Z0-9<]{9}[0-9<][A-Z<]{3}/.test(v) ? v.slice(0, 9).replace(/\D/g, '') : digits;
  if (core.length >= 4 && /^(\d)\1+$/.test(core)) return true;
  const ascending = '01234567890123456789';
  const descending = '98765432109876543210';
  for (let i = 0; i + 6 <= core.length; i++) {
    const run = core.slice(i, i + 6);
    if (ascending.includes(run) || descending.includes(run)) return true;
  }
  return false;
}
export function maskIdentity(value) {
  return value.length < 5 ? '[REDACTED]' : `${value.slice(0, 2)}***${value.slice(-2)}`;
}
export function redactIdentity(text, stats) {
  let out = text;
  for (const rule of IDENTITY_RULES) {
    out = out.replace(rule.re, (value, ...rest) => {
      const offset = rest[rest.length - 2];
      const whole = rest[rest.length - 1];
      let start = offset;
      let end = offset + value.length;
      while (start > 0 && /[^\s"'`]/.test(whole[start - 1])) start -= 1;
      while (end < whole.length && /[^\s"'`]/.test(whole[end])) end += 1;
      const token = whole.slice(start, end).replace(/^[^A-Za-z0-9<]+|[^A-Za-z0-9<]+$/g, "");
      if (isExplicitlyFake(value) || FAKE_VALUES.has(token)) {
        if (stats) stats.fakeKept += 1;
        return value;
      }
      if (stats) stats.identityMasked += 1;
      return maskIdentity(value);
    });
  }
  return out;
}
const MRZ_GATE = /[PIACV][A-Z<][A-Z]{3}[A-Z]{2,}(?:<[A-Z]+)*<<[A-Z]{2,}|[A-Z0-9<]{9}[0-9<][A-Z]{3}[0-9]{6}[0-9<][MFX<][0-9]{6}/g;
export function realMrzFound(text) {
  for (const match of text.matchAll(MRZ_GATE)) if (!isExplicitlyFake(match[0])) return true;
  return false;
}
const SENSITIVE_KEY =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|private[-_]?key|credential|authorization|cookie)$/i;

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) {
  console.error(
    `>>> ERROR: Node.js >= 22 is required by sensitive-data-sanitizer (found ${process.version}). ` +
      'Run e.g. `nvm use 22` and retry.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shared helpers (used by both the coordinator and the per-session worker)
// ---------------------------------------------------------------------------

const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MiB`;
  return `${(n / 1073741824).toFixed(2)} GiB`;
};

const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
};

const parseSize = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number') return value;
  const match = /^\s*([\d.]+)\s*([kmg]?i?b?)\s*$/i.exec(String(value));
  if (!match) throw new Error(`Invalid size: ${value}`);
  const unit = match[2].toLowerCase().replace('i', '').replace('b', '');
  const factor = { '': 1048576, k: 1024, m: 1048576, g: 1073741824 }[unit];
  return Math.round(Number(match[1]) * factor);
};

const sha256File = (path) =>
  new Promise((done, fail) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', fail)
      .on('end', () => done(hash.digest('hex')));
  });

const sha256Text = (text) => createHash('sha256').update(text).digest('hex');

/** Turn any git remote URL into "owner/repo" when it points at github.com. */
export function parseGitHubRepository(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  const patterns = [
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?(?:www\.)?github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^(?:[^@]+@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

/** Load the git-installed libraries from the dependency cache directory. */
async function loadLibraries(depsDir) {
  const root = join(depsDir, 'node_modules');
  const conversation = await import(
    pathToFileURL(join(root, '@link-assistant/conversation/src/conversation.js')).href
  );
  const sanitizer = await import(
    pathToFileURL(join(root, '@link-foundation/sensitive-data-sanitizer/src/index.js')).href
  );
  return { conversation, sanitizer };
}

// ---------------------------------------------------------------------------
// Sanitization of one session (runs inside a worker process)
// ---------------------------------------------------------------------------

/**
 * The sanitizer's whole-text mode treats session JSON as prose: it redacts
 * tool names, message ids and whole fields, and its encoded-run limit rejects
 * batches of JSON lines outright. So every JSON string value is sanitized
 * individually (keys included), keeping the record structure intact, while
 * values whose key looks like a credential are always redacted.
 */
function createRecordSanitizer(lib, { knownSecrets, pieceBytes, batchBytes, stats }) {
  const SEP = '\n<<<<SESSION-ARCHIVE-BOUNDARY>>>>\n';
  const base = { knownSecrets, maxInputLength: 64 * 1024 * 1024 };
  const engines = {
    full: lib.createSanitizer(base),
    // Fallback when the bounded decoder gives up on a huge piece of text.
    plain: lib.createSanitizer({ ...base, decode: false }),
  };

  /**
   * Sanitize one piece of text. The engine blocks output instead of guessing,
   * so every failure degrades to a safer and lossier choice: skip bounded
   * decoding (ERR_LIMIT), drop control characters (ERR_BINARY/ERR_ENCODING),
   * and finally replace the whole piece with [REDACTED].
   */
  async function sanitizeText(raw) {
    stats.calls += 1;
    const text = redactIdentity(raw, stats);
    try {
      return (await engines.full.sanitize(text)).text;
    } catch (error) {
      stats.decodeFallbacks += 1;
      let input = text;
      if (error?.code === 'ERR_BINARY' || error?.code === 'ERR_ENCODING') {
        // eslint-disable-next-line no-control-regex -- strip bytes the engine refuses
        input = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
      }
      try {
        return (await engines.plain.sanitize(input)).text;
      } catch {
        stats.blockedPieces += 1;
        return REDACTED;
      }
    }
  }

  function splitPieces(text) {
    if (text.length <= pieceBytes) return [text];
    const pieces = [];
    let index = 0;
    while (index < text.length) {
      let end = Math.min(index + pieceBytes, text.length);
      if (end < text.length) {
        const newline = text.lastIndexOf('\n', end);
        if (newline > index) end = newline + 1;
      }
      pieces.push(text.slice(index, end));
      index = end;
    }
    return pieces;
  }

  /** Sanitize many strings with as few engine calls as possible. */
  async function sanitizeMany(strings) {
    const result = new Array(strings.length);
    let batch = [];
    let size = 0;
    const flush = async () => {
      if (!batch.length) return;
      const blockedBefore = stats.blockedPieces;
      const joined = batch.map((entry) => entry.text).join(SEP);
      const parts = (await sanitizeText(joined)).split(SEP);
      if (parts.length === batch.length && stats.blockedPieces === blockedBefore) {
        batch.forEach((entry, i) => {
          result[entry.index] = parts[i];
        });
      } else {
        // A redaction swallowed a boundary or the batch was blocked as a
        // whole: redo this batch one string at a time.
        stats.batchFallbacks += 1;
        stats.blockedPieces = blockedBefore;
        for (const entry of batch) result[entry.index] = await sanitizeText(entry.text);
      }
      batch = [];
      size = 0;
    };
    for (const [index, text] of strings.entries()) {
      if (text.length > pieceBytes) {
        await flush();
        const outputs = [];
        for (const piece of splitPieces(text)) outputs.push(await sanitizeText(piece));
        result[index] = outputs.join('');
        continue;
      }
      if (size + text.length > batchBytes) await flush();
      batch.push({ index, text });
      size += text.length + SEP.length;
    }
    await flush();
    return result;
  }

  async function sanitizeRecord(record) {
    const leaves = [];
    const keys = [];
    const walk = (value, key, parent, slot) => {
      if (typeof value === 'string') {
        if (value.length >= 6 || (key && SENSITIVE_KEY.test(key))) {
          leaves.push({ parent, slot, key, text: value });
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, key, value, i));
        return;
      }
      if (value && typeof value === 'object') {
        for (const [childKey, childValue] of Object.entries(value)) {
          if (childKey.length >= 6) keys.push({ parent: value, key: childKey });
          walk(childValue, childKey, value, childKey);
        }
      }
    };
    walk(record, null, null, null);

    const forced = leaves.map(
      (leaf) => Boolean(leaf.key && SENSITIVE_KEY.test(leaf.key) && leaf.text.length >= 8)
    );
    const pending = leaves.filter((leaf, i) => !forced[i]);
    const outputs = await sanitizeMany(pending.map((leaf) => leaf.text));
    let cursor = 0;
    leaves.forEach((leaf, i) => {
      const value = forced[i] ? REDACTED : outputs[cursor++];
      if (value !== leaf.text) {
        stats.redactions += 1;
        leaf.parent[leaf.slot] = value;
      }
    });

    if (keys.length) {
      const keyOutputs = await sanitizeMany(keys.map((entry) => entry.key));
      keys.forEach((entry, i) => {
        if (keyOutputs[i] === entry.key) return;
        stats.redactions += 1;
        const value = entry.parent[entry.key];
        delete entry.parent[entry.key];
        let renamed = keyOutputs[i];
        let n = 2;
        while (renamed in entry.parent) renamed = `${keyOutputs[i]}#${n++}`;
        entry.parent[renamed] = value;
      });
    }
    return record;
  }

  return { sanitizeText, sanitizeRecord, splitPieces };
}

/** Collects lines into files of at most chunkBytes, named base.part-NNN.ext. */
class PartWriter {
  constructor(base, extension, chunkBytes) {
    this.base = base;
    this.extension = extension;
    this.chunkBytes = chunkBytes;
    this.parts = [];
    this.buffer = [];
    this.bytes = 0;
  }

  write(line) {
    const length = Buffer.byteLength(line);
    if (this.bytes > 0 && this.bytes + length > this.chunkBytes) this.flush();
    this.buffer.push(line);
    this.bytes += length;
  }

  flush() {
    if (!this.buffer.length) return;
    const index = String(this.parts.length + 1).padStart(3, '0');
    const path = `${this.base}.part-${index}${this.extension}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.buffer.join(''), { mode: 0o600 });
    this.parts.push({ path, bytes: this.bytes });
    this.buffer = [];
    this.bytes = 0;
  }

  finish() {
    this.flush();
    if (this.parts.length === 1) {
      const single = `${this.base}${this.extension}`;
      renameSync(this.parts[0].path, single);
      this.parts[0].path = single;
    }
    return this.parts;
  }
}

async function processOne(spec) {
  const started = Date.now();
  const libs = await loadLibraries(spec.depsDir);
  const stats = { calls: 0, decodeFallbacks: 0, batchFallbacks: 0, blockedPieces: 0, redactions: 0, lines: 0, identityMasked: 0, fakeKept: 0 };
  setFakeValues(spec.fakeValues ?? []);
  const sanitizer = createRecordSanitizer(libs.sanitizer, {
    knownSecrets: spec.knownSecrets,
    pieceBytes: 256 * 1024,
    batchBytes: 256 * 1024,
    stats,
  });
  const sourceSize = statSync(spec.sourcePath).size;
  const sourceSha256 = await sha256File(spec.sourcePath);
  const targetBase = join(spec.outputDir, spec.targetBase);
  const produced = [];
  const conversions = [];

  // 1. Sanitize line by line into chunked output files.
  const writer = new PartWriter(targetBase, spec.extension, spec.chunkBytes);
  const reader = createInterface({
    input: createReadStream(spec.sourcePath),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    stats.lines += 1;
    if (spec.kind === 'jsonl') {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        record = undefined;
      }
      if (record && typeof record === 'object') {
        writer.write(`${JSON.stringify(await sanitizer.sanitizeRecord(record))}\n`);
      } else {
        writer.write(`${await sanitizer.sanitizeText(line)}\n`);
      }
    } else {
      writer.write(`${await sanitizer.sanitizeText(line)}\n`);
    }
  }
  const parts = writer.finish();
  produced.push(...parts);

  // 2. Convert each sanitized JSONL part into a Links Notation archive.
  if (spec.kind === 'jsonl') {
    for (const part of parts) {
      const linoPath = part.path.replace(/\.jsonl$/, '.lino');
      try {
        const text = readFileSync(part.path, 'utf8');
        const graph = libs.conversation.importJsonl(text, spec.tool);
        const lino = `${libs.conversation.encodeLino(graph)}\n`;
        writeFileSync(linoPath, lino, { mode: 0o600 });
        produced.push({ path: linoPath, bytes: Buffer.byteLength(lino) });
        conversions.push({
          part: relative(spec.outputDir, part.path),
          ok: true,
          nodes: graph.nodes.length,
          messages: libs.conversation.messages(graph).length,
        });
      } catch (error) {
        conversions.push({
          part: relative(spec.outputDir, part.path),
          ok: false,
          error: String(error?.message || error).slice(0, 300),
        });
      }
    }
  }

  // 3. Residual check: no known secret literal may survive in any output.
  for (const file of produced) {
    const text = readFileSync(file.path, 'utf8');
    if (realMrzFound(text)) {
      for (const cleanup of produced) rmSync(cleanup.path, { force: true });
      throw new Error(`passport MRZ-like data survived sanitization in ${relative(spec.outputDir, file.path)}`);
    }
    for (const secret of spec.knownSecrets) {
      if (secret && text.includes(secret)) {
        for (const cleanup of produced) rmSync(cleanup.path, { force: true });
        throw new Error(`known secret survived sanitization in ${relative(spec.outputDir, file.path)}`);
      }
    }
    file.sha256 = sha256Text(text);
  }

  const meta = {
    tool: spec.tool,
    kind: spec.kind,
    repository: spec.repository,
    source: {
      path: spec.sourcePath,
      bytes: sourceSize,
      sha256: sourceSha256,
      lines: stats.lines,
    },
    sanitized: {
      at: new Date().toISOString(),
      sanitizer: `github:link-foundation/sensitive-data-sanitizer#${spec.sanitizerRef}`,
      conversation: `github:link-assistant/conversation#${spec.conversationRef}`,
      redactions: stats.redactions,
      engineCalls: stats.calls,
      decodeFallbacks: stats.decodeFallbacks,
      batchFallbacks: stats.batchFallbacks,
      blockedPieces: stats.blockedPieces,
      identityMasked: stats.identityMasked,
      fakeIdentityKept: stats.fakeKept,
      knownSecretCount: spec.knownSecrets.length,
    },
    files: produced.map((file) => ({
      path: relative(spec.outputDir, file.path),
      bytes: file.bytes,
      sha256: file.sha256,
    })),
    conversions,
    durationMs: Date.now() - started,
  };
  const metaPath = `${targetBase}${META_SUFFIX}`;
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  produced.push({ path: metaPath, bytes: statSync(metaPath).size });
  return { ok: true, meta, files: produced.map((file) => relative(spec.outputDir, file.path)) };
}

async function runWorker() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const spec = JSON.parse(input);
  try {
    const result = await processOne(spec);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error?.code ? `[${error.code}] ` : '';
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: `${code}${String(error?.stack || error).slice(0, 2000)}` })}\n`
    );
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

async function runCoordinator() {
  const { use } = eval(await fetch('https://unpkg.com/use-m@8.16.4/use.js').then((u) => u.text()));
  const { makeConfig } = await use('lino-arguments@0.3.0');

  const config = makeConfig({
    yargs: ({ yargs, getenv }) =>
      yargs
        .usage('Usage: $0 [options]')
        .option('repo', {
          type: 'string',
          default: getenv('SESSIONS_ARCHIVE_REPO', DEFAULT_REPOSITORY),
          description: 'GitHub repository (owner/name) that receives the archive',
        })
        .option('branch', { type: 'string', default: getenv('SESSIONS_ARCHIVE_BRANCH', DEFAULT_BRANCH) })
        .option('claude-dir', { type: 'string', default: getenv('CLAUDE_PROJECTS_DIR', join(homedir(), '.claude', 'projects')) })
        .option('codex-dir', { type: 'string', default: getenv('CODEX_SESSIONS_DIR', join(homedir(), '.codex', 'sessions')) })
        .option('work-dir', {
          type: 'string',
          default: getenv('SESSIONS_ARCHIVE_WORK_DIR', join(homedir(), '.cache', 'archive-public-sessions')),
          description: 'Where the dependency cache, repository clone and reports live',
        })
        .option('only', { type: 'string', choices: ['claude', 'codex'], description: 'Process only one tool' })
        .option('filter', { type: 'array', default: [], description: 'Only sessions of these owner/repo (repeatable)' })
        .option('limit', { type: 'number', description: 'Process at most N sessions' })
        .option('jobs', { type: 'number', default: Math.max(1, Math.min(4, cpus().length - 1)) })
        .option('chunk-size', { type: 'string', default: getenv('SESSIONS_ARCHIVE_CHUNK_SIZE', '40MB'), description: 'Split outputs larger than this (GitHub limit is 100MB)' })
        .option('large-size', { type: 'string', default: '50MB', description: 'Sessions above this size count as large' })
        .option('large-jobs', { type: 'number', default: 1, description: 'How many large sessions may run at once (each needs 1-3 GB of RAM)' })
        .option('fake-values-file', { type: 'string', default: getenv('SESSIONS_ARCHIVE_FAKE_VALUES_FILE', '') || undefined, description: 'Reviewed explicitly fake identity values to keep, one per line' })
        .option('exclude', { type: 'array', default: String(getenv('SESSIONS_ARCHIVE_EXCLUDE', DEFAULT_EXCLUDES)).split(/[\s,]+/).filter(Boolean), description: 'Never publish sessions of these owner/repo (repeatable)' })
        .option('max-source-size', { type: 'string', default: getenv('SESSIONS_ARCHIVE_MAX_SOURCE_SIZE', '2GB') })
        .option('push-every', { type: 'string', default: getenv('SESSIONS_ARCHIVE_PUSH_EVERY', '300MB'), description: 'Push after this many bytes of new content' })
        .option('min-age', { type: 'number', default: 10, description: 'Skip files modified less than N minutes ago (still being written)' })
        .option('include-tool-results', { type: 'boolean', default: true })
        .option('known-secrets-file', { type: 'string', description: 'Extra secret literals, one per line (never logged)' })
        .option('conversation-ref', { type: 'string', default: getenv('CONVERSATION_REF', DEFAULT_CONVERSATION_REF) })
        .option('sanitizer-ref', { type: 'string', default: getenv('SANITIZER_REF', DEFAULT_SANITIZER_REF) })
        .option('list', { type: 'boolean', default: false, description: 'List sessions and their attribution, then exit' })
        .option('dry-run', { type: 'boolean', default: false, description: 'Sanitize and convert locally; never create, commit or push' })
        .option('force', { type: 'boolean', default: false, description: 'Re-process sessions already present in the archive' })
        .option('verbose', { alias: 'v', type: 'boolean', default: false })
        .version(false)
        .help(),
  });

  const VERBOSE = config.verbose;
  const log = (...args) => console.log(...args);
  const debug = (...args) => {
    if (VERBOSE) console.log('[DEBUG]', ...args);
  };
  const warn = (...args) => console.warn('>>> WARNING:', ...args);

  const chunkBytes = parseSize(config.chunkSize, 40 * 1048576);
  const maxSourceBytes = parseSize(config.maxSourceSize, 2 * 1073741824);
  const pushEveryBytes = parseSize(config.pushEvery, 300 * 1048576);
  if (chunkBytes > 95 * 1048576) throw new Error('--chunk-size must stay below GitHub\'s 100MB file limit');
  const workDir = resolve(config.workDir);
  mkdirSync(workDir, { recursive: true });

  const run = async (command, args, options = {}) => {
    debug(`$ ${command} ${args.join(' ')}`);
    try {
      return await execFile(command, args, { maxBuffer: 64 * 1048576, ...options });
    } catch (error) {
      error.message = `${command} ${args.join(' ')} failed: ${error.stderr || error.message}`;
      throw error;
    }
  };
  const git = (dir, args, options = {}) => run('git', ['-C', dir, ...args], options);

  // --- 1. Dependencies -----------------------------------------------------
  const depsKey = sha256Text(`${config.conversationRef}:${config.sanitizerRef}`).slice(0, 12);
  const depsDir = join(workDir, 'deps', depsKey);
  if (!existsSync(join(depsDir, 'node_modules', '@link-foundation', 'sensitive-data-sanitizer', 'src', 'index.js'))) {
    log(`>>> Installing pinned libraries into ${depsDir}`);
    mkdirSync(depsDir, { recursive: true });
    writeFileSync(
      join(depsDir, 'package.json'),
      JSON.stringify(
        {
          name: 'archive-public-sessions-deps',
          private: true,
          type: 'module',
          dependencies: {
            '@link-assistant/conversation': `github:link-assistant/conversation#${config.conversationRef}`,
            '@link-foundation/sensitive-data-sanitizer': `github:link-foundation/sensitive-data-sanitizer#${config.sanitizerRef}`,
          },
        },
        null,
        2
      )
    );
    await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev'], { cwd: depsDir });
  }
  await loadLibraries(depsDir); // fail early when the install is broken

  // --- 2. Discover sessions ------------------------------------------------
  const minAgeMs = config.minAge * 60 * 1000;
  const now = Date.now();
  const sessions = []; // { tool, kind, sourcePath, size, mtime, relativeTarget, attribution }
  const skipped = { recent: 0, tooLarge: 0, unattributed: 0, nonGitHub: 0, notPublic: 0, legacyCodexJson: 0, binary: 0 };

  const walk = (dir, visit) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, visit);
      else if (entry.isFile()) visit(path);
    }
  };

  const remoteCache = new Map();
  const gitRemoteFor = async (cwd) => {
    if (remoteCache.has(cwd)) return remoteCache.get(cwd);
    let result = null;
    if (cwd && existsSync(cwd)) {
      try {
        const { stdout } = await git(cwd, ['remote', 'get-url', 'origin']);
        const { stdout: top } = await git(cwd, ['rev-parse', '--show-toplevel']);
        result = { url: stdout.trim(), root: top.trim() };
      } catch (error) {
        debug(`no git remote for ${cwd}: ${error.message.split('\n')[0]}`);
      }
    }
    remoteCache.set(cwd, result);
    return result;
  };

  const firstLines = async (path, count) => {
    const lines = [];
    const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of reader) {
      lines.push(line);
      if (lines.length >= count) break;
    }
    reader.close();
    return lines;
  };

  /** Claude: cwd lives inside the records; Codex: session_meta has git info. */
  const attribute = async (tool, path) => {
    let cwd = null;
    let url = null;
    if (tool === 'claude') {
      for (const line of await firstLines(path, 300)) {
        const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(line);
        if (match) {
          cwd = JSON.parse(`"${match[1]}"`);
          break;
        }
      }
    } else {
      const [first] = await firstLines(path, 1);
      try {
        const record = JSON.parse(first || '{}');
        const payload = record.type === 'session_meta' ? record.payload : null;
        cwd = payload?.cwd ?? null;
        url = payload?.git?.repository_url ?? null;
      } catch {
        // not a session file
      }
    }
    let root = null;
    if (!parseGitHubRepository(url)) {
      const remote = await gitRemoteFor(cwd);
      url = remote?.url ?? url;
      root = remote?.root ?? null;
    }
    const repository = parseGitHubRepository(url);
    return { cwd, url, root, repository };
  };

  const consider = (session) => {
    if (now - session.mtime < minAgeMs) {
      skipped.recent += 1;
      debug(`skip (modified recently): ${session.sourcePath}`);
      return;
    }
    if (session.size > maxSourceBytes) {
      skipped.tooLarge += 1;
      warn(`skip (larger than --max-source-size, ${fmtBytes(session.size)}): ${session.sourcePath}`);
      return;
    }
    sessions.push(session);
  };

  if (config.only !== 'codex') {
    const claudeDir = resolve(config.claudeDir);
    for (const project of existsSync(claudeDir) ? readdirSync(claudeDir, { withFileTypes: true }) : []) {
      if (!project.isDirectory()) continue;
      const projectDir = join(claudeDir, project.name);
      for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const sessionId = entry.name.slice(0, -'.jsonl'.length);
        const sourcePath = join(projectDir, entry.name);
        const stat = statSync(sourcePath);
        const attribution = await attribute('claude', sourcePath);
        const parent = { tool: 'claude', kind: 'jsonl', sourcePath, size: stat.size, mtime: stat.mtimeMs, targetBase: `claude/${sessionId}`, extension: '.jsonl', attribution, project: project.name };
        consider(parent);
        const sessionDir = join(projectDir, sessionId);
        if (!existsSync(sessionDir)) continue;
        walk(join(sessionDir, 'subagents'), (path) => {
          if (!path.endsWith('.jsonl')) return;
          const stat = statSync(path);
          consider({ tool: 'claude', kind: 'jsonl', sourcePath: path, size: stat.size, mtime: stat.mtimeMs, targetBase: `claude/${sessionId}/subagents/${basename(path, '.jsonl')}`, extension: '.jsonl', attribution, project: project.name, parentSession: sessionId });
        });
        if (config.includeToolResults) {
          walk(join(sessionDir, 'tool-results'), (path) => {
            const stat = statSync(path);
            const name = basename(path);
            const dot = name.lastIndexOf('.');
            const extension = dot > 0 ? name.slice(dot) : '.txt';
            const stem = dot > 0 ? name.slice(0, dot) : name;
            consider({ tool: 'claude', kind: 'text', sourcePath: path, size: stat.size, mtime: stat.mtimeMs, targetBase: `claude/${sessionId}/tool-results/${stem}`, extension, attribution, project: project.name, parentSession: sessionId });
          });
        }
      }
    }
  }

  if (config.only !== 'claude') {
    const codexDir = resolve(config.codexDir);
    const files = [];
    walk(codexDir, (path) => files.push(path));
    for (const path of files) {
      if (path.endsWith('.json')) {
        skipped.legacyCodexJson += 1; // 2025-era rollouts carry no cwd/repository
        continue;
      }
      if (!path.endsWith('.jsonl')) continue;
      const stat = statSync(path);
      const attribution = await attribute('codex', path);
      const rel = relative(codexDir, path).split(sep).join('/');
      consider({ tool: 'codex', kind: 'jsonl', sourcePath: path, size: stat.size, mtime: stat.mtimeMs, targetBase: `codex/${rel.slice(0, -'.jsonl'.length)}`, extension: '.jsonl', attribution });
    }
  }

  // --- 3. Visibility -------------------------------------------------------
  const visibilityCache = new Map();
  const visibilityOf = async (repository) => {
    const key = repository.toLowerCase();
    if (visibilityCache.has(key)) return visibilityCache.get(key);
    let info = { visibility: 'unknown', fullName: repository };
    try {
      const { stdout } = await run('gh', ['api', `repos/${repository}`, '--jq', '{visibility: .visibility, full_name: .full_name}']);
      const parsed = JSON.parse(stdout);
      info = { visibility: parsed.visibility, fullName: parsed.full_name };
    } catch (error) {
      debug(`visibility lookup failed for ${repository}: ${error.message.split('\n')[0]}`);
    }
    visibilityCache.set(key, info);
    return info;
  };

  const excludes = new Set((config.exclude || []).map((item) => String(item).toLowerCase()));
  const filters = new Set((config.filter || []).map((item) => String(item).toLowerCase()));
  const eligible = [];
  for (const session of sessions) {
    const { repository, url } = session.attribution;
    if (!repository) {
      if (url) skipped.nonGitHub += 1;
      else skipped.unattributed += 1;
      debug(`skip (${url ? 'non-GitHub remote' : 'no repository'}): ${session.sourcePath}`);
      continue;
    }
    const info = await visibilityOf(repository);
    session.repository = info.fullName;
    session.visibility = info.visibility;
    if (info.visibility !== 'public') {
      skipped.notPublic += 1;
      continue;
    }
    if (excludes.has(info.fullName.toLowerCase()) || excludes.has(repository.toLowerCase())) {
      skipped.excluded = (skipped.excluded ?? 0) + 1;
      continue;
    }
    if (filters.size && !filters.has(info.fullName.toLowerCase()) && !filters.has(repository.toLowerCase())) continue;
    session.targetPath = `${info.fullName}/${session.targetBase}`;
    eligible.push(session);
  }
  eligible.sort((a, b) => a.size - b.size);

  const summarize = (list) => {
    const byRepo = new Map();
    for (const session of list) {
      const entry = byRepo.get(session.repository) ?? { claude: 0, codex: 0, bytes: 0 };
      entry[session.tool] += 1;
      entry.bytes += session.size;
      byRepo.set(session.repository, entry);
    }
    return [...byRepo.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  };

  log(`>>> Discovered ${sessions.length} session files; ${eligible.length} belong to public GitHub repositories`);
  log(`    skipped: ${Object.entries(skipped).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  for (const [repo, entry] of summarize(eligible)) {
    log(`    ${repo.padEnd(48)} claude=${String(entry.claude).padStart(4)} codex=${String(entry.codex).padStart(4)} ${fmtBytes(entry.bytes)}`);
  }
  if (config.list) {
    for (const session of eligible) {
      log(`${session.tool.padEnd(6)} ${fmtBytes(session.size).padStart(10)}  ${session.targetPath}  <-  ${session.sourcePath}`);
    }
    return;
  }

  // --- 4. Known secrets (never logged) --------------------------------------
  const libs = await loadLibraries(depsDir);
  const knownSecrets = new Set();
  const addSecret = (value) => {
    if (typeof value === 'string' && value.length >= 8) knownSecrets.add(value);
  };
  for (const value of libs.sanitizer.knownSecretsFromEnv()) addSecret(value);
  try {
    for (const value of await libs.sanitizer.knownSecretsFromGitHubAuth()) addSecret(value);
  } catch {
    debug('gh auth token unavailable; continuing without it');
  }
  if (config.knownSecretsFile) {
    for (const line of readFileSync(resolve(config.knownSecretsFile), 'utf8').split(/\r?\n/)) addSecret(line.trim());
  }
  const envFileValues = (dir) => {
    const values = [];
    if (!dir || !existsSync(dir)) return values;
    for (const name of readdirSync(dir)) {
      if (!/^\.l?env(\..+)?$/.test(name) || /example|sample|template/i.test(name)) continue;
      const path = join(dir, name);
      if (!statSync(path).isFile()) continue;
      for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*(.+)$/.exec(line);
        if (!match) continue;
        let value = match[2].trim();
        if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
        const key = match[1];
        const tokenLike = value.length >= 16 && !/\s/.test(value) && !/^(https?:\/\/[^@]*|[/~.].*)$/.test(value);
        if (SENSITIVE_KEY.test(key) || tokenLike) values.push(value);
      }
    }
    return values;
  };
  const roots = new Set();
  for (const session of eligible) {
    if (session.attribution.root) roots.add(session.attribution.root);
    else if (session.attribution.cwd) roots.add(session.attribution.cwd);
  }
  roots.add(process.cwd());
  for (const root of roots) for (const value of envFileValues(root)) addSecret(value);
  log(`>>> Known-secret literals loaded: ${knownSecrets.size} (from environment, gh auth and .env/.lenv files of ${roots.size} directories)`);

  // --- 5. Archive repository -----------------------------------------------
  const repository = config.repo;
  const branch = config.branch;
  const cloneDir = join(workDir, 'repos', repository.replace('/', '__'));
  const outputDir = config.dryRun ? join(workDir, 'dry-run', repository.replace('/', '__')) : cloneDir;
  let repoExists = false;
  try {
    await run('gh', ['api', `repos/${repository}`, '--jq', '.full_name']);
    repoExists = true;
  } catch {
    repoExists = false;
  }
  let login = 'unknown';
  try {
    login = (await run('gh', ['api', 'user', '--jq', '.login'])).stdout.trim();
  } catch (error) {
    throw new Error(`GitHub CLI is not authenticated: ${error.message}`);
  }

  if (!repoExists && !config.dryRun) {
    log(`>>> Creating public repository https://github.com/${repository}`);
    await run('gh', ['repo', 'create', repository, '--public', '--description', 'Sanitized Claude Code and Codex sessions for public repositories']);
    repoExists = true;
  }

  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: login, GIT_AUTHOR_EMAIL: `${login}@users.noreply.github.com`, GIT_COMMITTER_NAME: login, GIT_COMMITTER_EMAIL: `${login}@users.noreply.github.com` };
  const existingMeta = new Map(); // targetPath -> meta
  let hasRemoteBranch = false;
  if (repoExists) {
    // Blobless, no-checkout clone + sparse checkout of metadata only: the
    // archive can hold gigabytes, but the coordinator only needs .meta.json.
    if (!existsSync(join(cloneDir, '.git'))) {
      mkdirSync(dirname(cloneDir), { recursive: true });
      log(`>>> Cloning ${repository} (metadata only) into ${cloneDir}`);
      await run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--depth', '1', '--branch', branch, `https://github.com/${repository}.git`, cloneDir]).catch(async (error) => {
        if (!/remote branch .* not found|warning: Remote branch/i.test(error.message)) throw error;
        await run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--depth', '1', `https://github.com/${repository}.git`, cloneDir]);
      });
      await git(cloneDir, ['sparse-checkout', 'set', '--no-cone', '/README.md', `*${META_SUFFIX}`]);
    }
    const remoteHeads = (await git(cloneDir, ['ls-remote', '--heads', 'origin', branch])).stdout.trim();
    hasRemoteBranch = remoteHeads.length > 0;
    if (hasRemoteBranch) {
      await git(cloneDir, ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', branch]);
      await git(cloneDir, ['checkout', '--quiet', '-B', branch, 'FETCH_HEAD'], { env: gitEnv });
      const { stdout } = await git(cloneDir, ['ls-files', '--', `*${META_SUFFIX}`]);
      for (const file of stdout.split('\n').filter(Boolean)) {
        try {
          existingMeta.set(file.slice(0, -META_SUFFIX.length), JSON.parse(readFileSync(join(cloneDir, file), 'utf8')));
        } catch {
          // unreadable metadata is treated as absent
        }
      }
    } else {
      await git(cloneDir, ['checkout', '--quiet', '--orphan', branch], { env: gitEnv }).catch(() => {});
    }
    log(`>>> Archive currently holds ${existingMeta.size} session files`);
  }
  mkdirSync(outputDir, { recursive: true });

  // --- 6. Decide what to process -------------------------------------------
  const todo = [];
  let unchanged = 0;
  for (const session of eligible) {
    const previous = existingMeta.get(session.targetPath);
    if (previous && !config.force) {
      // Hash only when sizes match: a grown session always needs re-upload.
      if (previous.source?.bytes === session.size && previous.sanitized?.sanitizer?.endsWith(config.sanitizerRef)) {
        const sha = await sha256File(session.sourcePath);
        if (sha === previous.source.sha256) {
          unchanged += 1;
          continue;
        }
      }
    }
    todo.push(session);
    if (config.limit && todo.length >= config.limit) break;
  }
  const todoBytes = todo.reduce((sum, session) => sum + session.size, 0);
  log(`>>> ${todo.length} session files to process (${fmtBytes(todoBytes)}), ${unchanged} already archived and unchanged${config.dryRun ? ' [dry run]' : ''}`);
  if (!todo.length) {
    log('>>> Nothing to do');
    return;
  }

  // --- 7. Process with worker processes, commit and push in batches --------
  const secretsList = [...knownSecrets];
  const fakeValues = config.fakeValuesFile ? readFileSync(resolve(config.fakeValuesFile), 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')) : [];
  const results = [];
  const pendingUnits = []; // one unit = all files of one session: { files, bytes }
  let pendingBytes = 0;
  let pushedCommits = 0;
  let processedBytes = 0;
  const started = Date.now();
  const repoOf = (file) => file.split('/').slice(0, 2).join('/');

  const stageFile = async (file) => {
    const { stdout } = await git(cloneDir, ['hash-object', '-w', '--', join(cloneDir, file)]);
    await git(cloneDir, ['update-index', '--add', '--cacheinfo', `100644,${stdout.trim()},${file}`]);
  };

  const commitAndPush = async (message) => {
    await git(cloneDir, ['commit', '--quiet', '--no-verify', '-m', message], { env: gitEnv });
    for (let attempt = 1; ; attempt += 1) {
      try {
        await git(cloneDir, ['push', '--quiet', '-u', 'origin', `${branch}:${branch}`]);
        break;
      } catch (error) {
        const retryable = /non-fast-forward|fetch first|rejected|rpc failed|hung up|timed out|connection|5\d\d|408|429/i.test(error.message);
        if (!retryable || attempt >= 4) throw error;
        warn(`push attempt ${attempt} failed (${error.message.split('\n')[0]}); refreshing and retrying`);
        await git(cloneDir, ['fetch', '--quiet', '--filter=blob:none', 'origin', branch]).catch(() => {});
        await git(cloneDir, ['rebase', '--quiet', 'FETCH_HEAD'], { env: gitEnv }).catch(() => {});
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
    pushedCommits += 1;
  };

  // Pushes are serialized; each commit stays below --push-every bytes so a
  // single push never approaches GitHub's 2 GB limit.
  let pushLock = Promise.resolve();
  const stageAndPush = (final = false) => {
    pushLock = pushLock.catch(() => {}).then(async () => {
      if (config.dryRun) return;
      const units = pendingUnits.splice(0);
      pendingBytes = 0;
      // Visibility can change during a long run: re-check every source
      // repository right before publishing and withhold anything not public.
      const withheld = new Set();
      for (const repo of new Set(units.flatMap((unit) => unit.files.map(repoOf)))) {
        let visibility = 'unknown';
        try {
          visibility = (await run('gh', ['api', `repos/${repo}`, '--jq', '.visibility'])).stdout.trim();
        } catch {
          visibility = 'unknown';
        }
        if (visibility !== 'public') {
          withheld.add(repo);
          warn(`${repo} is ${visibility} at publication time; withholding its sessions`);
        }
      }
      const publishable = [];
      for (const unit of units) {
        if (withheld.has(repoOf(unit.files[0]))) {
          for (const file of unit.files) {
            rmSync(join(cloneDir, file), { force: true });
            if (file.endsWith(META_SUFFIX)) existingMeta.delete(file.slice(0, -META_SUFFIX.length));
          }
        } else publishable.push(unit);
      }
      const batches = [];
      for (const unit of publishable) {
        const last = batches.at(-1);
        if (last && last.bytes + unit.bytes <= pushEveryBytes) {
          last.units.push(unit);
          last.bytes += unit.bytes;
        } else batches.push({ units: [unit], bytes: unit.bytes });
      }
      for (const batch of batches) {
        for (const unit of batch.units) for (const file of unit.files) await stageFile(file);
        const count = batch.units.length;
        await commitAndPush(`Archive ${count} session file(s), ${fmtBytes(batch.bytes)}\n\nSanitized with sensitive-data-sanitizer#${config.sanitizerRef.slice(0, 12)} and converted with conversation#${config.conversationRef.slice(0, 12)}.`);
        log(`>>> Pushed ${count} session file(s) (${fmtBytes(batch.bytes)}) to https://github.com/${repository}`);
        // Payloads are safe in git now; keep only metadata in the sparse worktree.
        for (const unit of batch.units) for (const file of unit.files) if (!file.endsWith(META_SUFFIX)) rmSync(join(cloneDir, file), { force: true });
      }
      if (final) {
        writeFileSync(join(cloneDir, 'README.md'), renderReadme(repository, existingMeta, results));
        await stageFile('README.md');
        const changed = (await git(cloneDir, ['diff', '--cached', '--name-only'])).stdout.trim();
        if (changed) {
          await commitAndPush('Update archive README');
          log('>>> Pushed README update');
        }
      }
    });
    return pushLock;
  };

  const enqueueUnit = (files) => {
    const bytes = files.reduce((sum, file) => sum + statSync(join(outputDir, file)).size, 0);
    pendingUnits.push({ files, bytes });
    pendingBytes += bytes;
  };

  // Reuse outputs of an interrupted run: a local, not yet published
  // .meta.json whose source hash and library commit still match.
  if (!config.dryRun && !config.force) {
    const remaining = [];
    let reused = 0;
    for (const session of todo) {
      const metaFile = `${session.targetPath}${META_SUFFIX}`;
      const metaPath = join(cloneDir, metaFile);
      let meta = null;
      try {
        meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null;
      } catch {
        meta = null;
      }
      const usable =
        meta &&
        !existingMeta.has(session.targetPath) &&
        meta.source?.bytes === session.size &&
        meta.sanitized?.sanitizer?.endsWith(config.sanitizerRef) &&
        meta.sanitized?.conversation?.endsWith(config.conversationRef) &&
        meta.files.every((file) => existsSync(join(cloneDir, file.path))) &&
        (await sha256File(session.sourcePath)) === meta.source.sha256;
      if (usable) {
        reused += 1;
        results.push({ session, meta });
        existingMeta.set(session.targetPath, meta);
        enqueueUnit([...meta.files.map((file) => file.path), metaFile]);
        if (pendingBytes >= pushEveryBytes) await stageAndPush(false);
      } else remaining.push(session);
    }
    if (reused) log(`>>> Reusing ${reused} session file(s) already sanitized by an interrupted run`);
    todo.splice(0, todo.length, ...remaining);
  }

  const processInWorker = (session) =>
    new Promise((done) => {
      const spec = {
        tool: session.tool,
        kind: session.kind,
        sourcePath: session.sourcePath,
        outputDir,
        targetBase: session.targetPath,
        extension: session.extension,
        chunkBytes,
        depsDir,
        repository: session.repository,
        knownSecrets: secretsList,
        fakeValues,
        sanitizerRef: config.sanitizerRef,
        conversationRef: config.conversationRef,
      };
      const child = spawn(process.execPath, ['--max-old-space-size=6144', SCRIPT_PATH, '--process-one'], { stdio: ['pipe', 'pipe', VERBOSE ? 'inherit' : 'ignore'] });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('close', (code, signal) => {
        const last = stdout.trim().split('\n').pop() || '';
        try {
          done(JSON.parse(last));
        } catch {
          done({ ok: false, error: `worker exited with ${signal ? `signal ${signal}` : `code ${code}`} without a result` });
        }
      });
      child.on('error', (error) => done({ ok: false, error: error.message }));
      child.stdin.end(JSON.stringify(spec));
    });

  let index = 0;
  let active = 0;
  let activeLarge = 0;
  const largeBytes = parseSize(config.largeSize, 50 * 1048576);
  let finished = 0;
  const queue = [...todo];
  const failures = [];
  await new Promise((resolveAll) => {
    const pump = () => {
      while (active < config.jobs && queue.length) {
        // Large sessions need gigabytes of RAM each: cap how many run together.
        const pick = queue.findIndex((item) => item.size <= largeBytes || activeLarge < config.largeJobs);
        if (pick < 0) break;
        const [session] = queue.splice(pick, 1);
        const isLarge = session.size > largeBytes;
        if (isLarge) activeLarge += 1;
        const position = ++index;
        active += 1;
        const label = `${session.repository} ${session.targetBase}`;
        log(`>>> [${position}/${todo.length}] sanitizing ${label} (${fmtBytes(session.size)})`);
        processInWorker(session).then(async (result) => {
          active -= 1;
          if (isLarge) activeLarge -= 1;
          finished += 1;
          processedBytes += session.size;
          if (result.ok) {
            results.push({ session, meta: result.meta });
            existingMeta.set(session.targetPath, result.meta);
            enqueueUnit(result.files);
            const failedParts = result.meta.conversions.filter((c) => !c.ok).length;
            const blocked = result.meta.sanitized.blockedPieces;
            log(`    done ${label}: ${result.meta.sanitized.redactions} redactions, ${result.files.length} files${blocked ? `, ${blocked} piece(s) fully redacted` : ''}${failedParts ? `, ${failedParts} lino conversion error(s)` : ''}, ${fmtDuration(result.meta.durationMs)}; elapsed ${fmtDuration(Date.now() - started)}, ${fmtBytes(processedBytes)}/${fmtBytes(todoBytes)}`);
          } else {
            failures.push({ session, error: result.error });
            warn(`failed ${label}: ${String(result.error).split('\n')[0]}`);
          }
          if (pendingBytes >= pushEveryBytes) {
            stageAndPush(false).catch((error) => warn(`push failed: ${error.message}`));
          }
          if (!queue.length && active === 0) resolveAll();
          else pump();
        });
      }
    };
    if (!queue.length) resolveAll();
    else pump();
  });

  await stageAndPush(true);

  // --- 8. Report ------------------------------------------------------------
  const report = {
    repository,
    dryRun: config.dryRun,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    discovered: sessions.length,
    eligible: eligible.length,
    unchanged,
    processed: results.length,
    failed: failures.map((f) => ({ source: f.session.sourcePath, target: f.session.targetPath, error: String(f.error).split('\n')[0] })),
    skipped,
    pushedCommits,
    sessions: results.map((r) => ({ target: r.session.targetPath, bytes: r.session.size, redactions: r.meta.sanitized.redactions, files: r.meta.files.map((f) => f.path), conversions: r.meta.conversions })),
  };
  const reportPath = join(workDir, `report-${new Date(started).toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  log('');
  log(`>>> Done in ${fmtDuration(report.durationMs)}: ${results.length} processed, ${failures.length} failed, ${unchanged} unchanged, ${finished} total handled`);
  if (config.dryRun) log(`>>> Dry run output: ${outputDir}`);
  else log(`>>> Archive: https://github.com/${repository}`);
  log(`>>> Report: ${reportPath}`);
  if (failures.length) {
    log('>>> Failures:');
    for (const failure of failures) log(`    ${failure.session.targetPath}: ${String(failure.error).split('\n')[0]}`);
    process.exitCode = 2;
  }
}

function renderReadme(repository, metaByPath, latest) {
  const rows = new Map();
  for (const [targetPath, meta] of metaByPath) {
    const [owner, repo, tool] = targetPath.split('/');
    if (!owner || !repo || !tool) continue;
    const key = `${owner}/${repo}`;
    const row = rows.get(key) ?? { claude: 0, codex: 0, bytes: 0 };
    if (tool === 'claude' || tool === 'codex') row[tool] += meta.kind === 'jsonl' ? 1 : 0;
    row.bytes += meta.source?.bytes ?? 0;
    rows.set(key, row);
  }
  const table = [...rows.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([repo, row]) => `| [${repo}](https://github.com/${repo}) | [${row.claude}](./${repo}/claude) | [${row.codex}](./${repo}/codex) | ${fmtBytes(row.bytes)} |`)
    .join('\n');
  return `# Public repositories sessions archive

Sanitized AI coding sessions (Claude Code and Codex CLI) recorded while working on public GitHub repositories.

Every session is published twice:

- \`*.jsonl\` — the original session log, sanitized record by record;
- \`*.lino\` — the same session as a portable [conversation archive](https://github.com/link-assistant/conversation) in Links Notation.

A \`*.meta.json\` file next to each session records the source hash, sizes, redaction counts and the exact library commits used. Files above GitHub's size limit are split into \`*.part-NNN.*\` pieces at line boundaries.

Sanitization is done offline with [sensitive-data-sanitizer](https://github.com/link-foundation/sensitive-data-sanitizer): credentials, tokens, personal data and known secret literals are replaced with \`[REDACTED]\`. Detection has limits; if you spot anything that should not be here, please open an issue in this repository.

| Repository | Claude Code sessions | Codex sessions | Source size |
| --- | ---: | ---: | ---: |
${table}

Generated by \`archive-public-sessions.mjs\`; last update archived ${latest.length} session file(s) on ${new Date().toISOString().slice(0, 10)}.
`;
}

if (process.argv.includes('--process-one')) {
  await runWorker();
} else {
  await runCoordinator().catch((error) => {
    console.error(`>>> ERROR: ${error.message}`);
    if (process.env.DEBUG) console.error(error.stack);
    process.exit(1);
  });
}
