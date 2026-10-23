#!/usr/bin/env node
// On the server: hands jobs to the worker on the machine that does the heavy work (worker.mjs, kept
// up there by the render station, with the reverse SSH tunnel it opens to here; it comes in on a
// port from 7700 to 7709, or the one RENDER_STATION_PORT names).
// usage: node cli.mjs status [--json]
//        node cli.mjs run [--json] [--src <dir>] [--out <dir>] <workspace>/<preset> [args…]
//        node cli.mjs shell [--json] [--workspace <name>] [--cwd <dir>] [--timeout <s>] <command…>
//        node cli.mjs workspace add [--json] <name> <path> [--env NAME=value …]
//        node cli.mjs workspace set [--json] <name> [--path <path>] [--env NAME=value …] [--unset NAME …]
//        node cli.mjs workspace remove [--json] <name>
// run: the preset's files to bring are taken from --src (default: the current folder), as its upload
// globs name them; what comes back lands in --out (default: .tools/results/<time>/ here). Everything
// after <workspace>/<preset> is the preset's arguments.
// shell: the command runs in the workspace (default: the first registered); one the owner has not
// allowed waits up to 5 minutes for their approval there.
// A job the device cannot start yet, as many already run there, waits its turn; the command waits
// with it, and says how many are ahead.
// workspace: changes the workspaces registered on the device, as far as its owner lets the server;
// unless they allow it outright, each change waits up to 5 minutes for their approval there. <path>:
// a folder on the device, in full (D:/projects/site, or quoted: "D:\projects\site").
// --json: one JSON object on stdout, the end of it all ({ ok, exitCode, …, error }).
// Exit status: the job's own when it ran; 1 when it failed without running, or a workspace change
// was refused; 2 for a usage error; 3 when no worker is reached, or it is paused or its queue full.
import { request } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, gzipSync } from 'node:zlib';
import { HEADER, PORTS, PROTOCOL } from './worker.mjs';
import { gather, safeRel } from './workspace.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const USAGE = `usage: node cli.mjs status [--json]
       node cli.mjs run [--json] [--src <dir>] [--out <dir>] <workspace>/<preset> [args…]
       node cli.mjs shell [--json] [--workspace <name>] [--cwd <dir>] [--timeout <s>] <command…>
       node cli.mjs workspace add [--json] <name> <path> [--env NAME=value …]
       node cli.mjs workspace set [--json] <name> [--path <path>] [--env NAME=value …] [--unset NAME …]
       node cli.mjs workspace remove [--json] <name>`;

const [what, ...rest] = process.argv.slice(2);
// the options before the first word that is not one: the target, or the command (a workspace
// change's may come after its words too)
const opts = {};
const TAKES = { status: [], run: ['--src', '--out'], shell: ['--workspace', '--cwd', '--timeout'], workspace: ['--path', '--env', '--unset'] }[what];
const MANY = ['--env', '--unset'];
const words = [];
let i = 0;
for (; TAKES && i < rest.length; i++) {
  const a = rest[i];
  if (a === '--') {
    i++;
    break;
  }
  if (a === '--json') opts.json = true;
  else if (TAKES.includes(a) && rest[i + 1] != null) {
    const v = rest[++i];
    if (MANY.includes(a)) (opts[a.slice(2)] ??= []).push(v);
    else opts[a.slice(2)] = v;
  } else if (a.startsWith('--')) usage(`unknown option: ${a}`);
  else if (what === 'workspace') words.push(a);
  else break;
}
words.push(...rest.slice(i));

/** the end: said as JSON, or in words */
function finish(result, status) {
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else if (result.error) console.error(result.error);
  process.exit(status);
}
function usage(why) {
  if (process.argv.includes('--json')) finish({ ok: false, exitCode: null, error: `${why}\n${USAGE}` }, 2);
  console.error(`${why}\n${USAGE}`);
  process.exit(2);
}
if (!TAKES) usage(what ? `unknown command: ${what}` : 'no command');
/** what is said on the way, unless only JSON is */
const tell = (text) => opts.json || console.error(text);

const headers = { [HEADER]: String(PROTOCOL) };
/** a request to the worker on `port`: the reply's status and body */
const call = (port, method, path, body, timeout = 0) =>
  new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    if (timeout) req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', fail);
    req.end(body);
  });
/** a job handed to the worker on `port`: each step it is told of as it comes (`step(event)`), and
 *  at the end the reply's status and the job's reply (or, refused, the body) */
const submit = (port, body, step) =>
  new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path: '/job', method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-encoding': 'gzip' } }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => done({ status: res.statusCode, body: Buffer.concat(chunks) }));
        return;
      }
      // a line of JSON each step; the last, with all that came back, may be large
      let part = [];
      let reply = null;
      const lines = res.pipe(createGunzip());
      lines.on('data', (c) => {
        let start = 0;
        for (let nl = c.indexOf(10); nl >= 0; nl = c.indexOf(10, start)) {
          part.push(c.subarray(start, nl));
          const event = JSON.parse(Buffer.concat(part).toString('utf8'));
          part = [];
          start = nl + 1;
          if (event.event === 'done') reply = event.reply;
          else step(event);
        }
        if (start < c.length) part.push(c.subarray(start));
      });
      lines.on('end', () => (reply ? done({ status: 200, reply }) : fail(new Error('the worker stopped answering before the job ended'))));
      lines.on('error', fail);
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(body);
  });

// which port the tunnel came in on: the one where the worker answers (a port left over from a
// connection that died answers nothing)
let port = null;
let hello = null;
for (const p of process.env.RENDER_STATION_PORT ? [Number(process.env.RENDER_STATION_PORT)] : PORTS) {
  const res = await call(p, 'GET', '/hello', null, 1500).catch(() => null);
  let said = null;
  try {
    said = res?.status === 200 ? JSON.parse(res.body) : null;
  } catch {}
  if (said?.service === 'render-station') {
    port = p;
    hello = said;
    break;
  }
}
const OFFLINE = 'no worker reachable: the render station on the device is not running, is paused, or has not connected yet';
const MANAGE = { off: 'not allowed', ask: 'each change needs the owner\'s approval', allow: 'allowed' };
if (what === 'status') {
  if (!hello) finish({ online: false, error: OFFLINE }, 3);
  if (hello.protocol !== PROTOCOL) finish({ online: true, port, ...hello, error: `protocol mismatch: the worker uses version ${hello.protocol}, this cli.mjs version ${PROTOCOL}; update one of them` }, 1);
  if (opts.json) finish({ online: true, port, ...hello }, 0);
  const load = `${hello.running.length} of ${hello.limit} running${hello.queued ? `, ${hello.queued} queued` : ''}`;
  console.log(`worker on port ${port}: ${hello.platform}; ${load}${hello.accepting ? '' : '; paused'}; Shell ${hello.shell}; workspace changes ${MANAGE[hello.manage] ?? hello.manage}`);
  for (const j of hello.running) console.log(`  #${j.id} ${j.kind === 'shell' ? `shell: ${j.command}` : `${j.workspace}/${j.preset} ${j.args.join(' ')}`.trim()}`);
  for (const w of hello.workspaces) {
    console.log(`\n${w.name}  (${w.path})${w.parallel > 1 ? `  up to ${w.parallel} jobs at once` : ''}${w.error ? `\n  error: ${w.error}` : ''}${w.missing.length ? `\n  not set up yet: ${w.missing.join(', ')}` : ''}`);
    for (const [name, p] of Object.entries(w.presets)) console.log(`  ${w.name}/${name}${p.description ? `  ${p.description}` : ''}`);
  }
  if (!hello.workspaces.length) console.log('no workspaces registered');
  process.exit(0);
}
if (hello && hello.protocol !== PROTOCOL) finish({ ok: false, exitCode: null, error: `protocol mismatch: the worker uses version ${hello.protocol}, this cli.mjs version ${PROTOCOL}; update one of them` }, 1);
if (!hello) finish({ ok: false, exitCode: null, error: OFFLINE }, 3);

