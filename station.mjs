// 渲染站, the render station, on the owner's machine: keeps the render worker (worker.mjs) and the
// reverse SSH tunnel to lemon up, through sleep, wake and lost networks, and shows both in a small
// window (station.html, at http://127.0.0.1:7799): what it is doing, what ssh and render.mjs print
// as they print it, the jobs lately done, the settings. The tray icon, 渲染站.exe (exe/station.c),
// starts it and starts it again if it stops, and keeps what the settings ask of Windows (starting
// with it, the shortcuts), as /tray tells it. Its settings, the paths render.mjs needs and how to
// reach lemon, are in .tools/remote/config.json; what it did, in station.log.
// usage: node station.mjs
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS, WORKER, serve } from './worker.mjs';
import { createShellGate, isAdministrator } from './shell.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here);
const dir = join(repo, '.tools/remote');
mkdirSync(dir, { recursive: true });
/** the window's port */
const UI = 7799;
const win = process.platform === 'win32';

const pad = (n) => String(n).padStart(2, '0');
const took = (ms) => {
  const s = Math.round(ms / 1000);
  return ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} 秒` : `${Math.floor(s / 60)} 分 ${pad(s % 60)} 秒`;
};

// ——— the window, told of every change ———
const clients = new Set();
let pending = null;
let tunnel = { state: 'off' };
let job = null;
const jobs = [];
let today = { day: new Date().toDateString(), done: 0, failed: 0 };
let workerError = null;
let quitting = false;

// ——— what happened: kept in station.log, and shown in the window as it happens ———
const LOG = join(dir, 'station.log');
if (existsSync(LOG) && statSync(LOG).size > 1e6) rmSync(LOG);
const log = (line) => appendFileSync(LOG, `${new Date().toISOString()}  ${line}\n`);
process.on('uncaughtException', (e) => {
  log(`出错退出：${e?.stack ?? e}`);
  process.exit(1);
});
/** the window's feed, the latest 600 lines: what the station says ('station', 'tunnel', 'render')
 *  and what ssh and render.mjs print ('ssh', 'out') */
const feed = [];
let fresh = [];
let seq = 0;
function say(kind, text) {
  const item = { n: ++seq, t: Date.now(), kind, text };
  feed.push(item);
  fresh.push(item);
  if (feed.length > 600) feed.splice(0, feed.length - 600);
  push();
}
/** said, and kept */
function note(kind, text) {
  log(text);
  say(kind, text);
}
/** a stream's text line by line; a '\r' ends a line too (render.mjs rewrites its progress) */
function liner(each) {
  let rest = '';
  return (chunk, end = false) => {
    const parts = (rest + chunk).split(/\r\n|\r|\n/);
    rest = end ? '' : parts.pop().slice(-32768);
    for (const line of parts) if (line.trim()) each(line.trimEnd());
  };
}

// ——— settings ———
const CONFIG = join(dir, 'config.json');
const KEYS = ['PROMO_ROOT', 'PROMO_WORK', 'PROMO_SITE', 'PROMO_CHROME', 'PROMO_FFMPEG', 'PROMO_PROFILES', 'PROMO_GPU'];
// lemon by its address, so no ssh config is needed (the key: the owner's default one, or the agent's)
const LEMON = { target: 'lemon@23.251.32.150', port: '22222' };
// what render.mjs cannot do without here (on Windows its defaults are lemon's)
const NEEDED = win ? ['PROMO_ROOT', 'PROMO_WORK', 'PROMO_CHROME', 'PROMO_FFMPEG'] : ['PROMO_ROOT', 'PROMO_WORK'];
let config = {
  env: Object.fromEntries(KEYS.map((k) => [k, process.env[k] ?? (k === 'PROMO_GPU' ? '1' : '')])),
  ssh: { ...LEMON },
  paused: false,
  shell: { enabled: false, rules: [] },
};
try {
  const saved = JSON.parse(readFileSync(CONFIG, 'utf8'));
  config = { ...config, ...saved, env: { ...config.env, ...saved.env }, ssh: { ...config.ssh, ...saved.ssh } };
} catch {}
const save = () => writeFileSync(CONFIG, JSON.stringify(config, null, 2));
config.shell = { enabled: false, rules: [], ...config.shell };
const shellToken = randomBytes(32).toString('hex');
const shellGate = createShellGate({
  workspace: config.env.PROMO_ROOT || repo,
  policy: () => config.shell,
  save,
  admin: isAdministrator(),
  changed: push,
  audit: (text) => note('shell', text),
});

// ——— this machine, every 2 s, the last two minutes: the processor, the memory, the graphics card
// (NVIDIA's own tool where there is one, else Windows' counters) ———
const SAMPLES = 60;
const machine = { t: 0, cpu: [], mem: [], gpu: null, cpuName: (cpus()[0]?.model ?? '').trim(), cores: cpus().length, memTotal: totalmem(), gpuName: null };
const keepLast = (list, v) => {
  list.push(Math.round(Math.max(0, Math.min(100, v)) * 10) / 10);
  if (list.length > SAMPLES) list.shift();
};
let lastTimes = cpus().map((c) => c.times);
const SMI = [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'nvidia-smi.exe'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')].find((f) => win && existsSync(f));
let gpuBusy = false;
function sampleGpu() {
  if (!win || gpuBusy) return;
  gpuBusy = true;
  const done = (v, name) => {
    gpuBusy = false;
    if (v == null) return;
    machine.gpu ??= [];
    keepLast(machine.gpu, v);
    if (name) machine.gpuName = name;
  };
  if (SMI)
    execFile(SMI, ['--query-gpu=name,utilization.gpu', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 1800 }, (e, out) => {
      const [name, util] = String(out).split(/\r?\n/)[0].split(',').map((s) => s.trim());
      done(e ? null : Number(util) || 0, name);
    });
  else
    // every engine of every process that draws, added up
    execFile('typeperf', ['\\GPU Engine(*engtype_3D)\\Utilization Percentage', '-sc', '1'], { windowsHide: true, timeout: 1800 }, (e, out) => {
      const row = String(out).split(/\r?\n/).find((l) => /^"\d/.test(l));
      done(e || !row ? null : row.split(',').slice(1).reduce((sum, v) => sum + (Number(v.replace(/"/g, '')) || 0), 0));
    });
}
function sample() {
  const now = cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  now.forEach((t, i) => {
    const was = lastTimes[i] ?? t;
    for (const k of Object.keys(t)) total += t[k] - was[k];
    idle += t.idle - was.idle;
  });
  lastTimes = now;
  keepLast(machine.cpu, total ? (1 - idle / total) * 100 : 0);
  keepLast(machine.mem, (1 - freemem() / totalmem()) * 100);
  machine.t = Date.now();
  sampleGpu();
  push();
}

// ——— keeping up with the repository: its branch's new commits, fast-forward only, and only into a
// checkout with nothing of its own in it. When the station's code changed it starts again (exit 75:
// the tray icon starts it at once); when the tray icon's did, the tray icon starts itself again ———
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const git = (args) =>
  new Promise((done) =>
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd: repo, windowsHide: true, env: GIT_ENV, timeout: 120000 }, (e, out, err) =>
      done({ ok: !e, out: String(out ?? '').trim(), err: String(err || e?.message || '').trim().split(/\r?\n/).at(-1) }),
    ),
  );
let update = { state: 'idle', at: null, message: '' };
// the commit this checkout is at, for the settings page
let version = null;
async function readVersion() {
  const head = await git(['log', '-1', '--format=%h %ct']);
  if (!head.ok) return;
  const [commit, t] = head.out.split(' ');
  version = { commit, at: Number(t) * 1000 };
  push();
}
let trayAgain = false;
let updateAfterJob = false;
async function checkUpdate() {
  if (update.state === 'checking') return;
  const done = (state, message) => {
    update = { state, at: Date.now(), message };
    push();
  };
  update = { ...update, state: 'checking' };
  push();
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.ok) return done('error', '这份仓库没有跟着远程分支，或者这台电脑没装 git');
  const fetched = await git(['fetch', '--quiet']);
  if (!fetched.ok) return done('error', `取不到更新：${fetched.err}`);
  const behind = await git(['rev-list', '--count', `HEAD..${up.out}`]);
  if (behind.out === '0') return done('current', '已经是最新');
  const ahead = await git(['rev-list', '--count', `${up.out}..HEAD`]);
  const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
  if (ahead.out !== '0' || dirty.out) return done('blocked', `有 ${behind.out} 个新提交，但这份仓库里有${dirty.out ? '没提交的改动' : '没推上去的提交'}，没有自动更新`);
  // not in the middle of a render
  if (job || shellGate.state().pending) {
    updateAfterJob = true;
    return done('waiting', '有新版本，这个任务渲完就更新');
  }
  const changed = (await git(['diff', '--name-only', 'HEAD', up.out])).out.split(/\r?\n/);
  const merged = await git(['merge', '--ff-only', '--quiet', up.out]);
  if (!merged.ok) return done('error', `更新没成功：${merged.err}`);
  await readVersion();
  note('station', `更新到最新版：${behind.out} 个新提交`);
  done('updated', `${behind.out} 个新提交，已更新`);
  if (changed.some((f) => /^(渲染站\.exe|WebView2Loader\.dll)$/.test(f))) trayAgain = true;
  else if (changed.some((f) => /^[\w.-]+\.mjs$/.test(f))) {
    note('station', '渲染站的代码变了，马上重新启动');
    setTimeout(() => {
      stop();
      process.exit(75);
    }, 500);
  }
}

// ——— what the jobs made, kept here (KEEP): newest first, each with its files ———
const MEDIA = { '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const walkAll = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkAll(join(d, e.name)) : [join(d, e.name)]));
let shelf = [];
function restock() {
  try {
    shelf = !existsSync(KEEP)
      ? []
      : readdirSync(KEEP)
          .sort()
          .reverse()
          .map((name) => {
            const d = join(KEEP, name);
            let meta = {};
            try {
              meta = JSON.parse(readFileSync(join(d, 'job.json'), 'utf8'));
            } catch {}
            const files = walkAll(d)
              .filter((f) => MEDIA[extname(f)])
              // 9.5 before 10.45
              .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
              .map((f) => ({ url: `/files/${relative(KEEP, f).split(sep).map(encodeURIComponent).join('/')}`, path: f, name: relative(d, f).split(sep).join('/') }));
            return { name, at: meta.at ?? statSync(d).mtimeMs, ms: meta.ms ?? null, what: meta.args ? describe(meta.args) : name, files };
          })
          .filter((g) => g.files.length);
  } catch {
    shelf = [];
  }
}

const view = () => ({
  tunnel,
  job,
  jobs,
  today: today.day === new Date().toDateString() ? today : { done: 0, failed: 0 },
  workerError,
  config,
  shell: shellGate.state(),
  missing: NEEDED.filter((k) => !config.env[k]),
  // what the tray icon is to keep: both, unless switched off
  autostart: config.autostart !== false,
  shortcut: config.shortcut !== false,
  canShortcut: win,
  platform: process.platform,
  machine,
  shelf,
  update,
  version,
  autoUpdate: config.autoUpdate !== false,
  // the page, as it is on disk: a window showing an older one loads it again
  page: statSync(join(here, 'station.html')).mtimeMs,
});
/** for the tray icon, a line each: the mode, its tip, the pause item, the newest job and what to
 *  say of it, starting with Windows and the shortcuts (1 or 0), and whether to start itself again
 *  (1: it was updated) */
function trayView() {
  const mode = job ? 'busy' : tunnel.state === 'up' ? 'idle' : tunnel.state;
  const tip = { busy: `${job?.kind === 'shell' ? '执行中' : '渲染中'}：${job?.what}`, idle: `空闲，已连上 lemon:${tunnel.port}`, connecting: '正在连接 lemon', retry: '连不上 lemon，会自己重试', auth: 'lemon 不让登录，点开看看', off: '已暂停接单' }[mode] ?? mode;
  const last = jobs[0];
  const tell = !last ? ['', ''] : last.ok ? ['任务完成', `${last.what}，用了 ${took(last.ms)}，已交回 lemon。`] : ['任务失败', `${last.what}。输出在渲染站的「动态」里。`];
  const v = view();
  return [mode, `渲染站 · ${tip}`, tunnel.state === 'off' ? '继续接单' : '暂停接单', last ? `${last.id}@${last.started}` : '', ...tell, v.autostart ? '1' : '0', v.shortcut ? '1' : '0', trayAgain ? '1' : '0']
    .map((s) => String(s).replace(/\s*\n\s*/g, ' '))
    .join('\n');
}
function push() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    let data = `data: ${JSON.stringify(view())}\n\n`;
    if (fresh.length) data += `event: lines\ndata: ${JSON.stringify(fresh)}\n\n`;
    fresh = [];
    for (const c of clients) c.write(data);
  }, 120);
}

// ——— the worker ———
/** where what the jobs made is kept here too, to be looked at: the latest 30 jobs' worth */
const KEEP = join(repo, '.tools/remote/out');
/** what a job is, in a few words */
function describe(args) {
  const get = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  if (args.includes('--stills')) return `单帧 ${get('--stills').split(',').join('、')}${args.includes('--preview') ? '（半尺寸）' : ''}`;
  if (args.includes('--cover')) return '封面';
  return `片段 ${get('--from') ?? '开头'}–${get('--to') ?? '结尾'} 秒（半尺寸）`;
}
function startWorker() {
  let out = null;
  const server = serve({
    env: () => Object.fromEntries(Object.entries(config.env).filter(([, v]) => v !== '')),
    keep: KEEP,
    shell: shellGate,
    accepting: () => !config.paused && !quitting,
    on: (e) => {
      if (e.type === 'start') {
        const isShell = e.kind === 'shell';
        const n = e.args.includes('--stills') ? e.args[e.args.indexOf('--stills') + 1].split(',').length : e.args.includes('--cover') ? 2 : null;
        job = { id: e.id, kind: e.kind ?? 'render', what: isShell ? `Shell：${e.command}` : describe(e.args), started: Date.now(), n: 0, total: n, ms: null, frames: !isShell && n == null };
        note(isShell ? 'shell' : 'render', `收到任务 #${e.id}：${job.what}`);
        say('out', isShell ? `> [${e.cwd}] ${e.command} (${e.approval})` : `> node render.mjs ${e.args.join(' ')}`);
        out = liner((line) => say('out', line));
      } else if (e.type === 'log' && job) {
        // render.mjs: "frame n/total  T=…  ms ms/frame" every 30 frames; a path a still or a cover
        const frames = [...e.text.matchAll(/frame (\d+)\/(\d+)\s+T=[\d.]+\s+(\d+) ms\/frame/g)].at(-1);
        if (frames) Object.assign(job, { n: Number(frames[1]), total: Number(frames[2]), ms: Number(frames[3]) });
        else if (!job.frames) job.n += (e.text.match(/\.jpg(\r?\n|$)/g) ?? []).length;
        out?.(e.text);
      } else if (e.type === 'end') {
        if (e.kind === 'shell') note('shell', `Shell 结果 #${e.id}：${e.ok ? '成功' : '失败'}，退出码 ${e.code ?? 'unknown'}`);
        out?.('', true);
        out = null;
        // turned away before it started: why
        if (!job) say('out', e.tail.trim());
        const what = job?.what ?? '（没开始就被退回）';
        jobs.unshift({ id: e.id, what, started: job?.started ?? Date.now(), ms: e.ms, ok: e.ok, files: e.files, paths: e.paths, tail: e.tail, rate: job?.frames ? job.ms : null });
        jobs.length = Math.min(jobs.length, 20);
        if (today.day !== new Date().toDateString()) today = { day: new Date().toDateString(), done: 0, failed: 0 };
        today[e.ok ? 'done' : 'failed']++;
        restock();
        if (updateAfterJob) {
          updateAfterJob = false;
          setTimeout(checkUpdate, 1000);
        }
        note('render', e.ok ? `任务 #${e.id} 完成：${what}，用了 ${took(e.ms)}${e.files.length ? `，${e.files.length} 个文件交回 lemon` : ''}` : `任务 #${e.id} 失败：${what}，用了 ${took(e.ms)}`);
        job = null;
      }
      push();
    },
  });
  server.on('listening', () => {
    workerError = null;
    note('station', `渲染服务就绪，在 127.0.0.1:${WORKER}`);
  });
  server.on('error', (e) => {
    workerError = e.code === 'EADDRINUSE' ? `${WORKER} 端口被占用了：是不是另开了一个 worker.mjs？` : e.message;
    note('station', `渲染服务起不来：${workerError}，10 秒后再试`);
    // try again once whatever held the port has let go
    setTimeout(startWorker, 10000);
  });
}

