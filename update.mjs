// Updates of an installed copy: one the installer put in place, with its release.json. The update
// server publishes latest.json, a manifest (the version, and every file with its size and SHA-256)
// with its signature by the release key, whose public half is KEY below; and the files themselves,
// as files/<sha256>.gz, never changed once there. An update fetches the files whose hash changed and
// checks each against the manifest, then swaps them in: the old ones renamed *.old (on Windows a
// running program can be renamed, not deleted) and removed at the next start. Should one not go in,
// all are put back as they were.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { safeRel } from './workspace.mjs';

/** where the releases are published */
export const SERVER = 'https://8.137.206.169/assets/render-station/';
/** the release key's public half: only what it signed is installed */
export const KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAZIbkSxZl+TY3+xmBjhvyG0+1uOZ8R/8ePeMRd/56ZgY=
-----END PUBLIC KEY-----
`;
/** an installed copy's release, as published */
export const RELEASE = 'release.json';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const readList = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
};

/** a release as published (latest.json, or an installed copy's release.json): its manifest, if the
 *  release key signed it and it is sound */
export function openRelease(text, key = KEY) {
  let outer;
  try {
    outer = JSON.parse(text);
  } catch {
    throw new Error('release: not JSON');
  }
  const { manifest, signature } = outer ?? {};
  if (typeof manifest !== 'string' || typeof signature !== 'string') throw new Error('release: no manifest or signature');
  if (!verify(null, Buffer.from(manifest), createPublicKey(key), Buffer.from(signature, 'base64'))) throw new Error('release: not signed with the release key');
  const m = JSON.parse(manifest);
  if (m?.name !== 'render-station' || !/^\d+\.\d+\.\d+$/.test(m.version ?? '') || !m.files || typeof m.files !== 'object') throw new Error('release: not a render-station release');
  for (const [path, f] of Object.entries(m.files))
    if (!safeRel(path) || path === RELEASE || !/^[0-9a-f]{64}$/.test(f?.sha256 ?? '') || !Number.isSafeInteger(f.size) || f.size < 0) throw new Error(`release: a file listed wrongly: ${path}`);
  return m;
}

/** whether version `a` (x.y.z) comes after `b` */
export function newer(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** what going from release `now` to `next` takes: the files to fetch (changed, or missing here)
 *  and those to remove */
export function changes(root, now, next) {
  const fetch = Object.entries(next.files)
    .filter(([path, f]) => now?.files?.[path]?.sha256 !== f.sha256 || !existsSync(join(root, path)))
    .map(([path]) => path);
  const drop = Object.keys(now?.files ?? {}).filter((path) => !Object.hasOwn(next.files, path));
  return { fetch, drop };
}

/** fetches into `stage` the files going to `next` takes, each checked against its hash: `get(path)`,
 *  a file of the server's as bytes; `progress(done, total)` after each */
export async function fetchRelease({ root, stage, now, next, get, progress = () => {} }) {
  const { fetch } = changes(root, now, next);
  mkdirSync(stage, { recursive: true });
  let done = 0;
  for (const path of fetch) {
    const f = next.files[path];
    const staged = join(stage, f.sha256);
    if (!(existsSync(staged) && sha256(readFileSync(staged)) === f.sha256)) {
      let data = null;
      try {
        // never more than the release says it is
        data = gunzipSync(await get(`files/${f.sha256}.gz`), { maxOutputLength: Math.max(f.size, 1) });
      } catch (e) {
        if (!(e instanceof RangeError) && e.code !== 'Z_DATA_ERROR') throw e;
      }
      if (!data || data.length !== f.size || sha256(data) !== f.sha256) throw new Error(`${path}: not the file the release lists`);
      writeFileSync(staged, data);
    }
    progress(++done, fetch.length);
  }
}

/** puts release `next` in place from what fetchRelease staged, and keeps `text` (the release as
 *  published) as release.json: the paths it changed */
export function applyRelease({ root, stage, now, next, text }) {
  const { fetch, drop } = changes(root, now, next);
  const undo = [];
  const aside = [];
  const setAside = (target) => {
    let to = `${target}.old`;
    try {
      rmSync(to, { force: true });
    } catch {
      // the one set aside last time, still running
      to = `${target}.old-${Date.now()}`;
    }
    renameSync(target, to);
    aside.push(to);
    undo.push(() => renameSync(to, target));
  };
  try {
    for (const path of drop) if (existsSync(join(root, path))) setAside(join(root, path));
    for (const path of fetch) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) setAside(target);
      copyFileSync(join(stage, next.files[path].sha256), target);
      undo.push(() => rmSync(target, { force: true }));
    }
    writeFileSync(join(root, `${RELEASE}.new`), text);
    renameSync(join(root, `${RELEASE}.new`), join(root, RELEASE));
  } catch (e) {
    for (const step of undo.reverse())
      try {
        step();
      } catch {}
    throw e;
  }
  for (const path of fetch) rmSync(join(stage, next.files[path].sha256), { force: true });
  const list = join(stage, 'old.json');
  writeFileSync(list, JSON.stringify([...readList(list), ...aside]));
  return [...fetch, ...drop];
}

/** removes what earlier updates set aside, as far as it can: one still running stays for next time */
export function clearOld(stage) {
  const list = join(stage, 'old.json');
  if (!existsSync(list)) return;
  const left = readList(list).filter((file) => {
    try {
      rmSync(file, { force: true });
      return false;
    } catch {
      return true;
    }
  });
  if (left.length) writeFileSync(list, JSON.stringify(left));
  else rmSync(list, { force: true });
}
