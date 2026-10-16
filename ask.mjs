// On lemon: has the render worker on the owner's machine (remote/worker.mjs, kept up there by the
// render station, station.mjs, with the SSH tunnel it opens to lemon) render the cut with
// promo/render.mjs, lib/ and stage/ as they stand here, changes not yet committed included. What
// comes back lands in .tools/.scratch/promo/remote/<time>/. Takes render.mjs's own options; a
// clip is always half size at 15 fps.
// usage: node promo/remote/ask.mjs --stills 19.9,20.3 [--preview] [--partial]
//        node promo/remote/ask.mjs --cover
//        node promo/remote/ask.mjs --from 9.45 --to 21.45 [--partial] [--no-voice]
// PROMO_REMOTE: the worker's port on lemon, if not found among the tunnel's (PORTS)
import { request } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PORTS } from './worker.mjs';

const promo = fileURLToPath(new URL('..', import.meta.url));
const HEADERS = { 'x-qiqi-worker': '1' };

/** a request to the worker on `port`: the reply's status and body */
const call = (port, method, path, body, timeout = 0) =>
  new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...HEADERS, ...(body ? { 'content-type': 'application/json', 'content-encoding': 'gzip' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', fail);
    req.end(body);
  });

// which port the tunnel came in on: the one where the worker answers (a port left over from a
// connection that died answers nothing)
let port = process.env.PROMO_REMOTE ? Number(process.env.PROMO_REMOTE) : null;
for (const p of port ? [] : PORTS) {
  const hello = await call(p, 'GET', '/hello', null, 1500).catch(() => null);
  if (hello?.status === 200 && JSON.parse(hello.body).worker === 'qiqi-promo') {
    port = p;
    break;
  }
}
if (!port) {
  console.error("no render worker on lemon: on the owner's machine the render station is not running, or is paused (promo/remote/渲染站.exe)");
  process.exit(1);
}

const files = {};
const add = (path) => (files[path] = readFileSync(join(promo, '..', path)).toString('base64'));
add('promo/render.mjs');
for (const dir of ['lib', 'stage']) for (const name of readdirSync(join(promo, dir))) add(`promo/${dir}/${name}`);

const t0 = Date.now();
const res = await call(port, 'POST', '/job', gzipSync(JSON.stringify({ files, args: process.argv.slice(2) }))).catch((e) => {
  console.error(`the worker went away: ${e.message}`);
  process.exit(1);
});
if (res.status === 409) {
  console.error('the worker is busy with another job');
  process.exit(1);
}
if (res.status !== 200) {
  console.error(`the worker answered ${res.status}`);
  process.exit(1);
}
const reply = JSON.parse(gunzipSync(res.body));

// the end of the worker's log: render.mjs's last lines, or what went wrong
console.log(reply.log.trim().split('\n').slice(-8).join('\n'));
const dir = join(promo, '..', '.tools/.scratch/promo/remote', new Date().toISOString().replace(/[:.]/g, '-'));
for (const [path, data] of Object.entries(reply.files)) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), Buffer.from(data, 'base64'));
  console.log(join(dir, path));
}
console.log(`${reply.ok ? 'done' : 'failed'} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(reply.ok ? 0 : 1);
