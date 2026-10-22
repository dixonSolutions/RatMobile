#!/usr/bin/env node
// Builds dist/: unpacked folder, zip (for "Load unpacked"), signed CRX3 and updates.xml.
//
// Env:
//   RATMOBILE_VERSION   override manifest version (CI sets 0.<minor>.<run_number>)
//   RATMOBILE_KEY       PEM private key contents (CI secret)
//   RATMOBILE_KEY_FILE  path to PEM key (default ~/.config/ratmobile/key.pem)
//   RATMOBILE_BASE_URL  where updates.xml / ratmobile.crx are hosted
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync, cpSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { homedir } from 'node:os';
import { deflateRawSync, crc32 } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { packCrx3, extensionId } from './crx3.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'extension');
const dist = process.env.RATMOBILE_DIST || join(root, 'dist');
const baseUrl = (process.env.RATMOBILE_BASE_URL || 'https://dixonsolutions.github.io/RatMobile').replace(/\/$/, '');

function listFiles(dir) {
  return readdirSync(dir).sort().flatMap((name) => {
    const p = join(dir, name);
    if (name.startsWith('.')) return [];
    return statSync(p).isDirectory() ? listFiles(p) : [p];
  });
}

// Tiny deterministic zip writer (deflate, fixed 1980 timestamps).
function zipFiles(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name);
    const deflated = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, deflated);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function loadKey() {
  if (process.env.RATMOBILE_KEY) return process.env.RATMOBILE_KEY;
  const file = process.env.RATMOBILE_KEY_FILE || join(homedir(), '.config/ratmobile/key.pem');
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
if (process.env.RATMOBILE_VERSION) manifest.version = process.env.RATMOBILE_VERSION;
manifest.update_url = `${baseUrl}/updates.xml`;
const version = manifest.version;

rmSync(dist, { recursive: true, force: true });
const unpacked = join(dist, 'ratmobile');
mkdirSync(unpacked, { recursive: true });
cpSync(src, unpacked, { recursive: true });
writeFileSync(join(unpacked, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const files = listFiles(unpacked).map((p) => ({ name: relative(unpacked, p), data: readFileSync(p) }));
const zip = zipFiles(files);
writeFileSync(join(dist, 'ratmobile.zip'), zip);

const key = loadKey();
let id = null;
if (key) {
  id = extensionId(key);
  writeFileSync(join(dist, 'ratmobile.crx'), packCrx3(zip, key));
  writeFileSync(
    join(dist, 'updates.xml'),
    `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${baseUrl}/ratmobile-${version}.crx' version='${version}' />
  </app>
</gupdate>
`,
  );
  // Versioned copy so the updater never fetches a stale cached CRX.
  writeFileSync(join(dist, `ratmobile-${version}.crx`), packCrx3(zip, key));
} else {
  console.warn('No signing key found: skipped CRX + updates.xml (zip only).');
}
writeFileSync(join(dist, 'version.json'), JSON.stringify({ version, id, built: new Date().toISOString() }, null, 2) + '\n');
console.log(`Built RatMobile ${version}${id ? ` (${id})` : ''} -> ${relative(root, dist)}/`);
