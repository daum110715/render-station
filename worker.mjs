// The worker: runs on this machine what the server asks of it, one job at a time. The server reaches
// it through the reverse SSH tunnel the station (station.mjs) keeps up; by hand:
//   ssh -N -R 7700:127.0.0.1:7700 -p <port> <user>@<server>
// Two kinds of job. A preset of a registered workspace (workspace.mjs: what its render-station.json
// says it runs, which files a job may bring and which go back): what the job brings is set up in
// .tools/remote/job/, so no checkout is touched by it, and what it made goes back and is kept here
// too. A Shell command, which runs only as the owner allows here (shell.mjs).
// usage: node worker.mjs [--port 7700]
import { createServer } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { executeShell, runProcess } from './shell.mjs';
import { collect, commandOf, fill, missingEnv, resolveWorkspaces, uploadable } from './workspace.mjs';

const repo = resolve(fileURLToPath(new URL('.', import.meta.url)));
const job = join(repo, '.tools/remote/job');
/** the worker's port here */
export const WORKER = 7700;
/** the ports on the server the tunnel may come in on, tried in turn: one still held by a connection
 *  that died in the machine's sleep is passed over (cli.mjs looks through the same) */
export const PORTS = Array.from({ length: 10 }, (_, i) => 7700 + i);
/** what the worker and cli.mjs say to each other, and the header every request carries */
export const PROTOCOL = 1;
export const HEADER = 'x-render-station';
// a job's request, compressed and not
const SENT = 64 * 1024 * 1024;
const OPENED = 256 * 1024 * 1024;

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
    presets: Object.fromEntries(Object.entries(w.spec.presets).map(([name, p]) => [name, { description: p.description ?? '', args: p.args ?? [], upload: p.upload ?? [], ...(p.timeout ? { timeout: p.timeout } : {}) }])),
  }));

/** the worker on `port`; `workspaces()`: the registered ones, resolved (workspace.mjs); `shell`: the
 *  gate for Shell jobs, if they are taken; `keep`: a folder to keep here what each job made, the
 *  latest 30 jobs' worth; `on(event)`: {type: 'start', id, kind, …}, {type: 'log', id, text},
 *  {type: 'end', id, kind, ok, code, ms, files, tail, paths} */
