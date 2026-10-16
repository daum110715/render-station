// The render worker, on the owner's machine with the GPU: renders for lemon what lemon is too slow
// to render. lemon reaches it through a reverse SSH tunnel opened from this machine, which the
// render station (station.mjs) keeps up; by hand:
//   ssh -N -R 7700:127.0.0.1:7700 -p 22222 lemon@23.251.32.150
// A job (remote/ask.mjs) brings lemon's promo/render.mjs, lib/ and stage/ as they stand there,
// changes not yet committed included, and what to render. It is set up in .tools/remote/job/,
// so this checkout is never touched, and rendered with this machine's clips, site build, assets
// and tools (the environment render.mjs reads: PROMO_WORK, PROMO_SITE, PROMO_CHROME, PROMO_GPU,
// PROMO_FFMPEG, PROMO_PROFILES); what it made goes back. One job at a time. Stills (full or half
// size), the covers and clips; a clip always half size at 15 fps (--preview): until the cut is
// out, nothing is rendered at full size and rate, and the final render is run here by hand.
// usage: node promo/remote/worker.mjs [--port 7700]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const job = join(repo, '.tools/remote/job');
/** the worker's port here */
export const WORKER = 7700;
/** the ports on lemon the tunnel may come in on, tried in turn: one still held by a connection
 *  that died in the machine's sleep is passed over (ask.mjs looks through the same) */
export const PORTS = Array.from({ length: 10 }, (_, i) => 7700 + i);

// what a job may bring, and ask render.mjs for
const FILES = /^promo\/(render\.mjs|lib\/[\w.-]+|stage\/[\w.-]+)$/;
const num = (v) => /^-?\d+(\.\d+)?$/.test(v);
function check(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--cover', '--preview', '--partial', '--no-voice'].includes(a)) out.push(a);
    else if (a === '--stills' && argv[i + 1]?.split(',').every(num)) out.push(a, argv[++i]);
    else if ((a === '--from' || a === '--to') && num(argv[i + 1])) out.push(a, argv[++i]);
    else throw new Error(`not taken: ${a}`);
  }
  // a clip: half size, 15 fps, into the job's own out/
  if (!out.includes('--stills') && !out.includes('--cover')) {
    if (!out.includes('--preview')) out.push('--preview');
    out.push('--out', join(job, 'promo/out/clip.mp4'));
  }
  return out;
}
/** every file under dir, by its path from dir */
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

const pad = (n) => String(n).padStart(2, '0');
/** now, as a folder's name that sorts as time does */
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

/** the worker on `port`; `env()`: what to add to the environment render.mjs runs in; `keep`: a
 *  folder to keep here what each job made, the latest 30 jobs' worth; `on(event)`:
 *  {type: 'start', id, args}, {type: 'log', id, text}, {type: 'end', id, ok, ms, files, tail, paths} */
export function serve({ port = WORKER, env = () => ({}), on = () => {}, keep = null } = {}) {
  let busy = false;
  let next = 1;
  async function run(body, id) {
    const t0 = Date.now();
    let log = '';
    let code = 1;
    let argv = [];
    const made = {};
    try {
      const { files, args: asked } = JSON.parse(gunzipSync(body));
      argv = check(asked);
      rmSync(job, { recursive: true, force: true });
      for (const [path, data] of Object.entries(files)) {
        if (!FILES.test(path)) throw new Error(`not taken: ${path}`);
        mkdirSync(dirname(join(job, path)), { recursive: true });
        writeFileSync(join(job, path), Buffer.from(data, 'base64'));
      }
      on({ type: 'start', id, args: argv });
      code = await new Promise((done) => {
        const p = spawn(process.execPath, [join(job, 'promo/render.mjs'), ...argv], { cwd: repo, env: { ...process.env, ...env(), PROMO_ROOT: repo }, windowsHide: true });
        for (const s of [p.stdout, p.stderr])
          s.on('data', (d) => {
            log += d;
            on({ type: 'log', id, text: String(d) });
          });
        p.on('error', (e) => {
          log += `${e.message}\n`;
          done(1);
        });
        p.on('close', done);
      });
      // what it made, but not the steps on the way to a clip
      const out = join(job, 'promo/out');
      for (const file of code === 0 ? walk(out) : []) {
        if (/\.(video\.mp4|mix\.wav)$/.test(file)) continue;
        made[relative(out, file).split('\\').join('/')] = readFileSync(file).toString('base64');
      }
    } catch (e) {
      log += `${e?.stack ?? e}\n`;
      code = 1;
    }
    const ok = code === 0;
    const paths = [];
    if (ok && keep && Object.keys(made).length) {
      try {
        const into = join(keep, stamp());
        for (const [name, data] of Object.entries(made)) {
          const file = join(into, name);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, Buffer.from(data, 'base64'));
          paths.push(file);
        }
        // what it was, for whoever looks at it later
        writeFileSync(join(into, 'job.json'), JSON.stringify({ at: t0, ms: Date.now() - t0, args: argv }));
        for (const old of readdirSync(keep).sort().slice(0, -30)) rmSync(join(keep, old), { recursive: true, force: true });
      } catch (e) {
        log += `not kept here: ${e.message}\n`;
      }
    }
    on({ type: 'end', id, ok, ms: Date.now() - t0, files: Object.keys(made), tail: log.slice(-3000), paths });
    return { ok, log, files: made };
  }

  const server = createServer((req, res) => {
    // only what ask.mjs sends, from here or through the tunnel: never a web page (it cannot send
    // the header without asking first, and a name of its own is not 127.0.0.1)
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host) || req.headers['x-qiqi-worker'] !== '1') return res.writeHead(403).end();
    if (req.method === 'GET' && req.url === '/hello') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ worker: 'qiqi-promo', busy }));
    if (req.method !== 'POST' || req.url !== '/job') return res.writeHead(404).end();
    if (busy) return res.writeHead(409).end('busy');
    busy = true;
    const id = next++;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const reply = await run(Buffer.concat(chunks), id);
      busy = false;
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(gzipSync(JSON.stringify(reply)));
    });
  });
  // a long render is one long request
  server.requestTimeout = 0;
  server.listen(port, '127.0.0.1');
  return server;
}

// run by hand
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : WORKER);
  serve({
    port,
    on: (e) => {
      if (e.type === 'start') console.log(`${new Date().toLocaleTimeString()}  render.mjs ${e.args.join(' ')}`);
      if (e.type === 'log') process.stdout.write(e.text);
      if (e.type === 'end') console.log(`${e.ok ? 'done' : 'failed'} in ${(e.ms / 1000).toFixed(1)} s`);
    },
  }).on('listening', () => console.log(`render worker on 127.0.0.1:${port}, jobs in ${job}`));
}
