// The render worker, on the owner's machine with the GPU: renders for lemon what lemon is too slow
// to render. lemon reaches it through a reverse SSH tunnel opened from this machine:
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
const args = process.argv.slice(2);
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 7700);

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

let busy = false;
async function run(body) {
  const { files, args: asked } = JSON.parse(gunzipSync(body));
  const argv = check(asked);
  rmSync(job, { recursive: true, force: true });
  for (const [path, data] of Object.entries(files)) {
    if (!FILES.test(path)) throw new Error(`not taken: ${path}`);
    mkdirSync(dirname(join(job, path)), { recursive: true });
    writeFileSync(join(job, path), Buffer.from(data, 'base64'));
  }
  console.log(`${new Date().toLocaleTimeString()}  render.mjs ${argv.join(' ')}`);
  let log = '';
  const code = await new Promise((done) => {
    const p = spawn(process.execPath, [join(job, 'promo/render.mjs'), ...argv], { cwd: repo, env: { ...process.env, PROMO_ROOT: repo } });
    for (const s of [p.stdout, p.stderr])
      s.on('data', (d) => {
        log += d;
        process.stdout.write(d);
      });
    p.on('close', done);
  });
  // what it made, but not the steps on the way to a clip
  const out = join(job, 'promo/out');
  const made = {};
  for (const file of code === 0 ? walk(out) : []) {
    if (/\.(video\.mp4|mix\.wav)$/.test(file)) continue;
    made[relative(out, file).split('\\').join('/')] = readFileSync(file).toString('base64');
  }
  return { ok: code === 0, log, files: made };
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/job') return res.writeHead(404).end();
  if (busy) return res.writeHead(409).end('busy');
  busy = true;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    let reply;
    try {
      reply = await run(Buffer.concat(chunks));
    } catch (e) {
      reply = { ok: false, log: String(e?.stack ?? e), files: {} };
    }
    busy = false;
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(gzipSync(JSON.stringify(reply)));
  });
});
// a long render is one long request
server.requestTimeout = 0;
server.listen(port, '127.0.0.1', () => console.log(`render worker on 127.0.0.1:${port}, jobs in ${job}`));
