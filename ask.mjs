// On lemon: has the render worker on the owner's machine (remote/worker.mjs, reached through the
// SSH tunnel it opens to lemon) render the cut with promo/render.mjs, lib/ and stage/ as they stand
// here, changes not yet committed included. What comes back lands in
// .tools/.scratch/promo/remote/<time>/. Takes render.mjs's own options; a clip is always half size
// at 15 fps.
// usage: node promo/remote/ask.mjs --stills 19.9,20.3 [--preview] [--partial]
//        node promo/remote/ask.mjs --cover
//        node promo/remote/ask.mjs --from 9.45 --to 21.45 [--partial] [--no-voice]
// PROMO_REMOTE: the worker's port on lemon (7700)
import { request } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const promo = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PROMO_REMOTE ?? 7700);
const files = {};
const add = (path) => (files[path] = readFileSync(join(promo, '..', path)).toString('base64'));
add('promo/render.mjs');
for (const dir of ['lib', 'stage']) for (const name of readdirSync(join(promo, dir))) add(`promo/${dir}/${name}`);
const body = gzipSync(JSON.stringify({ files, args: process.argv.slice(2) }));

const t0 = Date.now();
const reply = await new Promise((done, fail) => {
  const req = request({ host: '127.0.0.1', port, path: '/job', method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      if (res.statusCode === 409) return fail(new Error('the worker is busy with another job'));
      if (res.statusCode !== 200) return fail(new Error(`worker answered ${res.statusCode}`));
      done(JSON.parse(gunzipSync(Buffer.concat(chunks))));
    });
  });
  req.on('error', (e) =>
    fail(e.code === 'ECONNREFUSED' ? new Error(`no worker on 127.0.0.1:${port}: on the owner's machine, node promo/remote/worker.mjs and ssh -N -R ${port}:127.0.0.1:7700 -p 22222 lemon@23.251.32.150`) : e),
  );
  req.end(body);
}).catch((e) => {
  console.error(e.message);
  process.exit(1);
});

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
