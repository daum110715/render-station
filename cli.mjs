#!/usr/bin/env node
// On the server: hands jobs to the worker on the machine that does the heavy work (worker.mjs, kept
// up there by the render station, with the reverse SSH tunnel it opens to here; it comes in on a
// port from 7700 to 7709, or the one RENDER_STATION_PORT names). Installed as `render-station` and
// `rs` (npm link); `rs help` says what each command does, docs/cli.md says it at length.
// --json: one JSON object on stdout, the end of it all ({ ok, …, error }).
// Exit status: the job's own when it ran; 1 when it failed without running, or a request was
// refused; 2 for a usage error; 3 when no worker is reached, or it is paused or its queue full.
import { request } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip, gzipSync } from 'node:zlib';
import { HEADER, PORTS, PROTOCOL } from './worker.mjs';
import { gather, safeRel } from './workspace.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// ——— the commands, and what `rs help` says of them ———
const ALIAS = { st: 'status', sh: 'shell', ws: 'workspace' };
/** each command's options that take a value (`many`: given more than once), those that do not, and
 *  whether its options may come after its words (else they end where the words start: what follows
 *  is a job's arguments, or a command) */
const COMMANDS = {
  status: { takes: [], anywhere: true },
  presets: { takes: [], anywhere: true },
  run: { takes: ['--src', '--out'] },
  shell: { takes: ['--workspace', '--cwd', '--timeout'] },
  workspace: { takes: ['--path', '--env', '--unset'], many: ['--env', '--unset'], flags: ['--create'], anywhere: true },
  ls: { takes: [], anywhere: true },
  clip: { takes: ['--file'], anywhere: true },
  help: { takes: [], anywhere: true },
};
const HELP = {
  '': `render-station (also: rs) hands heavy jobs from this server to the render station on another
machine, and looks after the workspaces there.

usage: rs <command> [options]

commands:
  status, st       whether the device is reached, what runs there, and its workspaces
  presets          the presets of the workspaces, and the arguments they take
  run              run a preset of a workspace, and fetch what it makes
  shell, sh        run a command in a workspace, as the owner allows
  workspace, ws    list the workspaces, or add, change or remove one
  ls               list a folder on the device, or its drives
  clip             what was copied on the device, or put something on its clipboard
  help             this, or what one command does: rs help <command>

Every command takes --json: then it prints one JSON object, its result, and nothing else.
Exit status: 0 when done; when a job ran and failed, the job's own; 1 when it failed without
running, or a request was refused; 2 for a usage error; 3 when the device is not reached, is paused,
or has too many jobs waiting.
The device is reached through the tunnel on ports 7700-7709 here, or the port RENDER_STATION_PORT
names. The manual: docs/cli.md in the render-station repository.`,
  status: `usage: rs status [--json]

Whether the render station on the device is reached; how many jobs run and wait there and how many
may run at once; whether it takes Shell commands and requests to manage workspaces; and each
workspace, with its presets and the settings it still lacks.`,
  presets: `usage: rs presets [<workspace>] [--json]

The presets of every workspace, or of one: what each does, the arguments it takes (each argument
must match one of the patterns listed), the files a job brings from here, and its time limit.

example: rs presets site`,
  run: `usage: rs run [--src <dir>] [--out <dir>] [--json] <workspace>/<preset> [args…]

Runs a preset of a workspace on the device and waits for it to end. Everything after
<workspace>/<preset> is passed to the preset as its arguments; options come before it.

  --src <dir>   where the files the preset brings are taken from (default: the current folder)
  --out <dir>   where what the job makes is written (default: .tools/results/<time>/ in the
                render-station folder)

When the device is busy, the job waits its turn and the command says how many jobs are ahead.
Interrupting the command cancels the job, waiting or running.

example: rs run --src ~/site site/build 1080p`,
  shell: `usage: rs shell [--workspace <name>] [--cwd <dir>] [--timeout <s>] [--json] <command…>

Runs a command on the device (in PowerShell on Windows) and prints its output and exit code. The
owner must have turned Shell on there; a command not on their allowlist waits up to 5 minutes for
their approval. Options come before the command.

  --workspace <name>  the workspace to run in (default: the first registered)
  --cwd <dir>         a folder in the workspace to run in, relative to its root
  --timeout <s>       the time limit, in seconds

example: rs sh --workspace site git status`,
  workspace: `usage: rs workspace [list] [--json]
       rs workspace add <name> <path> [--create] [--env NAME=value …] [--json]
       rs workspace set <name> [--path <path> [--create]] [--env NAME=value …] [--unset NAME …] [--json]
       rs workspace remove <name> [--json]

Lists the workspaces registered on the device, or changes them as far as the owner lets the server
(the render station's setting 服务器管理工作区): a change waits up to 5 minutes for their approval
on the device, or is made at once, as they chose.

  <path>           a full path on the device: F:/projects/site, or quoted, 'F:\\projects\\site'
  --create         make the folder if it is not there yet
  --env NAME=value a setting of the workspace (its render-station.json names them); given more
                   than once for more than one
  --unset NAME     clear a setting

When a workspace is added, settings an old render station kept in that folder
(.tools/remote/config.json) are taken over.

examples: rs ws
          rs ws add site F:/projects/site
          rs ws set site --env FFMPEG=C:/ffmpeg/bin/ffmpeg.exe`,
  ls: `usage: rs ls [<path>] [--json]

Lists a folder on the device: the name, size and last change of each file and folder in it, but
nothing of what the files hold. Without a path, the drives.

Folders in a registered workspace are listed at once. Others are listed as the owner lets the
server: when each request needs their approval, a folder approved stays open, with everything under
it, for 10 minutes.

examples: rs ls
          rs ls F:/`,
  clip: `usage: rs clip [--json]
       rs clip ls [--json]
       rs clip set [<text…>] [--file <path>] [--json]

The device's clipboard, while its owner has 同步剪贴板 (clipboard sync) on in the render station's
settings there. What is copied on the device comes here by itself, within a second or so (or once
the device connects again), into ~/.render-station/clipboard/. rs clip prints the newest, or for a
picture the path of its PNG; rs clip ls lists the last 50. Both read what is here and do not need
the device.

rs clip set puts something on the device's clipboard: the text given, what is piped in, or a file.
A PNG, JPEG, GIF, BMP or TIFF goes there as a picture, anything else as text (UTF-8); up to 20 MB.
Text that starts with -- goes after --.

examples: rs clip
          git diff | rs clip set
          rs clip set --file shot.png`,
  help: `usage: rs help [<command>]

What the commands do, or what one does.`,
};