export function serve({ port = WORKER, workspaces = () => [], on = () => {}, keep = null, shell = null, accepting = () => true } = {}) {
  let busy = false;
  let next = 1;
  async function run(body, id, signal) {
    const t0 = Date.now();
    let log = '';
    let code = null;
    let kind = null;
    let meta = {};
    let made = {};
    try {
      const payload = JSON.parse(gunzipSync(body, { maxOutputLength: OPENED }));
      kind = payload.type;
      if (kind === 'shell') {
        if (!shell) throw new Error('Shell requires the local station approval service');
        const request = await shell.authorize(payload, signal);
        if (!accepting()) throw new Error('station paused');
        on({ type: 'start', id, kind, workspace: request.workspace, command: request.command, cwd: request.cwd, approval: request.approval });
        const reply = await executeShell(request, { env: workspaces().find((w) => w.name === request.workspace)?.env ?? {}, signal, output: (text) => on({ type: 'log', id, text }) });
        on({ type: 'end', id, kind, ok: reply.ok, code: reply.code, ms: Date.now() - t0, files: [], tail: reply.log.slice(-3000), paths: [] });
        return reply;
      }
      if (kind !== 'preset') throw new Error(`unknown job type: ${kind}`);
      const w = workspaces().find((x) => x.name === payload.workspace);
      if (!w) throw new Error(`no workspace "${payload.workspace}" on this machine`);
      if (w.spec.error) throw new Error(`workspace ${w.name}: ${w.spec.error}`);
      const preset = Object.hasOwn(w.spec.presets, payload.preset ?? '') ? w.spec.presets[payload.preset] : null;
      if (!preset) throw new Error(`workspace ${w.name} has no preset "${payload.preset}"`);
      const lack = missingEnv(w);
      if (lack.length) throw new Error(`workspace ${w.name} is not set up here yet: ${lack.join(', ')} (in the local station settings)`);
      const vars = { job, workspace: w.path };
      const args = payload.args ?? [];
      const argv = commandOf(preset, args, vars);
      const files = payload.files ?? {};
      for (const path of Object.keys(files)) if (!uploadable(preset, path)) throw new Error(`not taken by the preset: ${path}`);
      rmSync(job, { recursive: true, force: true });
      mkdirSync(job, { recursive: true });
      for (const [path, data] of Object.entries(files)) {
        mkdirSync(dirname(join(job, path)), { recursive: true });
        writeFileSync(join(job, path), Buffer.from(data, 'base64'));
      }
      meta = { workspace: w.name, preset: payload.preset, args };
      on({ type: 'start', id, kind, ...meta, command: argv });
      const env = { ...w.env, ...Object.fromEntries(Object.entries(preset.env ?? {}).map(([k, v]) => [k, fill(v, vars)])) };
      // node: the one running this, wherever it is
      const reply = await runProcess({ file: argv[0] === 'node' ? process.execPath : argv[0], args: argv.slice(1), cwd: fill(preset.cwd ?? '{workspace}', vars), env, timeout: preset.timeout ?? 0, signal, output: (text) => on({ type: 'log', id, text }) });
      log = reply.log;
      code = reply.code;
      if (reply.ok) made = collect(preset, vars);
      if (!reply.ok) code ??= 1;
    } catch (e) {
      log += `${e?.message ?? e}\n`;
      if (code === 0) code = 1;
    }
    const ok = code === 0;
    const paths = [];
    if (ok && keep && Object.keys(made).length) {
      try {
        const into = join(keep, stamp());
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
        log += `not kept here: ${e.message}\n`;
      }
    }
    on({ type: 'end', id, kind, ok, code, ms: Date.now() - t0, files: Object.keys(made), tail: log.slice(-3000), paths });
    return { ok, code, log, files: Object.fromEntries(Object.entries(made).map(([k, v]) => [k, v.toString('base64')])) };
  }

  const server = createServer((req, res) => {
    // only what cli.mjs sends, from here or through the tunnel: never a web page (it cannot send the
    // header without asking first, and a name of its own is not 127.0.0.1)
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host) || req.headers[HEADER] !== String(PROTOCOL)) return res.writeHead(403).end();
    if (req.method === 'GET' && req.url === '/hello')
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ service: 'render-station', protocol: PROTOCOL, platform: process.platform, busy, accepting: accepting(), shell: shell ? shell.state().mode : 'disabled', workspaces: offer(workspaces()) }));
    if (req.method !== 'POST' || req.url !== '/job') return res.writeHead(404).end();
    if (!accepting()) return res.writeHead(503).end('station paused');
    if (busy) return res.writeHead(409).end('busy');
    busy = true;
    const id = next++;
    const chunks = [];
    const controller = new AbortController();
    let size = 0;
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    req.on('aborted', () => { busy = false; controller.abort(); });
    req.on('error', () => { busy = false; controller.abort(); });
    req.on('data', (c) => {
      size += c.length;
      if (size > SENT) { controller.abort(); req.destroy(); busy = false; }
      else chunks.push(c);
    });
    req.on('end', async () => {
      try {
        const reply = await run(Buffer.concat(chunks), id, controller.signal);
        if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }).end(gzipSync(JSON.stringify(reply)));
      } finally { busy = false; }
    });
  });
  // a long job is one long request
  server.requestTimeout = 0;
  server.listen(port, '127.0.0.1');
  return server;
}

// run by hand: with the workspaces the station's settings register
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : WORKER);
  const settings = () => {
    try {
      return JSON.parse(readFileSync(join(repo, '.tools/remote/config.json'), 'utf8')).workspaces ?? [];
    } catch {
      return [];
    }
  };
  serve({
    port,
    workspaces: () => resolveWorkspaces(settings()),
    on: (e) => {
      if (e.type === 'start') console.log(`${new Date().toLocaleTimeString()}  ${e.workspace}/${e.preset} ${e.args.join(' ')}`);
      if (e.type === 'log') process.stdout.write(e.text);
      if (e.type === 'end') console.log(`${e.ok ? 'done' : 'failed'} in ${(e.ms / 1000).toFixed(1)} s`);
    },
  }).on('listening', () => console.log(`worker on 127.0.0.1:${port}, jobs in ${job}`));
}
