import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { RELEASE, applyRelease, changes, clearOld, fetchRelease, newer, openRelease } from './update.mjs';

const scratch = join(resolve(import.meta.dirname), '.tools/.scratch');
mkdirSync(scratch, { recursive: true });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const KEY = publicKey.export({ type: 'spki', format: 'pem' });
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** a release of `files` ({ path: text }), signed, and the server's files for it */
function release(version, files, key = privateKey) {
  const manifest = JSON.stringify({ name: 'render-station', version, published: new Date().toISOString(), files: Object.fromEntries(Object.entries(files).map(([p, t]) => [p, { sha256: sha256(Buffer.from(t)), size: Buffer.byteLength(t) }])) });
  const text = JSON.stringify({ manifest, signature: sign(null, Buffer.from(manifest), key).toString('base64') });
  const served = Object.fromEntries(Object.values(files).map((t) => [`files/${sha256(Buffer.from(t))}.gz`, gzipSync(Buffer.from(t))]));
  return { text, served, m: openRelease(text, KEY) };
}
function fixture(files) {
  const root = mkdtempSync(join(scratch, 'update-test-'));
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(root, p, '..'), { recursive: true });
    writeFileSync(join(root, p), t);
  }
  return { root, stage: join(root, '.tools/update'), close: () => rmSync(root, { recursive: true, force: true }) };
}

test('a release opens only if the release key signed it, as it was signed', () => {
  const { text } = release('1.2.3', { 'a.mjs': 'a' });
  assert.equal(openRelease(text, KEY).version, '1.2.3');
  const other = generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => openRelease(release('1.2.3', { 'a.mjs': 'a' }, other).text, KEY), /not signed/);
  const outer = JSON.parse(text);
  outer.manifest = outer.manifest.replace('1.2.3', '9.9.9');
  assert.throws(() => openRelease(JSON.stringify(outer), KEY), /not signed/);
  assert.throws(() => release('1.0.0', { '../escape.mjs': 'x' }), /listed wrongly/);
  assert.throws(() => openRelease('{}', KEY), /no manifest/);
});

test('versions compare part by part', () => {
  assert.ok(newer('0.10.0', '0.9.9'));
  assert.ok(newer('1.0.0', '0.99.99'));
  assert.ok(!newer('0.2.0', '0.2.0'));
  assert.ok(!newer('0.1.9', '0.2.0'));
});

test('an update fetches what changed, swaps it in, sets the old aside and clears it later', async () => {
  const now = release('1.0.0', { 'a.mjs': 'a1', 'b.mjs': 'b1', 'gone.txt': 'x' });
  const next = release('1.1.0', { 'a.mjs': 'a2', 'b.mjs': 'b1', 'node/new.exe': 'n' });
  const f = fixture({ 'a.mjs': 'a1', 'b.mjs': 'b1', 'gone.txt': 'x', [RELEASE]: now.text });
  try {
    assert.deepEqual(changes(f.root, now.m, next.m), { fetch: ['a.mjs', 'node/new.exe'], drop: ['gone.txt'] });
    const asked = [];
    const get = async (path) => (asked.push(path), next.served[path]);
    await fetchRelease({ root: f.root, stage: f.stage, now: now.m, next: next.m, get });
    assert.equal(asked.length, 2);
    const changed = applyRelease({ root: f.root, stage: f.stage, now: now.m, next: next.m, text: next.text });
    assert.deepEqual(changed.sort(), ['a.mjs', 'gone.txt', 'node/new.exe']);
    assert.equal(readFileSync(join(f.root, 'a.mjs'), 'utf8'), 'a2');
    assert.equal(readFileSync(join(f.root, 'node/new.exe'), 'utf8'), 'n');
    assert.ok(!existsSync(join(f.root, 'gone.txt')));
    assert.equal(readFileSync(join(f.root, 'a.mjs.old'), 'utf8'), 'a1');
    assert.equal(openRelease(readFileSync(join(f.root, RELEASE), 'utf8'), KEY).version, '1.1.0');
    clearOld(f.stage);
    assert.ok(!existsSync(join(f.root, 'a.mjs.old')));
    assert.ok(!existsSync(join(f.root, 'gone.txt.old')));
  } finally { f.close(); }
});

test('a file that is not what the release lists is refused before anything changes', async () => {
  const now = release('1.0.0', { 'a.mjs': 'a1' });
  const next = release('1.1.0', { 'a.mjs': 'a2' });
  const f = fixture({ 'a.mjs': 'a1', [RELEASE]: now.text });
  try {
    const get = async () => gzipSync(Buffer.from('tampered'));
    await assert.rejects(fetchRelease({ root: f.root, stage: f.stage, now: now.m, next: next.m, get }), /not the file the release lists/);
    assert.equal(readFileSync(join(f.root, 'a.mjs'), 'utf8'), 'a1');
  } finally { f.close(); }
});

test('an update that cannot go in whole is put back as it was', async () => {
  const now = release('1.0.0', { 'a.mjs': 'a1' });
  const next = release('1.1.0', { 'a.mjs': 'a2', 'x/y.txt': 'y' });
  const f = fixture({ 'a.mjs': 'a1', [RELEASE]: now.text });
  // x/y.txt needs a folder where a file of no release's is
  writeFileSync(join(f.root, 'x'), 'in the way');
  try {
    await fetchRelease({ root: f.root, stage: f.stage, now: now.m, next: next.m, get: async (p) => next.served[p] });
    assert.throws(() => applyRelease({ root: f.root, stage: f.stage, now: now.m, next: next.m, text: next.text }));
    assert.equal(readFileSync(join(f.root, 'a.mjs'), 'utf8'), 'a1');
    assert.ok(!existsSync(join(f.root, 'a.mjs.old')));
    assert.equal(openRelease(readFileSync(join(f.root, RELEASE), 'utf8'), KEY).version, '1.0.0');
  } finally { f.close(); }
});