const argv = process.argv.slice(2);
const what = ALIAS[argv[0]] ?? argv[0];
if (what == null || what === '-h' || what === '--help') {
  console.log(HELP['']);
  process.exit(0);
}
const cmd = COMMANDS[what];
const rest = argv.slice(1);
const opts = {};
const words = [];
let i = 0;
for (; cmd && i < rest.length; i++) {
  const a = rest[i];
  if (a === '--') {
    i++;
    break;
  }
  if (a === '--json') opts.json = true;
  else if (a === '-h' || a === '--help') opts.help = true;
  else if (cmd.flags?.includes(a)) opts[a.slice(2)] = true;
  else if (cmd.takes.includes(a)) {
    if (rest[i + 1] == null) usage(`${a}: a value`);
    const v = rest[++i];
    if (cmd.many?.includes(a)) (opts[a.slice(2)] ??= []).push(v);
    else opts[a.slice(2)] = v;
  } else if (a.startsWith('--')) usage(`unknown option: ${a}`);
  else if (cmd.anywhere) words.push(a);
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
  // the command's usage lines, or the list of commands
  const brief = COMMANDS[what] ? HELP[what].split('\n\n')[0] : HELP[''].split('\n\n').slice(1, 3).join('\n\n');
  const text = `${why}\n\n${brief}\n\n(rs help${COMMANDS[what] ? ` ${what}` : ''}: more)`;
  if (process.argv.includes('--json')) finish({ ok: false, error: text }, 2);
  console.error(text);
  process.exit(2);
}
if (!cmd) usage(`unknown command: ${argv[0]}`);
if (opts.help || what === 'help') {
  const of = what === 'help' ? (ALIAS[words[0]] ?? words[0] ?? '') : what;
  if (!(of in HELP)) usage(`no such command: ${words[0]}`);
  console.log(HELP[of]);
  process.exit(0);
}
/** what is said on the way, unless only JSON is */
const tell = (text) => opts.json || console.error(text);

