// Puts a release together, into .tools/release/out/: everything an installed copy holds (the
// station's files as committed, the window's fonts with their licenses, Node.js for Windows with its
// license), the manifest listing each with its size and SHA-256 signed with the release key
// (.tools/release/key.pem, whose public half is update.mjs's KEY), the files as files/<sha256>.gz for
// updates, and the installer: exe/setup.c's program with the release appended as a gzipped tar.
// release/publish.mjs then puts it on the update server. The version is package.json's.
// usage: node release/build.mjs [--dirty]
import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, inflateRawSync } from 'node:zlib';
import { KEY, openRelease } from '../update.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const tools = join(repo, '.tools/release');
const out = join(tools, 'out');
/** the Node.js an installed copy runs: an LTS release */
const NODE = 'v24.22.1';
/** the station's own files (render-station.json and exe/compile.mjs: its own folder, registered as a
 *  workspace, compiles 渲染站.exe; exe/build.mjs) */
const APP = ['station.mjs', 'worker.mjs', 'shell.mjs', 'workspace.mjs', 'update.mjs', 'cli.mjs', 'station.html', '渲染站.exe', 'WebView2Loader.dll', 'render-station.json', 'exe/compile.mjs', 'LICENSE', 'README.md', 'README.zh-CN.md'];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

// ——— built from what is committed, and signed with the key stations check against ———
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
if (!process.argv.includes('--dirty') && git(['status', '--porcelain', '--untracked-files=no']).trim()) {
  console.error('uncommitted changes: commit them first, or build with --dirty');
  process.exit(1);
}
const key = createPrivateKey(readFileSync(join(tools, 'key.pem')));
if (createPublicKey(key).export({ type: 'spki', format: 'pem' }) !== KEY) {
  console.error('.tools/release/key.pem is not the key whose public half update.mjs has (KEY)');
  process.exit(1);
}

