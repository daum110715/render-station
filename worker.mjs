// The worker: runs on this machine what the server asks of it, several jobs at once as the settings
// allow. The server reaches it through the reverse SSH tunnel the station (station.mjs) keeps up; by
// hand:
//   ssh -N -R 7700:127.0.0.1:7700 -p <port> <user>@<server>
// Two kinds of job. A preset of a registered workspace (workspace.mjs: what its render-station.json
// says it runs, which files a job may bring and which go back): what the job brings is set up in a
// folder of its own, .tools/remote/jobs/<n>/, removed once it is over, so no checkout is touched by
// it, and what it made goes back and is kept here too. A Shell command, which runs only as the owner
// allows here (shell.mjs).
// Jobs beyond what may run at once wait their turn, in the order they came: `limit()` in all, and of
// one workspace's presets as many as its file's `parallel` says (one unless it says more). The
// server is answered as it goes, a line of JSON for each step (the whole gzipped): { event: 'queued',
// ahead }, { event: 'pending' } (a Shell command waits for the owner's approval), { event: 'started' },
// and last { event: 'done', reply }.
// It also takes the server's changes to the workspaces, and lets it look through this machine's
// folders, as far as the owner lets it (`manage`): answered the same way, if the server takes lines
// of JSON ({ event: 'pending' }, then { event: 'done', reply }), else with the reply alone. And what
// the server puts on this machine's clipboard, while the owner has it in step with the server's.
// usage: node worker.mjs [--port 7700]
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip, gunzipSync } from 'node:zlib';
import { executeShell, runProcess } from './shell.mjs';
import { collect, commandOf, fill, missingEnv, resolveWorkspaces, uploadable } from './workspace.mjs';

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)));
/** where each job's folder is made */
export const JOBS = join(repo, '.tools/remote/jobs');
/** the worker's port here */
export const WORKER = 7700;
/** the ports on the server the tunnel may come in on, tried in turn: one still held by a connection
 *  that died in the machine's sleep is passed over (cli.mjs looks through the same) */
export const PORTS = Array.from({ length: 10 }, (_, i) => 7700 + i);
/** what the worker and cli.mjs say to each other, and the header every request carries */
export const PROTOCOL = 2;
export const HEADER = 'x-render-station';
/** what this worker can do beyond what protocol 2 began with, so cli.mjs can tell a station too old
 *  for a command from one that is not */
export const FEATURES = ['pending', 'browse', 'create', 'clip'];
const OFF = 'the owner does not let the server manage workspaces or look through folders: allow it in the local station settings';
const CLIP_OFF = 'the owner has not turned on 同步剪贴板 (clipboard sync) in the local station settings';
/** what the server puts on the clipboard, a picture's bytes as base64 */
const CLIP_SENT = 32 * 1024 * 1024;
// a job's request, compressed and not
const SENT = 64 * 1024 * 1024;
const OPENED = 256 * 1024 * 1024;
/** jobs that may wait their turn; past them, one is turned away */
const QUEUE = 16;

const pad = (n) => String(n).padStart(2, '0');
/** now, as a folder's name that sorts as time does */
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

/** what the server is told of the workspaces: their presets, and what each still lacks */
const offer = (list) =>
  list.map((w) => ({
    name: w.name,
    path: w.path,
    ...(w.spec.error ? { error: w.spec.error } : {}),
    missing: missingEnv(w),
    parallel: w.spec.parallel ?? 1,
    presets: Object.fromEntries(Object.entries(w.spec.presets).map(([name, p]) => [name, { description: p.description ?? '', args: p.args ?? [], upload: p.upload ?? [], ...(p.timeout ? { timeout: p.timeout } : {}) }])),
  }));