// ——— the worker ———
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
/** a request to the worker on `port` answered as it goes, a line of JSON each step (gzipped, for a
 *  job): each step told as it comes (`step(event)`), and at the end the reply's status and the last
 *  step's reply (or, refused, the body). A station from before it answered so sends the reply alone */
const stream = (port, path, body, extra, step) =>
  new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { ...headers, 'content-type': 'application/json', accept: 'application/x-ndjson', ...extra } }, (res) => {
      const input = res.headers['content-encoding'] === 'gzip' ? res.pipe(createGunzip()) : res;
      if (res.statusCode !== 200 || !(res.headers['content-type'] ?? '').includes('ndjson')) {
        const chunks = [];
        input.on('data', (c) => chunks.push(c));
        input.on('end', () => {
          const all = Buffer.concat(chunks);
          if (res.statusCode !== 200) return done({ status: res.statusCode, body: all });
          try {
            done({ status: 200, reply: JSON.parse(all) });
          } catch (e) {
            fail(e);
          }
        });
        input.on('error', fail);
        return;
      }
      // the last line, with all that came back, may be large
      let part = [];
      let reply = null;
      input.on('data', (c) => {
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
      input.on('end', () => (reply ? done({ status: 200, reply }) : fail(new Error('the worker stopped answering before the end'))));
      input.on('error', fail);
      res.on('error', fail);
    });
    req.on('error', fail);
    req.end(body);
  });