/** a zip's files, one by its name */
function unzip(zip) {
  // the end of the central directory, within the zip's last 64 KiB
  let end = zip.length - 22;
  while (end > 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  const count = zip.readUInt16LE(end + 10);
  const index = new Map();
  for (let i = 0, at = zip.readUInt32LE(end + 16); i < count; i++) {
    const name = zip.toString('utf8', at + 46, at + 46 + zip.readUInt16LE(at + 28));
    index.set(name, { method: zip.readUInt16LE(at + 10), size: zip.readUInt32LE(at + 20), local: zip.readUInt32LE(at + 42) });
    at += 46 + zip.readUInt16LE(at + 28) + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return (name) => {
    const e = index.get(name);
    if (!e) throw new Error(`not in the zip: ${name}`);
    const start = e.local + 30 + zip.readUInt16LE(e.local + 26) + zip.readUInt16LE(e.local + 28);
    const data = zip.subarray(start, start + e.size);
    return e.method === 0 ? Buffer.from(data) : inflateRawSync(data);
  };
}

/** Node.js for Windows, fetched once and checked against the hashes nodejs.org lists */
async function node() {
  const name = `node-${NODE}-win-x64.zip`;
  const zip = join(tools, 'node', name);
  if (!existsSync(zip)) {
    console.log(`fetching ${name}`);
    const sums = await (await fetch(`https://nodejs.org/dist/${NODE}/SHASUMS256.txt`)).text();
    const want = sums.split('\n').find((line) => line.endsWith(`  ${name}`))?.split(' ')[0];
    const data = Buffer.from(await (await fetch(`https://nodejs.org/dist/${NODE}/${name}`)).arrayBuffer());
    if (!want || sha256(data) !== want) throw new Error(`${name}: not the file nodejs.org lists`);
    mkdirSync(dirname(zip), { recursive: true });
    writeFileSync(zip, data);
  }
  const file = unzip(readFileSync(zip));
  const base = `node-${NODE}-win-x64`;
  return { 'node/node.exe': file(`${base}/node.exe`), 'node/LICENSE': file(`${base}/LICENSE`) };
}

/** the fonts the window loads (station.mjs serves them from node_modules), and their licenses */
function fonts() {
  const lxgw = 'node_modules/lxgw-wenkai-webfont';
  const outfit = 'node_modules/@fontsource-variable/outfit';
  const css = readFileSync(join(repo, lxgw, 'lxgwwenkai-regular.css'), 'utf8');
  const paths = [
    `${lxgw}/lxgwwenkai-regular.css`,
    ...new Set([...css.matchAll(/url\(['"]?\.\/([^'")]+)/g)].map((m) => `${lxgw}/${m[1]}`)),
    `${lxgw}/LICENSE`,
    `${lxgw}/OFL.txt`,
    `${outfit}/files/outfit-latin-wght-normal.woff2`,
    `${outfit}/LICENSE`,
  ];
  return Object.fromEntries(paths.map((p) => [p, readFileSync(join(repo, p))]));
}

/** a tar of `files` ({ path: bytes }), POSIX pax: each name in UTF-8 too, as Windows' tar reads it */
function tar(files, mtime) {
  const blocks = [];
  const padded = (data) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  const octal = (n, width) => `${n.toString(8).padStart(width - 1, '0')}\0`;
  const header = (name, size, type) => {
    const h = Buffer.alloc(512);
    h.write(name.replace(/[^\x20-\x7e]/g, '_').slice(0, 99), 0, 'ascii');
    h.write(octal(0o644, 8), 100);
    h.write(octal(0, 8), 108);
    h.write(octal(0, 8), 116);
    h.write(octal(size, 12), 124);
    h.write(octal(mtime, 12), 136);
    h.write(' '.repeat(8), 148);
    h.write(type, 156);
    h.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return h;
  };
  // a record counts its own length's digits
  const record = (k, v) => {
    const body = ` ${k}=${v}\n`;
    let len = Buffer.byteLength(body);
    while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
    return Buffer.from(`${len}${body}`);
  };
  for (const [path, data] of Object.entries(files)) {
    const pax = record('path', path);
    blocks.push(header(`PaxHeader/${path}`, pax.length, 'x'), padded(pax), header(path, data.length, '0'), padded(data));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ——— the release: the files, the signed manifest, each file for updates ———
const files = { ...Object.fromEntries(APP.map((p) => [p, readFileSync(join(repo, p))])), ...fonts(), ...(await node()) };
const published = new Date();
const setup = `render-station-setup-${version}.exe`;
const manifest = JSON.stringify({
  name: 'render-station',
  version,
  published: published.toISOString(),
  files: Object.fromEntries(Object.entries(files).map(([path, data]) => [path, { sha256: sha256(data), size: data.length }])),
  setup,
});
const text = `${JSON.stringify({ manifest, signature: sign(null, Buffer.from(manifest), key).toString('base64') })}\n`;
// as a station reads it
openRelease(text);
mkdirSync(join(out, 'files'), { recursive: true });
for (const data of Object.values(files)) {
  const blob = join(out, 'files', `${sha256(data)}.gz`);
  if (!existsSync(blob)) writeFileSync(blob, gzipSync(data, { level: 9 }));
}
writeFileSync(join(out, 'latest.json'), text);

// ——— the installer: its program, the release as a gzipped tar, its version, the tar's size, the mark ———
execFileSync(process.execPath, [join(repo, 'exe/build.mjs'), '--setup'], { stdio: 'inherit' });
const payload = gzipSync(tar({ ...files, 'release.json': Buffer.from(text) }, Math.floor(published / 1000)), { level: 9 });
const tail = Buffer.alloc(48);
tail.write(version, 0, 32, 'utf8');
tail.writeBigUInt64LE(BigInt(payload.length), 32);
tail.write('RSSETUP1', 40, 'ascii');
const installer = Buffer.concat([readFileSync(join(repo, '.tools/exe-build/setup.exe')), payload, tail]);
writeFileSync(join(out, setup), installer);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`release ${version}: ${Object.keys(files).length} files, ${mb(Object.values(files).reduce((n, d) => n + d.length, 0))}; installer ${mb(installer.length)}`);
console.log(join(out, setup));
