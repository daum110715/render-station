// 渲染站, the render station, on the owner's machine: keeps the render worker (worker.mjs) and the
// reverse SSH tunnel to lemon up, through sleep, wake and lost networks, and shows both in a small
// window (station.html, at http://127.0.0.1:7799). The tray icon (station.ps1; station.cmd to
// double-click) starts it and starts it again if it stops. Its settings, the paths render.mjs
// needs and how to reach lemon, are in .tools/remote/config.json; what it did, in station.log.
// usage: node promo/remote/station.mjs
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
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

// ——— a log, kept short ———
const LOG = join(dir, 'station.log');
if (existsSync(LOG) && statSync(LOG).size > 1e6) rmSync(LOG);
const log = (line) => appendFileSync(LOG, `${new Date().toISOString()}  ${line}\n`);
process.on('uncaughtException', (e) => {
  log(`crashed: ${e?.stack ?? e}`);
  process.exit(1);
});

// ——— settings ———
const CONFIG = join(dir, 'config.json');
const KEYS = ['PROMO_WORK', 'PROMO_SITE', 'PROMO_CHROME', 'PROMO_FFMPEG', 'PROMO_PROFILES', 'PROMO_GPU'];
// lemon by its address, so no ssh config is needed (the key: the owner's default one, or the agent's)
const LEMON = { target: 'lemon@23.251.32.150', port: '22222' };
// what render.mjs cannot do without here (on Windows its defaults are lemon's)
const NEEDED = process.platform === 'win32' ? ['PROMO_WORK', 'PROMO_CHROME', 'PROMO_FFMPEG'] : ['PROMO_WORK'];
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

// ——— the window, told of every change ———
const clients = new Set();
let pending = null;
let tunnel = { state: 'off' };
let job = null;
const jobs = [];
let workerError = null;
let quitting = false;
const view = () => ({
  tunnel,
  job,
  jobs,
  workerError,
  config,
  missing: NEEDED.filter((k) => !config.env[k]),
  autostart: autostartOn(),
  platform: process.platform,
});
function push() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const data = `data: ${JSON.stringify(view())}\n\n`;
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
  const server = serve({
    env: () => Object.fromEntries(Object.entries(config.env).filter(([, v]) => v !== '')),
    on: (e) => {
      if (e.type === 'start') {
        const n = e.args.includes('--stills') ? e.args[e.args.indexOf('--stills') + 1].split(',').length : e.args.includes('--cover') ? 2 : null;
        job = { id: e.id, what: describe(e.args), started: Date.now(), n: 0, total: n, ms: null, frames: n == null };
        log(`job ${e.id}: ${job.what}`);
      } else if (e.type === 'log' && job) {
        // render.mjs: "frame n/total  T=…  ms ms/frame" every 30 frames; a path a still or a cover
        const frames = [...e.text.matchAll(/frame (\d+)\/(\d+)\s+T=[\d.]+\s+(\d+) ms\/frame/g)].at(-1);
        if (frames) Object.assign(job, { n: Number(frames[1]), total: Number(frames[2]), ms: Number(frames[3]) });
        else if (!job.frames) job.n += (e.text.match(/\.jpg(\r?\n|$)/g) ?? []).length;
      } else if (e.type === 'end') {
        jobs.unshift({ id: e.id, what: job?.what ?? '（没开始就被退回）', started: job?.started ?? Date.now(), ms: e.ms, ok: e.ok, files: e.files, tail: e.tail });
        jobs.length = Math.min(jobs.length, 20);
        log(`job ${e.id}: ${e.ok ? 'done' : 'failed'} in ${(e.ms / 1000).toFixed(1)} s`);
        job = null;
      }
      push();
    },
  });
  server.on('listening', () => {
    workerError = null;
    push();
  });
  server.on('error', (e) => {
    workerError = e.code === 'EADDRINUSE' ? `${WORKER} 端口被占用了：是不是另开了一个 worker.mjs？` : e.message;
    log(`worker: ${e.message}`);
    push();
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
  const p = spawn('ssh', args, { windowsHide: true });
  ssh = p;
  tunnel = { state: 'connecting', port };
  push();
  let err = '';
  const up = () => {
    if (ssh !== p || tunnel.state !== 'connecting') return;
    tunnel = { state: 'up', port, since: Date.now() };
    tries = 0;
    log(`tunnel up on lemon:${port}`);
    push();
  };
  // ssh -v says so; or, failing that, still there after a while with nothing refused
  const still = setTimeout(up, 10000);
  p.stderr.on('data', (d) => {
    err = (err + d).slice(-6000);
    if (/remote forward success|forwarding_success/i.test(String(d))) up();
  });
  let ended = false;
  const end = (why) => {
    if (ended) return;
    ended = true;
    clearTimeout(still);
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
    log(`tunnel down: ${said || 'closed'}`);
    // nothing to be done by trying again: the key, the host's key, no ssh at all
    if (/Permission denied|Host key verification failed|Could not resolve hostname|ENOENT/i.test(err)) {
      tunnel = { state: 'auth', message: said };
      return push();
    }
    // the port on lemon still held by a connection that died: the next one, at once
    const held = /remote port forwarding failed/i.test(err);
    if (held) slot++;
    const wait = held ? 500 : Math.min(30000, 2000 * 2 ** Math.min(tries, 4));
    tries++;
    tunnel = { state: 'retry', retryAt: Date.now() + wait, message: said };
    push();
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
    log('awake again');
    restart();
  }
  tick = now;
}, 5000);

// ——— starting with Windows: a script in the Startup folder that starts the tray icon ———
const startup = process.platform === 'win32' && process.env.APPDATA ? join(process.env.APPDATA, 'Microsoft/Windows/Start Menu/Programs/Startup/qiqi-render-station.vbs') : null;
function autostartOn() {
  return !!startup && existsSync(startup);
}
function setAutostart(on) {
  if (!startup) return;
  if (!on) return rmSync(startup, { force: true });
  const ps1 = join(here, 'station.ps1');
  const vbs = `' qiqi.help 渲染站：登录后在后台启动（渲染站的设置里可以关掉）\r\nCreateObject("WScript.Shell").Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""${ps1}""", 0, False\r\n`;
  // UTF-16 with its mark, so a path in any script reads right
  writeFileSync(startup, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));
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
  log('quit');
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
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify(view())}\n\n`);
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
      log('paused');
    } else if (path === '/resume') {
      config.paused = false;
      save();
      restart();
      log('resumed');
    } else if (path === '/reconnect') restart();
    else if (path === '/config') {
      for (const k of KEYS) if (typeof data.env?.[k] === 'string') config.env[k] = data.env[k].trim();
      if (data.ssh) config.ssh = { target: String(data.ssh.target ?? '').trim() || LEMON.target, port: String(data.ssh.port ?? '').trim() };
      save();
      restart();
      log('settings saved');
    } else if (path === '/autostart') setAutostart(!!data.on);
    else if (path === '/quit') {
      json(res, { ok: true });
      return quit();
    } else return res.writeHead(404).end();
  } catch (e) {
    log(`${path}: ${e.message}`);
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
  log(`station on 127.0.0.1:${UI}`);
  startWorker();
  connect();
});