// ——— what was copied on the device: here already, the device not needed ———
const CLIP_DIR = join(homedir(), '.render-station/clipboard');
const CLIP_MAX = 20 * 1024 * 1024;
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
/** a file of the clipboard's, as listed: its path, what it is, its size, when it came */
const clipFile = (path) => {
  const s = statSync(path);
  return { path, type: path.endsWith('.png') ? 'image' : 'text', size: s.size, at: s.mtimeMs };
};
if (what === 'clip' && words[0] !== 'set') {
  if (opts.file) usage('clip: --file is for set');
  if (words.length > 1 || (words.length && words[0] !== 'ls')) usage('clip: nothing, ls or set');
  const latest = ['latest.txt', 'latest.png'].map((f) => join(CLIP_DIR, f)).filter((f) => existsSync(f)).map(clipFile).sort((a, b) => b.at - a.at)[0];
  const none = `nothing copied on the device has come here yet (${CLIP_DIR}); it comes while 同步剪贴板 (clipboard sync) is on in the render station's settings there`;
  if (words[0] === 'ls') {
    const history = join(CLIP_DIR, 'history');
    const list = existsSync(history) ? readdirSync(history).filter((f) => /\.(txt|png)$/.test(f)).map((f) => clipFile(join(history, f))).sort((a, b) => b.at - a.at) : [];
    if (opts.json) finish({ ok: true, entries: list }, 0);
    if (!list.length) finish({ ok: false, error: none }, 1);
    const pad = (n) => String(n).padStart(2, '0');
    for (const e of list) {
      const d = new Date(e.at);
      const head = e.type === 'text' ? readFileSync(e.path).subarray(0, 300).toString('utf8').replace(/\uFFFD$/, '').replace(/\s+/g, ' ').trim() : '';
      console.log(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}  ${e.type === 'image' ? 'picture' : 'text   '}  ${bytes(e.size).padStart(8)}  ${e.path}${head ? `\n    ${head.length > 72 ? `${head.slice(0, 72)}…` : head}` : ''}`);
    }
    process.exit(0);
  }
  if (!latest) finish({ ok: false, error: none }, 1);
  if (latest.type === 'image') {
    if (opts.json) finish({ ok: true, ...latest }, 0);
    console.log(latest.path);
    process.exit(0);
  }
  const text = readFileSync(latest.path, 'utf8');
  if (opts.json) finish({ ok: true, ...latest, text }, 0);
  process.stdout.write(process.stdout.isTTY && !text.endsWith('\n') ? `${text}\n` : text);
  process.exit(0);
}

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
const MISMATCH = () => `protocol mismatch: the worker uses version ${hello.protocol}, this command version ${PROTOCOL}; update the one that is older`;
const MANAGE = { off: 'not allowed', ask: 'each needs the owner\'s approval', allow: 'allowed' };
if (what === 'status') {
  if (!hello) finish({ online: false, error: OFFLINE }, 3);
  if (hello.protocol !== PROTOCOL) finish({ online: true, port, ...hello, error: MISMATCH() }, 1);
  if (opts.json) finish({ online: true, port, ...hello }, 0);
  const load = `${hello.running.length} of ${hello.limit} running${hello.queued ? `, ${hello.queued} queued` : ''}`;
  console.log(`worker on port ${port}: ${hello.platform}; ${load}${hello.accepting ? '' : '; paused'}; Shell ${hello.shell}; workspace changes and folder lookups: ${MANAGE[hello.manage] ?? hello.manage}`);
  for (const j of hello.running) console.log(`  #${j.id} ${j.kind === 'shell' ? `shell: ${j.command}` : `${j.workspace}/${j.preset} ${j.args.join(' ')}`.trim()}`);
  printWorkspaces();
  process.exit(0);
}
if (hello && hello.protocol !== PROTOCOL) finish({ ok: false, error: MISMATCH() }, 1);
if (!hello) finish({ ok: false, error: OFFLINE }, 3);
/** refused, if the station on the device is older than what is asked of it */
const need = (feature, what) => (hello.features ?? []).includes(feature) || finish({ ok: false, error: `the render station on the device is too old for ${what}: it updates itself, or check for updates in its settings` }, 1);

function printWorkspaces() {
  for (const w of hello.workspaces) {
    console.log(`\n${w.name}  (${w.path})${w.parallel > 1 ? `  up to ${w.parallel} jobs at once` : ''}${w.error ? `\n  error: ${w.error}` : ''}${w.missing.length ? `\n  not set up yet: ${w.missing.join(', ')}` : ''}`);
    for (const [name, p] of Object.entries(w.presets)) console.log(`  ${w.name}/${name}${p.description ? `  ${p.description}` : ''}`);
  }
  if (!hello.workspaces.length) console.log('no workspaces registered');
}

// ——— what is there ———
if (what === 'presets') {
  if (words.length > 1) usage('presets: one workspace at most');
  const list = words[0] ? hello.workspaces.filter((w) => w.name === words[0]) : hello.workspaces;
  if (words[0] && !list.length) finish({ ok: false, error: `no workspace "${words[0]}" there (it has: ${hello.workspaces.map((x) => x.name).join(', ') || 'none'})` }, 1);
  const presets = list.flatMap((w) => Object.entries(w.presets).map(([name, p]) => ({ workspace: w.name, name, ...p })));
  if (opts.json) finish({ ok: true, presets }, 0);
  for (const p of presets) {
    console.log(`${p.workspace}/${p.name}${p.description ? `  ${p.description}` : ''}`);
    console.log(`  arguments: ${p.args.length ? p.args.join('  |  ') : 'none'}`);
    if (p.upload.length) console.log(`  brings:    ${p.upload.join(', ')}`);
    if (p.timeout) console.log(`  limit:     ${p.timeout} s`);
  }
  if (!presets.length) console.log(hello.workspaces.length ? 'no presets' : 'no workspaces registered');
  process.exit(0);
}
if (what === 'workspace' && (!words.length || words[0] === 'list')) {
  if (words.length > 1 || opts.path || opts.env || opts.unset || opts.create) usage('workspace list: nothing more');
  if (opts.json) finish({ ok: true, workspaces: hello.workspaces }, 0);
  printWorkspaces();
  process.exit(0);
}

/** a request about the workspaces or the device's folders: its reply, once the owner allows it */
async function manage(path, body, about) {
  if (hello.manage === 'off') finish({ ok: false, error: 'the owner of the device does not let the server manage workspaces or look through folders (the render station\'s settings there)' }, 1);
  const step = (e) => e.event === 'pending' && tell('waiting for the owner\'s approval on the device (up to 5 minutes)');
  const res = await stream(port, path, Buffer.from(JSON.stringify(body)), {}, step).catch((e) => finish({ ok: false, ...about, error: `lost the connection to the worker: ${e.message}` }, 3));
  if (res.status === 503) finish({ ok: false, ...about, error: 'the render station is paused' }, 3);
  if (res.status !== 200) finish({ ok: false, ...about, error: `the worker answered ${res.status}: ${res.body.toString().slice(0, 500)}` }, 1);
  return res.reply;
}

// ——— a folder on the device ———
if (what === 'ls') {
  if (words.length > 1) usage('ls: one path at most (quote one with spaces in it)');
  need('browse', 'ls');
  const reply = await manage('/browse', { path: words[0] ?? null }, { path: words[0] ?? null });
  if (opts.json || !reply.ok) finish(reply, reply.ok ? 0 : 1);
  const pad = (n) => String(n).padStart(2, '0');
  const when = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const size = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);
  if (reply.path == null) console.log(reply.entries.map((e) => e.name).join('\n'));
  else {
    console.log(reply.path);
    for (const e of reply.entries) console.log(`  ${e.modified == null ? ' '.repeat(16) : when(e.modified)}  ${(e.size == null ? '' : size(e.size)).padStart(9)}  ${e.name}${e.type === 'folder' ? '/' : ''}`);
    if (!reply.entries.length) console.log('  (empty)');
    if (reply.more) console.log(`  … and ${reply.more} more`);
  }
  process.exit(0);
}

// ——— a change to the workspaces ———
if (what === 'workspace') {
  const [action, name, path] = words;
  const takes = { add: 3, set: 2, remove: 2 }[action];
  if (!takes) usage('workspace: list, add, set or remove');
  if (words.length !== takes) usage(`workspace ${action}: ${action === 'add' ? 'a name and a path' : 'a name'}`);
  if (action !== 'set' && (opts.path || opts.unset)) usage(`workspace ${action}: --path and --unset are for set`);
  if (action === 'remove' && (opts.env || opts.create)) usage('workspace remove: no --env or --create');
  if (action === 'set' && opts.create && !opts.path) usage('workspace set: --create goes with --path');
  if (opts.create) need('create', '--create');
  const env = {};
  for (const pair of opts.env ?? []) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(pair);
    if (!m) usage(`--env: NAME=value, not ${pair}`);
    env[m[1]] = m[2];
  }
  const change = { action, name, ...(path ? { path } : {}), ...(opts.path ? { path: opts.path } : {}), ...(opts.create ? { create: true } : {}), ...(opts.env ? { env } : {}), ...(opts.unset ? { unset: opts.unset } : {}) };
  const reply = await manage('/workspace', change, { action });
  if (opts.json || !reply.ok) finish(reply, reply.ok ? 0 : 1);
  const w = reply.workspace;
  console.log(`${{ add: 'added', set: 'changed', remove: 'removed' }[action]} workspace ${name}${w ? ` (${w.path})` : ''}`);
  if (reply.created) console.log(`made the folder ${reply.created}`);
  if (reply.imported?.length) console.log(`taken from the settings of the render station from before workspaces: ${reply.imported.join(', ')}`);
  if (w?.error) console.log(`error: ${w.error}`);
  if (w?.missing.length) console.log(`not set up yet: ${w.missing.join(', ')}`);
  if (w) console.log(w.presets.length ? `presets: ${w.presets.map((p) => `${w.name}/${p}`).join(', ')}` : 'no presets');
  process.exit(0);
}