// ——— the tunnel: ssh, again and again ———
let ssh = null;
let timer = null;
let tries = 0;
let slot = 0;
function connect() {
  clearTimeout(timer);
  if (config.paused || quitting) {
    tunnel = { state: 'off' };
    return push();
  }
  const port = PORTS[slot % PORTS.length];
  const args = [
    '-N', '-T', '-v',
    // never ask for a password: there is nobody to type it
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    // a connection that died in sleep is noticed in under a minute
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=15',
    ...(config.ssh.port ? ['-p', config.ssh.port] : []),
    '-R', `${port}:127.0.0.1:${WORKER}`,
    config.ssh.target,
  ];
  note('tunnel', `连接 lemon：ssh ${config.ssh.target}${config.ssh.port ? ` -p ${config.ssh.port}` : ''}，lemon 那头用 ${port} 端口`);
  const p = spawn('ssh', args, { windowsHide: true });
  ssh = p;
  tunnel = { state: 'connecting', port };
  push();
  let err = '';
  const up = () => {
    if (ssh !== p || tunnel.state !== 'connecting') return;
    tunnel = { state: 'up', port, since: Date.now() };
    tries = 0;
    note('tunnel', `隧道通了：lemon 的 127.0.0.1:${port} 连到这台电脑的渲染服务`);
  };
  // ssh -v says so; or, failing that, still there after a while with nothing refused
  const still = setTimeout(up, 10000);
  // what ssh says, without its debugging
  const lines = liner((line) => {
    if (!/^debug\d?:/.test(line)) say('ssh', line);
  });
  p.stderr.on('data', (d) => {
    err = (err + d).slice(-6000);
    lines(String(d));
    if (/remote forward success|forwarding_success/i.test(String(d))) up();
  });
  let ended = false;
  const end = (why) => {
    if (ended) return;
    ended = true;
    clearTimeout(still);
    lines('', true);
    if (why) err += `\n${why}`;
    // stopped on purpose, or another one started
    if (ssh !== p) return;
    ssh = null;
    if (config.paused || quitting) {
      tunnel = { state: 'off' };
      return push();
    }
    const said = err
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith('debug') && !/^(OpenSSH|Authenticated|Transferred|Bytes per)/.test(l))
      .slice(-2)
      .join(' ')
      .trim();
    // nothing to be done by trying again: the key, the host's key, no ssh at all
    if (/Permission denied|Host key verification failed|Could not resolve hostname|ENOENT/i.test(err)) {
      tunnel = { state: 'auth', message: said };
      return note('tunnel', `lemon 不让登录：${said || '没有说原因'}`);
    }
    // the port on lemon still held by a connection that died: the next one, at once
    const held = /remote port forwarding failed/i.test(err);
    if (held) slot++;
    const wait = held ? 500 : Math.min(30000, 2000 * 2 ** Math.min(tries, 4));
    tries++;
    tunnel = { state: 'retry', retryAt: Date.now() + wait, wait, message: said };
    note('tunnel', held ? `lemon 的 ${port} 端口还被断掉的旧连接占着，换下一个` : `隧道断了${said ? `：${said}` : ''}，${Math.round(wait / 1000)} 秒后重连`);
    timer = setTimeout(connect, wait);
  };
  p.on('error', (e) => end(e.code === 'ENOENT' ? 'ENOENT: no ssh on this machine' : e.message));
  p.on('close', () => end());
}
function stop() {
  shellGate.revoke();
  const p = ssh;
  ssh = null;
  clearTimeout(timer);
  p?.kill();
  tunnel = { state: 'off' };
}
function restart() {
  stop();
  tries = 0;
  connect();
}
// back from sleep: the connection is dead, though ssh takes most of a minute to see it
let tick = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - tick > 30000 && !config.paused && !quitting) {
    note('tunnel', '电脑刚醒，重新连接');
    restart();
  }
  tick = now;
}, 5000);

