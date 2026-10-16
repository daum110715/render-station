// 渲染站, the render station, on the owner's machine: keeps the render worker (worker.mjs) and the
// reverse SSH tunnel to lemon up, through sleep, wake and lost networks, and shows both in a small
// window (station.html, at http://127.0.0.1:7799): what it is doing, what ssh and render.mjs print
// as they print it, the jobs lately done, the settings. The tray icon (station.ps1; station.vbs to
// double-click, with no terminal) starts it and starts it again if it stops. Its settings, the
// paths render.mjs needs and how to reach lemon, are in .tools/remote/config.json; what it did, in
// station.log.
// usage: node promo/remote/station.mjs
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS, WORKER, serve } from './worker.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = resolve(here, '../..');
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
    rest = end ? '' : parts.pop();
    for (const line of parts) if (line.trim()) each(line.trimEnd());
  };
}

// ——— settings ———
const CONFIG = join(dir, 'config.json');
const KEYS = ['PROMO_WORK', 'PROMO_SITE', 'PROMO_CHROME', 'PROMO_FFMPEG', 'PROMO_PROFILES', 'PROMO_GPU'];
// lemon by its address, so no ssh config is needed (the key: the owner's default one, or the agent's)
const LEMON = { target: 'lemon@23.251.32.150', port: '22222' };
// what render.mjs cannot do without here (on Windows its defaults are lemon's)
const NEEDED = win ? ['PROMO_WORK', 'PROMO_CHROME', 'PROMO_FFMPEG'] : ['PROMO_WORK'];
let config = {
  env: Object.fromEntries(KEYS.map((k) => [k, process.env[k] ?? (k === 'PROMO_GPU' ? '1' : '')])),
  ssh: { ...LEMON },
  paused: false,
};
try {
  const saved = JSON.parse(readFileSync(CONFIG, 'utf8'));
  config = { ...config, ...saved, env: { ...config.env, ...saved.env }, ssh: { ...config.ssh, ...saved.ssh } };
} catch {}
const save = () => writeFileSync(CONFIG, JSON.stringify(config, null, 2));

const view = () => ({
  tunnel,
  job,
  jobs,
  today: today.day === new Date().toDateString() ? today : { done: 0, failed: 0 },
  workerError,
  config,
  missing: NEEDED.filter((k) => !config.env[k]),
  autostart: autostartOn(),
  shortcut: shortcutOn(),
  canShortcut: !!folders,
  platform: process.platform,
});
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
    on: (e) => {
      if (e.type === 'start') {
        const n = e.args.includes('--stills') ? e.args[e.args.indexOf('--stills') + 1].split(',').length : e.args.includes('--cover') ? 2 : null;
        job = { id: e.id, what: describe(e.args), started: Date.now(), n: 0, total: n, ms: null, frames: n == null };
        note('render', `收到任务 #${e.id}：${job.what}`);
        say('out', `> node render.mjs ${e.args.join(' ')}`);
        out = liner((line) => say('out', line));
      } else if (e.type === 'log' && job) {
        // render.mjs: "frame n/total  T=…  ms ms/frame" every 30 frames; a path a still or a cover
        const frames = [...e.text.matchAll(/frame (\d+)\/(\d+)\s+T=[\d.]+\s+(\d+) ms\/frame/g)].at(-1);
        if (frames) Object.assign(job, { n: Number(frames[1]), total: Number(frames[2]), ms: Number(frames[3]) });
        else if (!job.frames) job.n += (e.text.match(/\.jpg(\r?\n|$)/g) ?? []).length;
        out?.(e.text);
      } else if (e.type === 'end') {
        out?.('', true);
        out = null;
        // turned away before it started: why
        if (!job) say('out', e.tail.trim());
        const what = job?.what ?? '（没开始就被退回）';
        jobs.unshift({ id: e.id, what, started: job?.started ?? Date.now(), ms: e.ms, ok: e.ok, files: e.files, tail: e.tail, rate: job?.frames ? job.ms : null });
        jobs.length = Math.min(jobs.length, 20);
        if (today.day !== new Date().toDateString()) today = { day: new Date().toDateString(), done: 0, failed: 0 };
        today[e.ok ? 'done' : 'failed']++;
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

// ——— with Windows: a script in the Startup folder that starts the tray icon ———
const startup = win && process.env.APPDATA ? join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup/qiqi-render-station.vbs') : null;
function autostartOn() {
  return !!startup && existsSync(startup);
}
function setAutostart(on) {
  if (!startup) return;
  if (!on) return rmSync(startup, { force: true });
  const ps1 = join(here, 'station.ps1');
  const vbs = `' qiqi.help 渲染站：登录后在后台启动（渲染站的设置里可以关掉）\r\nCreateObject("WScript.Shell").Run "powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ""${ps1}""", 0, False\r\n`;
  // UTF-16 with its mark, so a path in any script reads right
  writeFileSync(startup, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));
}

// ——— as an app: 渲染站 on the desktop and in the Start menu, with the tray's icon ———
const NAME = '渲染站.lnk';
let folders = null;
const ps = (script, env = {}) =>
  new Promise((done) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`], { windowsHide: true, env: { ...process.env, ...env } }, (e, out) => done(e ? null : out)),
  );
if (win)
  ps("[Environment]::GetFolderPath('Desktop'); [Environment]::GetFolderPath('Programs')").then((out) => {
    const [Desktop, Programs] = (out ?? '').split(/\r?\n/).map((s) => s.trim());
    if (Desktop && Programs) folders = { Desktop, Programs };
    push();
  });
function shortcutOn() {
  return !!folders && existsSync(join(folders.Desktop, NAME));
}
async function setShortcut(on) {
  if (!folders) return;
  for (const where of [folders.Desktop, folders.Programs]) {
    const file = join(where, NAME);
    if (!on) rmSync(file, { force: true });
    else
      await ps('$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:Q_LNK); $s.TargetPath = $env:Q_TARGET; $s.Arguments = $env:Q_ARGS; $s.WorkingDirectory = $env:Q_DIR; $s.IconLocation = $env:Q_ICON; $s.Description = $env:Q_NOTE; $s.Save()', {
        Q_LNK: file,
        Q_TARGET: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe'),
        Q_ARGS: `"${join(here, 'station.vbs')}"`,
        Q_DIR: here,
        Q_ICON: `${join(dir, 'station.ico')},0`,
        Q_NOTE: 'qiqi.help 宣传片的渲染站',
      });
  }
}

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
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return res.writeHead(400).end();
  }
  if (req.method === 'GET') {
    if (path === '/') return send(res, join(here, 'station.html'));
    if (path === '/state') return json(res, view());
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
  let data;
  try {
    const text = await body(req);
    data = text ? JSON.parse(text) : {};
  } catch {
    return res.writeHead(400).end();
  }
  try {
    if (path === '/pause') {
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
      setAutostart(!!data.on);
      note('station', data.on ? '登录 Windows 后自动启动：开' : '登录 Windows 后自动启动：关');
    } else if (path === '/shortcut') {
      await setShortcut(!!data.on);
      note('station', data.on ? '桌面和开始菜单里放好了「渲染站」' : '桌面和开始菜单里的「渲染站」拿掉了');
    } else if (path === '/quit') {
      json(res, { ok: true });
      return quit();
    } else return res.writeHead(404).end();
  } catch (e) {
    note('station', `${path} 出错：${e.message}`);
    return res.writeHead(500).end();
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
  startWorker();
  connect();
});