/** the worker on `port`; `workspaces()`: the registered ones, resolved (workspace.mjs); `limit()`:
 *  how many jobs may run at once; `shell`: the gate for Shell jobs, if they are taken; `manage`: the
 *  station's handling of the server's changes to the workspaces and looks into folders ({ mode(),
 *  change(request, signal, waiting), browse(request, signal, waiting) }, `waiting()` once one waits
 *  for the owner's approval), if it takes them; `clip`: the station's clipboard ({ on(), set(input) }:
 *  input { type: 'text', text } or { type: 'image', data }), if it takes what the server puts on it;
 *  `keep`: a folder to keep here what each job made, the latest 30 jobs' worth;
 *  `jobs`: where each job's folder is made; `on(event)`: {type: 'queued', id, kind, …},
 *  {type: 'start', id, kind, …}, {type: 'log', id, text}, {type: 'end', id, kind, ok, code, ms,
 *  files, tail, paths}. The server it returns schedules again with `schedule()` (the limit changed,
 *  or the station paused) */
export function serve({ port = WORKER, workspaces = () => [], on = () => {}, keep = null, shell = null, manage = null, clip = null, accepting = () => true, limit = () => 2, jobs = JOBS } = {}) {
  let next = 1;
  /** the jobs running, by id: their workspace's lane (null for a Shell command) and what they are */
  const running = new Map();
  /** the jobs waiting their turn, in the order they came */
  const queue = [];
  // left by a station that stopped in the middle of a job
  rmSync(jobs, { recursive: true, force: true });

  const inLane = (lane) => [...running.values()].filter((r) => r.lane === lane).length;
  /** each job that may start now, started; to each still waiting, how many are ahead of it */
  function schedule() {
    for (const entry of [...queue]) {
      if (!accepting()) {
        queue.splice(queue.indexOf(entry), 1);
        entry.fail(new Error('station paused'));
      } else if (running.size < limit() && (entry.lane == null || inLane(entry.lane) < entry.room)) {
        queue.splice(queue.indexOf(entry), 1);
        running.set(entry.id, { lane: entry.lane, ...entry.info });
        entry.go();
      }
    }
    queue.forEach((entry, ahead) => {
      if (entry.ahead === ahead) return;
      entry.ahead = ahead;
      entry.tell({ event: 'queued', ahead });
    });
  }
  /** a job's turn: once it may start, by the limit and its lane's room; refused if the server goes */
  const turn = (id, lane, room, info, signal, tell) =>
    new Promise((go, fail) => {
      if (signal.aborted) return fail(new Error('cancelled: the server disconnected'));
      const aborted = () => {
        const i = queue.indexOf(entry);
        if (i < 0) return;
        queue.splice(i, 1);
        fail(new Error('cancelled while queued: the server disconnected'));
        schedule();
      };
      const entry = {
        id, lane, room, info, tell, ahead: -1,
        go: () => (signal.removeEventListener('abort', aborted), go()),
        fail: (e) => (signal.removeEventListener('abort', aborted), fail(e)),
      };
      signal.addEventListener('abort', aborted, { once: true });
      queue.push(entry);
      schedule();
      if (queue.includes(entry)) on({ type: 'queued', id, ...info });
    });

  /** a preset job as the settings have it now: its workspace, preset, command and environment */
  function prepare(payload, dir) {
    const w = workspaces().find((x) => x.name === payload.workspace);
    if (!w) throw new Error(`no workspace "${payload.workspace}" on this machine`);
    if (w.spec.error) throw new Error(`workspace ${w.name}: ${w.spec.error}`);
    const preset = Object.hasOwn(w.spec.presets, payload.preset ?? '') ? w.spec.presets[payload.preset] : null;
    if (!preset) throw new Error(`workspace ${w.name} has no preset "${payload.preset}"`);
    const lack = missingEnv(w);
    if (lack.length) throw new Error(`workspace ${w.name} is not set up here yet: ${lack.join(', ')} (in the local station settings)`);
    const vars = { job: dir, workspace: w.path };
    const argv = commandOf(preset, payload.args ?? [], vars);
    for (const path of Object.keys(payload.files ?? {})) if (!uploadable(preset, path)) throw new Error(`not taken by the preset: ${path}`);
    const env = { ...w.env, ...Object.fromEntries(Object.entries(preset.env ?? {}).map(([k, v]) => [k, fill(v, vars)])) };
    return { w, preset, vars, argv, env };
  }

  async function run(body, id, signal, tell) {
    const t0 = Date.now();
    let log = '';
    let code = null;
    let kind = null;
    let meta = {};
    let made = {};
    const dir = join(jobs, String(id));
    try {
      const payload = JSON.parse(gunzipSync(body, { maxOutputLength: OPENED }));
      kind = payload.type;
      if (kind === 'shell') {
        if (!shell) throw new Error('Shell requires the local station approval service');
        const request = await shell.authorize(payload, signal, () => tell({ event: 'pending' }));
        await turn(id, null, 0, { kind, workspace: request.workspace, command: request.command }, signal, tell);
        if (!accepting()) throw new Error('station paused');
        on({ type: 'start', id, kind, workspace: request.workspace, command: request.command, cwd: request.cwd, approval: request.approval });
        tell({ event: 'started' });
        const reply = await executeShell(request, { env: workspaces().find((w) => w.name === request.workspace)?.env ?? {}, signal, output: (text) => on({ type: 'log', id, text }) });
        on({ type: 'end', id, kind, ok: reply.ok, code: reply.code, ms: Date.now() - t0, files: [], tail: reply.log.slice(-3000), paths: [] });
        return reply;
      }
      if (kind !== 'preset') throw new Error(`unknown job type: ${kind}`);
      // refused at once if it cannot run, and checked again when its turn comes
      const { w } = prepare(payload, dir);
      const args = payload.args ?? [];
      meta = { workspace: w.name, preset: payload.preset, args };
      await turn(id, w.name, w.spec.parallel ?? 1, { kind, ...meta }, signal, tell);
      const { preset, vars, argv, env } = prepare(payload, dir);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      for (const [path, data] of Object.entries(payload.files ?? {})) {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), Buffer.from(data, 'base64'));
      }
      on({ type: 'start', id, kind, ...meta, command: argv });
      tell({ event: 'started' });
      // node: the one running this, wherever it is
      const reply = await runProcess({ file: argv[0] === 'node' ? process.execPath : argv[0], args: argv.slice(1), cwd: fill(preset.cwd ?? '{workspace}', vars), env, timeout: preset.timeout ?? 0, signal, output: (text) => on({ type: 'log', id, text }) });
      log = reply.log;
      code = reply.code;
      if (reply.ok) made = collect(preset, vars);
      if (!reply.ok) code ??= 1;
    } catch (e) {
      log += `${e?.message ?? e}\n`;
      if (code === 0) code = 1;
    } finally {
      if (running.delete(id)) schedule();
      // a program it started may still hold a file a moment longer: then the next start clears it
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
    const ok = code === 0;
    const paths = [];
    if (ok && keep && Object.keys(made).length) {
      try {
        const into = join(keep, `${stamp()}_${id}`);
        for (const [name, data] of Object.entries(made)) {
          const file = join(into, name);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, data);
          paths.push(file);
        }
        // what it was, for whoever looks at it later
        writeFileSync(join(into, 'job.json'), JSON.stringify({ at: t0, ms: Date.now() - t0, ...meta }));
        for (const old of readdirSync(keep).sort().slice(0, -30)) rmSync(join(keep, old), { recursive: true, force: true });
      } catch (e) {
        log += `could not keep a local copy: ${e.message}\n`;
      }
    }
    on({ type: 'end', id, kind, ok, code, ms: Date.now() - t0, files: Object.keys(made), tail: log.slice(-3000), paths });
    return { ok, code, log, files: Object.fromEntries(Object.entries(made).map(([k, v]) => [k, v.toString('base64')])) };
  }

  /** a request's body, up to `max` bytes (else null); `abort()` when it breaks off */
  const read = (req, max, abort) =>
    new Promise((done) => {
      const chunks = [];
      let size = 0;
      req.on('aborted', abort);
      req.on('error', abort);
      req.on('data', (c) => {
        size += c.length;
        if (size > max) {
          abort();
          req.destroy();
          done(null);
        } else chunks.push(c);
      });
      req.on('end', () => done(Buffer.concat(chunks)));
    });

  const server = createServer(async (req, res) => {
    // only what cli.mjs sends, from here or through the tunnel: never a web page (it cannot send the
    // header without asking first, and a name of its own is not 127.0.0.1)
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host) || req.headers[HEADER] !== String(PROTOCOL)) return res.writeHead(403).end();
    if (req.method === 'GET' && req.url === '/hello')
      return res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          service: 'render-station',
          protocol: PROTOCOL,
          features: FEATURES,
          platform: process.platform,
          accepting: accepting(),
          limit: limit(),
          running: [...running.entries()].map(([id, { lane, ...info }]) => ({ id, ...info })),
          queued: queue.length,
          shell: shell ? shell.state().mode : 'disabled',
          manage: manage ? manage.mode() : 'off',
          clipboard: clip ? clip.on() : false,
          workspaces: offer(workspaces()),
        }),
      );
    if (req.method !== 'POST' || !['/job', '/workspace', '/browse', '/clip'].includes(req.url)) return res.writeHead(404).end();
    if (!accepting()) return res.writeHead(503).end('station paused');
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    // onto the clipboard here, as far as the owner has it in step with the server's
    if (req.url === '/clip') {
      const body = await read(req, CLIP_SENT, () => controller.abort());
      if (!body) return;
      let reply;
      try {
        if (!clip || !clip.on()) throw new Error(CLIP_OFF);
        reply = { ok: true, ...(await clip.set(JSON.parse(body))) };
      } catch (e) {
        reply = { ok: false, error: e?.message ?? String(e) };
      }
      if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      return;
    }

    // a change to the workspaces, or a look into a folder: answered once it is done, or refused
    if (req.url !== '/job') {
      const body = await read(req, 1024 * 1024, () => controller.abort());
      if (!body) return;
      const lines = (req.headers.accept ?? '').includes('application/x-ndjson');
      if (lines) res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const waiting = () => lines && !res.destroyed && res.write(`${JSON.stringify({ event: 'pending' })}\n`);
      let reply;
      try {
        if (!manage || manage.mode() === 'off') throw new Error(OFF);
        const input = JSON.parse(body);
        reply = { ok: true, ...(await (req.url === '/workspace' ? manage.change : manage.browse)(input, controller.signal, waiting)) };
      } catch (e) {
        reply = { ok: false, error: e?.message ?? String(e) };
      }
      if (res.destroyed) return;
      if (lines) res.end(`${JSON.stringify({ event: 'done', reply })}\n`);
      else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
      return;
    }

    if (queue.length >= QUEUE) return res.writeHead(429).end('queue full');
    const id = next++;
    const body = await read(req, SENT, () => controller.abort());
    if (!body || controller.signal.aborted) return;
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'content-encoding': 'gzip' });
    const z = createGzip();
    z.pipe(res);
    const tell = (event) => {
      if (res.destroyed) return;
      z.write(`${JSON.stringify(event)}\n`);
      z.flush();
    };
    const reply = await run(body, id, controller.signal, tell);
    tell({ event: 'done', reply });
    z.end();
  });
  // a long job is one long request
  server.requestTimeout = 0;
  server.schedule = schedule;
  server.listen(port, '127.0.0.1');
  return server;
}

// run by hand: with the workspaces the station's settings register
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : WORKER);
  const settings = () => {
    try {
      return JSON.parse(readFileSync(join(repo, '.tools/remote/config.json'), 'utf8'));
    } catch {
      return {};
    }
  };
  serve({
    port,
    workspaces: () => resolveWorkspaces(settings().workspaces ?? []),
    limit: () => settings().parallel ?? 2,
    on: (e) => {
      const at = `${new Date().toLocaleTimeString()}  #${e.id}`;
      if (e.type === 'queued') console.log(`${at} queued`);
      if (e.type === 'start') console.log(`${at} ${e.kind === 'shell' ? e.command : `${e.workspace}/${e.preset} ${e.args.join(' ')}`}`);
      if (e.type === 'log') process.stdout.write(e.text);
      if (e.type === 'end') console.log(`${at} ${e.ok ? 'done' : 'failed'} in ${(e.ms / 1000).toFixed(1)} s`);
    },
  }).on('listening', () => console.log(`worker on 127.0.0.1:${port}, jobs in ${JOBS}`));
}