// ——— the window's server ———
const fonts = {
  '/fonts/lxgw/': join(repo, 'node_modules/lxgw-wenkai-webfont'),
  '/fonts/outfit/': join(repo, 'node_modules/@fontsource-variable/outfit'),
};
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.woff2': 'font/woff2' };
const send = (res, file) => {
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'max-age=86400' });
  createReadStream(file).pipe(res);
};
/** a file, or the part of it asked for (a video, played from where it is dragged to) */
function sendRange(req, res, file) {
  const size = statSync(file).size;
  const head = { 'content-type': MEDIA[extname(file)], 'accept-ranges': 'bytes', 'cache-control': 'max-age=3600' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!m || (!m[1] && !m[2])) {
    res.writeHead(200, { ...head, 'content-length': size });
    return createReadStream(file).pipe(res);
  }
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start > end) return res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
  res.writeHead(206, { ...head, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
  createReadStream(file, { start, end }).pipe(res);
}
const json = (res, data) => res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
const body = (req) =>
  new Promise((done) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => done(s));
  });
function quit() {
  quitting = true;
  log('渲染站退出');
  stop();
  setTimeout(() => process.exit(0), 300);
}

const ui = createServer(async (req, res) => {
  // only for this machine's own window: a page whose name is not 127.0.0.1 is turned away
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost'].includes(host)) return res.writeHead(403).end();
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.writeHead(403).end();
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return res.writeHead(400).end();
  }
  if (req.method === 'GET') {
    if (path === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' }).end(readFileSync(join(here, 'station.html'), 'utf8').replace('__SHELL_LOCAL_TOKEN__', shellToken));
    if (path === '/state') return json(res, view());
    if (path.startsWith('/files/')) {
      const file = normalize(join(KEEP, path.slice('/files/'.length)));
      if (!file.startsWith(KEEP + sep) || !MEDIA[extname(file)] || !existsSync(file)) return res.writeHead(404).end();
      return sendRange(req, res, file);
    }
    if (path === '/tray') return res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(trayView());
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify(view())}\n\nevent: lines\ndata: ${JSON.stringify(feed)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const prefix = Object.keys(fonts).find((p) => path.startsWith(p));
    const file = prefix && normalize(join(fonts[prefix], path.slice(prefix.length)));
    if (file && file.startsWith(fonts[prefix]) && existsSync(file) && statSync(file).isFile()) return send(res, file);
    return res.writeHead(404).end();
  }
  // changes only from the window or the tray: another page cannot send this header without asking
  // first, and is not answered when it asks
  if (req.method !== 'POST' || req.headers['x-station'] !== '1') return res.writeHead(403).end();
  if (path.startsWith('/shell/') && req.headers['x-shell-local'] !== shellToken) return res.writeHead(403).end();
  let data;
  try {
    const text = await body(req);
    data = text ? JSON.parse(text) : {};
  } catch {
    return res.writeHead(400).end();
  }
  try {
    if (path === '/shell/enabled') {
      if (typeof data.on !== 'boolean') throw new Error('on must be boolean');
      config.shell.enabled = data.on;
      if (!data.on) shellGate.revoke();
      save();
      note('shell', `Shell 接单：${data.on ? '开启（auto）' : '关闭'}`);
    } else if (path === '/shell/yolo') {
      shellGate.setYolo(data.on);
    } else if (path === '/shell/decide') {
      shellGate.decide(data.id, data.action);
    } else if (path === '/shell/remove') {
      shellGate.remove(data.index);
    } else if (path === '/pause') {
      config.paused = true;
      save();
      stop();
      note('station', '暂停接单，隧道关了');
    } else if (path === '/resume') {
      config.paused = false;
      save();
      note('station', '继续接单');
      restart();
    } else if (path === '/reconnect') {
      note('tunnel', '重新连接');
      restart();
    } else if (path === '/config') {
      for (const k of KEYS) if (typeof data.env?.[k] === 'string') config.env[k] = data.env[k].trim();
      if (data.ssh) config.ssh = { target: String(data.ssh.target ?? '').trim() || LEMON.target, port: String(data.ssh.port ?? '').trim() };
      save();
      note('station', '设置已保存');
      restart();
    } else if (path === '/autostart') {
      config.autostart = !!data.on;
      save();
      note('station', data.on ? '登录 Windows 后自动启动：开' : '登录 Windows 后自动启动：关');
    } else if (path === '/shortcut') {
      config.shortcut = !!data.on;
      save();
      note('station', data.on ? '桌面和开始菜单里放上「渲染站」' : '桌面和开始菜单里的「渲染站」拿掉');
    } else if (path === '/update') checkUpdate();
    else if (path === '/autoupdate') {
      config.autoUpdate = !!data.on;
      save();
    } else if (path === '/reveal') {
      // what a job made, opened or shown in its folder (the window of 渲染站.exe asks it itself)
      const file = resolve(String(data.path ?? ''));
      if (!file.startsWith(KEEP) || !existsSync(file)) return res.writeHead(404).end();
      const opener = win ? 'explorer.exe' : 'xdg-open';
      spawn(opener, win && data.show ? [`/select,${file}`] : [file], { detached: true, stdio: 'ignore' }).unref();
    } else if (path === '/quit') {
      json(res, { ok: true });
      return quit();
    } else return res.writeHead(404).end();
  } catch (e) {
    note('station', `${path} 出错：${e.message}`);
    return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: e.message }));
  }
  push();
  json(res, view());
});
// one station at a time: a second one finds the port taken and goes
ui.on('error', (e) => {
  if (e.code === 'EADDRINUSE') process.exit(0);
  throw e;
});
ui.listen(UI, '127.0.0.1', () => {
  note('station', `渲染站启动，窗口在 http://127.0.0.1:${UI}`);
  restock();
  readVersion();
  startWorker();
  connect();
  setInterval(sample, 2000);
  // a minute after starting, then every half hour
  const auto = () => config.autoUpdate !== false && checkUpdate();
  setTimeout(auto, 60000);
  setInterval(auto, 30 * 60000);
});
