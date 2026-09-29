#!/usr/bin/env node
/**
 * Zips the CONTENTS of dist/ into scoutfox-chrome-extension.zip at the repo root, with
 * manifest.json at the root of the zip. No dependencies: the zip format is written here with
 * node:zlib (deflate, and zlib.crc32, which needs Node 22.2 or newer).
 *
 *   - sourcemaps (*.map) and OS junk files are left out, they are for debugging only
 *   - the zip goes to the repo root and not into dist/, a zip inside the folder it zips would
 *     end up in the next zip
 *   - the same dist/ gives the same zip (sorted names, one fixed timestamp), so a rebuild can be
 *     compared by hash
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(ROOT, 'scoutfox-chrome-extension.zip');
const EXCLUDE = /(?:\.map|(?:^|\/)\.DS_Store|(?:^|\/)Thumbs\.db)$/;

// MS-DOS time and date for 1980-01-01 00:00:00, the earliest a zip can store (year 0 = 1980).
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

function fail(message) {
  console.error(`zip: ${message}`);
  process.exit(1);
}

/** Files under dir as posix paths relative to it. */
function files(dir, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...files(path.join(dir, entry.name), rel));
    else if (entry.isFile()) found.push(rel);
  }
  return found;
}

// Little-endian fields, as in APPNOTE.TXT. No zip64: dist/ is far below its limits.
function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function main() {
  if (typeof zlib.crc32 !== 'function') fail(`needs Node 22.2 or newer (zlib.crc32), this is ${process.version}`);
  if (!fs.existsSync(DIST) || !fs.statSync(DIST).isDirectory()) fail('dist/ not found. Run `npm run build` first.');
  if (!fs.existsSync(path.join(DIST, 'manifest.json'))) fail('dist/manifest.json not found, dist/ is not a built extension. Run `npm run build` first.');

  // manifest.json first, the rest sorted.
  const names = files(DIST).filter((name) => !EXCLUDE.test(name)).sort((a, b) => (a === 'manifest.json' ? -1 : b === 'manifest.json' ? 1 : a < b ? -1 : a > b ? 1 : 0));
  if (names.length > 0xffff) fail(`${names.length} files, more than a plain zip can hold`);

  const parts = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const data = fs.readFileSync(path.join(DIST, ...name.split('/')));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length; // already-compressed data (PNG) can grow when deflated
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const nameBytes = Buffer.from(name, 'utf8');
    const flags = nameBytes.length === name.length ? 0 : 0x0800; // bit 11: the name is UTF-8
    const crc = zlib.crc32(data);
    if (body.length > 0xffffffff || offset > 0xffffffff) fail(`${name}: too big for a plain zip`);

    parts.push(
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(body.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, body
    );
    central.push(
      u32(0x02014b50), u16(0x031e), u16(20), u16(flags), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(body.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
      u32(0o100644 << 16), u32(offset), nameBytes
    );
    offset += 30 + nameBytes.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(names.length), u16(names.length), u32(centralBuffer.length), u32(offset), u16(0)
  ]);
  const zip = Buffer.concat([...parts, centralBuffer, end]);
  fs.rmSync(OUT, { force: true });
  fs.writeFileSync(OUT, zip);

  console.log(`zip: ${path.relative(ROOT, OUT)}, ${names.length} files, ${(zip.length / 1024).toFixed(1)} KB (sourcemaps left out)`);
  for (const name of names) console.log(`  ${name}`);
}

main();