// ——— onto the device's clipboard ———
/** a picture Windows reads, by how its bytes begin (a BMP: by the size it gives, too, so text that
 *  starts with BM is text) */
const isPicture = (b) =>
  (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) ||
  (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
  (b.length > 6 && /^GIF8[79]a/.test(b.subarray(0, 6).toString('latin1'))) ||
  (b.length > 14 && b[0] === 0x42 && b[1] === 0x4d && b.readUInt32LE(2) === b.length) ||
  (b.length > 4 && ['49492a00', '4d4d002a'].includes(b.subarray(0, 4).toString('hex')));
if (what === 'clip') {
  const given = words.slice(1);
  if (opts.file && given.length) usage('clip set: the text or --file, not both');
  if (!opts.file && !given.length && process.stdin.isTTY) usage('clip set: the text, --file <path>, or something piped in');
  need('clip', 'clip set');
  if (!hello.clipboard) finish({ ok: false, error: 'the owner of the device has not turned on 同步剪贴板 (clipboard sync) in the render station\'s settings there' }, 1);
  let data;
  try {
    data = opts.file ? readFileSync(resolve(opts.file)) : given.length ? Buffer.from(given.join(' '), 'utf8') : readFileSync(0);
  } catch (e) {
    finish({ ok: false, error: `could not read ${opts.file ?? 'what was piped in'}: ${e.message}` }, 1);
  }
  if (!data.length) finish({ ok: false, error: 'clip set: nothing to put there' }, 1);
  if (data.length > CLIP_MAX) finish({ ok: false, error: `clip set: up to 20 MB, not ${bytes(data.length)}` }, 1);
  const type = isPicture(data) ? 'image' : 'text';
  const body = JSON.stringify(type === 'image' ? { type, data: data.toString('base64') } : { type, text: data.toString('utf8') });
  const res = await call(port, 'POST', '/clip', Buffer.from(body)).catch((e) => finish({ ok: false, error: `lost the connection to the worker: ${e.message}` }, 3));
  if (res.status === 503) finish({ ok: false, error: 'the render station is paused' }, 3);
  if (res.status !== 200) finish({ ok: false, error: `the worker answered ${res.status}: ${res.body.toString().slice(0, 500)}` }, 1);
  const reply = JSON.parse(res.body);
  if (opts.json || !reply.ok) finish(reply, reply.ok ? 0 : 1);
  console.log(`put on the device's clipboard: ${type === 'image' ? 'a picture' : 'text'}, ${bytes(reply.size ?? data.length)}`);
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
}

const t0 = Date.now();
let waited = false;
const step = (e) => {
  if (e.event === 'pending') tell('waiting for the owner\'s approval on the device (up to 5 minutes)');
  else if (e.event === 'queued') {
    waited = true;
    tell(e.ahead ? `queued on the device: ${e.ahead} ${e.ahead > 1 ? 'jobs' : 'job'} ahead` : 'queued on the device: next to start');
  } else if (e.event === 'started' && waited) tell('started');
};
const res = await stream(port, '/job', gzipSync(JSON.stringify(payload)), { 'content-encoding': 'gzip' }, step).catch((e) => finish({ ok: false, exitCode: null, ...meta, error: `lost the connection to the worker: ${e.message}` }, 3));
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