// ——— a change to the workspaces ———
if (what === 'workspace') {
  const [action, name, path] = words;
  const takes = { add: 3, set: 2, remove: 2 }[action];
  if (!takes) usage('workspace: add, set or remove');
  if (words.length !== takes) usage(`workspace ${action}: ${action === 'add' ? 'a name and a path' : 'a name'}`);
  if (action !== 'set' && (opts.path || opts.unset)) usage(`workspace ${action}: --path and --unset are for set`);
  if (action === 'remove' && opts.env) usage('workspace remove: no --env');
  const env = {};
  for (const pair of opts.env ?? []) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(pair);
    if (!m) usage(`--env: NAME=value, not ${pair}`);
    env[m[1]] = m[2];
  }
  const change = { action, name, ...(path ? { path } : {}), ...(opts.path ? { path: opts.path } : {}), ...(opts.env ? { env } : {}), ...(opts.unset ? { unset: opts.unset } : {}) };
  if (hello.manage === 'off') finish({ ok: false, action, error: 'the owner of the device does not let the server manage workspaces (in the render station\'s settings there)' }, 1);
  if (hello.manage === 'ask') tell('Change submitted; it waits for the owner\'s approval on the device (up to 5 minutes).');
  const res = await call(port, 'POST', '/workspace', Buffer.from(JSON.stringify(change))).catch((e) => finish({ ok: false, action, error: `lost the connection to the worker: ${e.message}` }, 3));
  if (res.status === 503) finish({ ok: false, action, error: 'the render station is paused' }, 3);
  if (res.status !== 200) finish({ ok: false, action, error: `the worker answered ${res.status}: ${res.body.toString().slice(0, 500)}` }, 1);
  const reply = JSON.parse(res.body);
  if (opts.json || !reply.ok) finish(reply, reply.ok ? 0 : 1);
  const w = reply.workspace;
  console.log(`${{ add: 'added', set: 'changed', remove: 'removed' }[action]} workspace ${name}${w ? ` (${w.path})` : ''}`);
  if (reply.imported?.length) console.log(`taken from the settings of the render station from before workspaces: ${reply.imported.join(', ')}`);
  if (w?.error) console.log(`error: ${w.error}`);
  if (w?.missing.length) console.log(`not set up yet: ${w.missing.join(', ')}`);
  if (w) console.log(w.presets.length ? `presets: ${w.presets.map((p) => `${w.name}/${p}`).join(', ')}` : 'no presets');
  process.exit(0);
}

// ——— a job ———
let payload;
let meta;
if (what === 'run') {
  const [target, ...args] = words;
  const [workspace, preset, extra] = (target ?? '').split('/');
  if (!workspace || !preset || extra != null) usage('run: name the preset as <workspace>/<preset>');
  const w = hello.workspaces.find((x) => x.name === workspace);
  if (!w) finish({ ok: false, exitCode: null, error: `no workspace "${workspace}" there (it has: ${hello.workspaces.map((x) => x.name).join(', ') || 'none'})` }, 1);
  const p = w.presets[preset];
  if (!p) finish({ ok: false, exitCode: null, error: `workspace ${workspace} has no preset "${preset}" (it has: ${Object.keys(w.presets).join(', ') || 'none'})` }, 1);
  const src = resolve(opts.src ?? '.');
  const files = {};
  let size = 0;
  for (const rel of gather(src, p.upload)) {
    if (!safeRel(rel)) continue;
    const data = readFileSync(join(src, rel));
    size += data.length;
    files[rel] = data.toString('base64');
  }
  if (size > 48 * 1024 * 1024) finish({ ok: false, exitCode: null, error: `the files to bring come to ${Math.round(size / 1024 / 1024)} MB, over 48 MB` }, 1);
  if (p.upload.length && !Object.keys(files).length) finish({ ok: false, exitCode: null, error: `none of the preset's files (${p.upload.join(', ')}) under ${src}: give --src` }, 1);
  payload = { type: 'preset', workspace, preset, args, files };
  meta = { kind: 'preset', workspace, preset, args };
} else {
  const command = words.join(' ');
  if (!command.trim()) usage('shell: no command');
  const timeout = opts.timeout == null ? undefined : Number(opts.timeout);
  payload = { type: 'shell', command, ...(opts.workspace ? { workspace: opts.workspace } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(timeout != null ? { timeout } : {}) };
  meta = { kind: 'shell', command, workspace: opts.workspace ?? null };
  tell('Shell submitted; a command not on the allowlist there waits for the owner\'s approval (up to 5 minutes).');
}

const t0 = Date.now();
let waited = false;
const step = (e) => {
  if (e.event === 'queued') {
    waited = true;
    tell(e.ahead ? `queued on the device: ${e.ahead} ${e.ahead > 1 ? 'jobs' : 'job'} ahead` : 'queued on the device: next to start');
  } else if (e.event === 'started' && waited) tell('started');
};
const res = await submit(port, gzipSync(JSON.stringify(payload)), step).catch((e) => finish({ ok: false, exitCode: null, ...meta, error: `lost the connection to the worker: ${e.message}` }, 3));
if (res.status === 429) finish({ ok: false, exitCode: null, ...meta, error: 'too many jobs are already waiting on the device; try again later' }, 3);
if (res.status === 503) finish({ ok: false, exitCode: null, ...meta, error: 'the render station is paused' }, 3);
if (res.status !== 200) finish({ ok: false, exitCode: null, ...meta, error: `the worker answered ${res.status}: ${res.body.toString().slice(0, 500)}` }, 1);
const { reply } = res;

const names = Object.keys(reply.files ?? {}).filter(safeRel);
const out = names.length ? resolve(opts.out ?? join(here, '.tools/results', new Date().toISOString().replace(/[:.]/g, '-'))) : null;
const written = names.map((name) => {
  const file = join(out, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(reply.files[name], 'base64'));
  return file;
});
const seconds = Math.round((Date.now() - t0) / 100) / 10;
// the job's own exit status, as far as one byte says it; 1 for a failure without one
const status = reply.ok ? 0 : reply.code == null ? 1 : reply.code & 255 || 1;
if (opts.json) finish({ ok: reply.ok, exitCode: reply.code ?? null, ...meta, port, seconds, outDir: out, files: written, log: reply.log, error: reply.ok ? null : reply.code == null ? reply.log.trim().split('\n').at(-1) : `exit code ${reply.code}` }, status);
// the end of its output: a Shell command's all of it
console.log(meta.kind === 'shell' ? reply.log.trimEnd() : reply.log.trim().split('\n').slice(-20).join('\n'));
if (meta.kind === 'shell') console.log(`exit code: ${reply.code ?? 'not started'}`);
for (const file of written) console.log(file);
console.log(`${reply.ok ? 'done' : 'failed'} in ${seconds} s`);
process.exit(status);
