// 渲染站, the render station, on the machine that takes the server's heavy work: keeps the worker
// (worker.mjs) and the reverse SSH tunnel to the server up, through sleep, wake and lost networks,
// and shows both in a small window (station.html, at http://127.0.0.1:7799): what it is doing, what
// ssh and the jobs print as they print it, the jobs lately done and what they made, the settings.
// The tray icon, 渲染站.exe (exe/station.c), starts it and starts it again if it stops, and keeps
// what the settings ask of Windows (starting with it, the shortcuts), as /tray tells it. Its
// settings, the server and the workspaces, are in .tools/remote/config.json; what it did, in
// station.log.
// usage: node station.mjs
import { createServer } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS, WORKER, serve } from './worker.mjs';
import { createApprovals, createShellGate, isAdministrator } from './shell.mjs';
import { NAME, adopt, changeWorkspaces, fullPath, listFolder, missingEnv, resolveWorkspaces, samePath, within } from './workspace.mjs';
import { RELEASE, SERVER, applyRelease, clearOld, fetchRelease, newer, openRelease } from './update.mjs';

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
/** the jobs running, and those waiting their turn, by id */
const running = new Map();
const queued = new Map();
const jobs = [];
let today = { day: new Date().toDateString(), done: 0, failed: 0 };
let workerError = null;
let quitting = false;

// ——— what happened: kept in station.log, and shown in the window as it happens ———
const LOG = join(dir, 'station.log');
if (existsSync(LOG) && statSync(LOG).size > 1e6) rmSync(LOG);
const log = (line) => appendFileSync(LOG, `${new Date().toISOString()}  ${line}\n`);
process.on('uncaughtException', (e) => {
  log(`渲染站因错误退出：${e?.stack ?? e}`);
  process.exit(1);
});
/** the window's feed, the latest 600 lines: what the station says ('station', 'tunnel', 'job', 'shell')
 *  and what ssh and the jobs print ('ssh', 'out'), a job's lines with its id */
const feed = [];
let fresh = [];
let seq = 0;
function say(kind, text, job) {
  const item = { n: ++seq, t: Date.now(), kind, text, ...(job ? { job } : {}) };
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
let config = {
  // the server by its address, so no ssh config is needed (the key: the default one, or the agent's)
  ssh: { target: '', port: '' },
  // the folders jobs may work in, [{ name, path, env }] (workspace.mjs)
  workspaces: [],
  paused: false,
  shell: { enabled: false, rules: [] },
  // how many jobs may run at once
  parallel: 2,
  // what the server may do to the workspaces: 'off', 'ask' (each change waits for the owner's
  // approval in the window) or 'allow'
  manage: 'ask',
};
try {
  const saved = JSON.parse(readFileSync(CONFIG, 'utf8'));
  config = { ...config, ...saved, ssh: { ...config.ssh, ...saved.ssh } };
} catch {}
const save = () => writeFileSync(CONFIG, JSON.stringify(config, null, 2));
// settings from before workspaces, the checkout render.mjs ran in (PROMO_ROOT) and the rest of its
// environment, become one. Those of a station that ran from the checkout itself say no PROMO_ROOT:
// they stay, for the workspace registered at that checkout to start from (adopt)
if (config.env?.PROMO_ROOT) {
  const { PROMO_ROOT: path, ...env } = config.env;
  if (!config.workspaces.length) config.workspaces = [{ name: '', path, env: Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')) }];
  delete config.env;
  save();
}
config.shell = { enabled: false, rules: [], ...config.shell };
/** the workspaces, as jobs see them */
const workspaces = () => resolveWorkspaces(config.workspaces);
/** how many jobs may run at once */
const limit = () => (Number.isInteger(config.parallel) && config.parallel >= 1 && config.parallel <= 16 ? config.parallel : 2);
const manageMode = () => (['off', 'ask', 'allow'].includes(config.manage) ? config.manage : 'ask');
/** what the settings still lack: the server, and what each workspace's file asks for */
const lacking = () => [
  ...(config.ssh.target ? [] : ['服务器的 SSH 地址']),
  ...workspaces().flatMap((w) => missingEnv(w).map((k) => `工作区 ${w.name} 的「${w.spec.env.find((e) => e.key === k)?.label ?? k}」`)),
];
/** the workspaces as the window edits them, checked */
function checkWorkspaces(list) {
  if (!Array.isArray(list) || list.length > 32) throw new Error('工作区配置的格式无效');
  const out = list.map((w) => {
    const name = String(w?.name ?? '').trim();
    const path = String(w?.path ?? '').trim();
    if (name && !NAME.test(name)) throw new Error(`工作区名称只能包含字母、数字和「.」「_」「-」：${name}`);
    if (!path) throw new Error('每个工作区都必须填写路径');
    const env = {};
    for (const [k, v] of Object.entries(w?.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`无效的环境变量名：${k}`);
      if (String(v).trim() !== '') env[k] = String(v).trim();
    }
    return { name, path, env };
  });
  const names = resolveWorkspaces(out).map((w) => w.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new Error(`工作区名称重复：${twice}。请为其中一个指定其他名称`);
  return out;
}
const shellToken = randomBytes(32).toString('hex');
/** whether this runs as administrator, and whether 渲染站.exe is not to ask for it at each start
 *  (the overview page's switch, turned off: exe/station.c reads this file) */
const admin = isAdministrator();
const NO_ELEVATE = join(dir, 'no-elevate');
/** the request awaiting approval the tray icon told of last, and those told of while any wait
 *  (askChanged) */
let asking = null;
const told = new Set();
const shellGate = createShellGate({
  workspaces,
  policy: () => config.shell,
  save,
  admin,
  changed: () => (askChanged(), push()),
  audit: (text) => note('shell', text),
});

// ——— the server's changes to the workspaces and looks into this machine's folders (worker.mjs's
// /workspace and /browse, from cli.mjs workspace and ls): as config.manage lets them, each shown to
// the owner first unless it is 'allow' ———
const wsApprovals = createApprovals({ changed: () => (askChanged(), push(), idle()) });
const OFF = 'the owner does not let the server manage workspaces or look through folders: allow it in the local station settings';
/** a change the server asks, against the settings as they are (workspace.mjs) */
const planChange = (input) => changeWorkspaces(config.workspaces, input, config.env);
const CHANGE = { add: '添加工作区', set: '修改工作区', remove: '移除工作区' };
/** a change the server asks, made once the owner allows it (`waiting()` meanwhile): what the
 *  workspace is now */
async function serverChange(input, signal, waiting = () => {}) {
  const plan = planChange(input);
  const what = `${CHANGE[input.action]} ${input.name}`;
  if (manageMode() === 'ask') {
    waiting();
    note('station', `服务器请求${what}，等待本机审批`);
    const action = await wsApprovals.ask({ action: input.action, name: input.name, lines: plan.lines, presets: plan.presets }, signal);
    if (action !== 'allow') {
      note('station', `服务器的请求未获批准（${action === 'deny' ? '已拒绝' : '已超时或已取消'}）：${what}`);
      throw new Error(action === 'deny' ? 'the owner denied the change' : 'the change was not approved within 5 minutes, or was cancelled');
    }
  }
  if (manageMode() === 'off') throw new Error(OFF);
  // the settings may have changed meanwhile: made only if the change is still the one shown
  const now = planChange(input);
  if (JSON.stringify(now.lines) !== JSON.stringify(plan.lines)) throw new Error('the workspaces changed while the change awaited approval: send it again');
  if (now.create) {
    try {
      mkdirSync(now.create, { recursive: true });
    } catch (e) {
      throw new Error(`could not make the folder ${now.create}: ${e.message}`);
    }
  }
  config.workspaces = now.list;
  save();
  note('station', `${manageMode() === 'allow' ? '已按服务器的请求' : '已批准服务器的请求，'}${what}${now.lines.length ? `：${now.lines.join('；')}` : ''}`);
  const w = workspaces().find((x) => x.name === input.name);
  push();
  return {
    action: input.action,
    workspace: w ? { name: w.name, path: w.path, ...(w.spec.error ? { error: w.spec.error } : {}), missing: missingEnv(w), presets: Object.keys(w.spec.presets) } : null,
    imported: now.imported,
    created: now.create,
  };
}
/** a folder's own path, links followed (as it is, if it is not there) */
const real = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};
/** the folders the owner let the server look into, each with all under it, until when (path null:
 *  the drives, those alone) */
let opened = [];
const OPEN_FOR = 10 * 60 * 1000;
/** a folder the server asks to look into (`{ path }`, none: the drives), listed (workspace.mjs): at
 *  once if it lies in a registered workspace or one opened lately, else once the owner allows it
 *  (`waiting()` meanwhile) */
async function serverBrowse(input, signal, waiting = () => {}) {
  const path = input?.path == null || input.path === '' ? null : real(fullPath(input.path));
  const where = path ? `文件夹 ${path}` : '本机的磁盘列表';
  const now = Date.now();
  opened = opened.filter((o) => o.until > now);
  const inWorkspace = path && workspaces().some((w) => w.path && within(path, real(w.path)));
  const open = opened.some((o) => (o.path === null ? path === null : path && within(path, o.path)));
  if (manageMode() === 'ask' && !inWorkspace && !open) {
    waiting();
    note('station', `服务器请求查看${where}，等待本机审批`);
    const action = await wsApprovals.ask({ action: 'browse', path }, signal);
    if (action !== 'allow') {
      note('station', `服务器的请求未获批准（${action === 'deny' ? '已拒绝' : '已超时或已取消'}）：查看${where}`);
      throw new Error(action === 'deny' ? 'the owner denied it' : 'it was not approved within 5 minutes, or was cancelled');
    }
    if (manageMode() === 'off') throw new Error(OFF);
    opened.push({ path, until: Date.now() + OPEN_FOR });
  }
  const list = listFolder(path);
  if (!inWorkspace) note('station', `服务器查看了${where}`);
  return list;
}

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

// ——— keeping up to date. An installed copy (release.json here) follows the releases published on
// the update server (update.mjs); a checkout, its branch's new commits, fast-forward only, and only
// into a checkout with nothing of its own in it. Never while a job runs, waits its turn or awaits the
// owner's approval. When the station's code changed it starts again (exit 75: the tray icon starts
// it at once); when the tray icon's did, the tray icon starts itself again ———
const installed = existsSync(join(repo, RELEASE));
const STAGE = join(repo, '.tools/update');
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const git = (args) =>
  new Promise((done) =>
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd: repo, windowsHide: true, env: GIT_ENV, timeout: 120000 }, (e, out, err) =>
      done({ ok: !e, out: String(out ?? '').trim(), err: String(err || e?.message || '').trim().split(/\r?\n/).at(-1) }),
    ),
  );
let update = { state: 'idle', at: null, message: '' };
// the release, or the commit, this copy is at, for the settings page
let version = null;
async function readVersion() {
  if (installed) {
    try {
      const m = openRelease(readFileSync(join(repo, RELEASE), 'utf8'));
      version = { name: m.version, at: Date.parse(m.published), kind: 'release' };
    } catch {}
    return push();
  }
  const head = await git(['log', '-1', '--format=%h %ct']);
  if (!head.ok) return;
  const [commit, t] = head.out.split(' ');
  version = { name: commit, at: Number(t) * 1000, kind: 'git' };
  push();
}
let trayAgain = false;
let updateAfterJob = false;
/** after an update: the tray icon starts itself again if its program changed, else the station does
 *  if what changed is of its own */
function restartFor(changed, ours) {
  if (changed.some((f) => /^(渲染站\.exe|WebView2Loader\.dll)$/.test(f))) trayAgain = true;
  else if (changed.some(ours)) {
    note('station', '渲染站的代码已更新，即将重新启动');
    setTimeout(() => {
      stop();
      process.exit(75);
    }, 500);
  }
}
const busyNow = () => running.size || queued.size || shellGate.state().pending || wsApprovals.head();
/** once nothing is running or waiting: the update put off until then */
function idle() {
  if (!updateAfterJob || busyNow()) return;
  updateAfterJob = false;
  setTimeout(checkUpdate, 1000);
}
async function checkUpdate() {
  if (['checking', 'downloading'].includes(update.state)) return;
  const done = (state, message) => {
    update = { state, at: Date.now(), message };
    push();
  };
  update = { ...update, state: 'checking' };
  push();
  if (installed) return checkRelease(done);
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.ok) return done('error', '当前分支未设置上游分支，或本机未安装 Git');
  const fetched = await git(['fetch', '--quiet']);
  if (!fetched.ok) return done('error', `获取更新失败：${fetched.err}`);
  const behind = await git(['rev-list', '--count', `HEAD..${up.out}`]);
  if (behind.out === '0') return done('current', '已是最新版本');
  const ahead = await git(['rev-list', '--count', `${up.out}..HEAD`]);
  const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
  if (ahead.out !== '0' || dirty.out) return done('blocked', `有 ${behind.out} 个新提交，但仓库中存在${dirty.out ? '未提交的改动' : '未推送的提交'}，未自动更新`);
  if (busyNow()) {
    updateAfterJob = true;
    return done('waiting', '发现新版本，将在所有任务完成后更新');
  }
  const changed = (await git(['diff', '--name-only', 'HEAD', up.out])).out.split(/\r?\n/);
  const merged = await git(['merge', '--ff-only', '--quiet', up.out]);
  if (!merged.ok) return done('error', `更新失败：${merged.err}`);
  await readVersion();
  note('station', `已更新到最新版本（${behind.out} 个新提交）`);
  done('updated', `已更新（${behind.out} 个新提交）`);
  restartFor(changed, (f) => /^[\w.-]+\.mjs$/.test(f));
}
/** an installed copy: the release published on the update server, if it is newer, fetched and put in place */
async function checkRelease(done) {
  const server = config.updateServer || SERVER;
  const get = async (path) => {
    const res = await fetch(new URL(path, server), { signal: AbortSignal.timeout(path.endsWith('.json') ? 30000 : 600000) });
    if (!res.ok) throw new Error(`${path}：HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  let now;
  let next;
  let text;
  try {
    now = openRelease(readFileSync(join(repo, RELEASE), 'utf8'));
    // past any cache on the way: the server marks all it has as never changing
    text = (await get(`latest.json?t=${Date.now()}`)).toString('utf8');
    next = openRelease(text);
  } catch (e) {
    return done('error', `检查更新失败：${e.cause?.message ?? e.message}`);
  }
  if (!newer(next.version, now.version)) return done('current', '已是最新版本');
  if (busyNow()) {
    updateAfterJob = true;
    return done('waiting', `发现新版本 ${next.version}，将在所有任务完成后更新`);
  }
  try {
    await fetchRelease({
      root: repo,
      stage: STAGE,
      now,
      next,
      get,
      progress: (n, total) => {
        update = { ...update, state: 'downloading', message: `正在下载新版本 ${next.version}（${n}/${total} 个文件）` };
        push();
      },
    });
    // a job may have come in meanwhile: what was fetched stays staged
    if (busyNow()) {
      updateAfterJob = true;
      return done('waiting', `新版本 ${next.version} 已下载，将在所有任务完成后更新`);
    }
    const changed = applyRelease({ root: repo, stage: STAGE, now, next, text });
    await readVersion();
    note('station', `已更新到 ${next.version}（${changed.length} 个文件）`);
    done('updated', `已更新到 ${next.version}`);
    restartFor(changed, () => true);
  } catch (e) {
    done('error', `更新失败：${e.cause?.message ?? e.message}`);
  }
}

// ——— what the jobs made, kept here (KEEP): newest first, each with its files ———
const MEDIA = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' };
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
              .filter((f) => relative(d, f) !== 'job.json')
              // 9.5 before 10.45
              .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
              .map((f) => ({ url: MEDIA[extname(f)] ? `/files/${relative(KEEP, f).split(sep).map(encodeURIComponent).join('/')}` : null, path: f, name: relative(d, f).split(sep).join('/') }));
            // kept before presets: a render's arguments only
            const what = meta.preset ? label({ kind: 'preset', ...meta }) : meta.args ? `渲染 ${meta.args.join(' ')}` : name;
            return { name, at: meta.at ?? statSync(d).mtimeMs, ms: meta.ms ?? null, what, files };
          })
          .filter((g) => g.files.length);
  } catch {
    shelf = [];
  }
}

const view = () => ({
  tunnel,
  running: [...running.values()],
  queued: [...queued.values()],
  parallel: limit(),
  manage: { mode: manageMode(), pending: wsApprovals.head(), behind: wsApprovals.behind() },
  jobs,
  today: today.day === new Date().toDateString() ? today : { done: 0, failed: 0 },
  workerError,
  config,
  // as jobs see them, in the settings' order
  workspaces: workspaces().map((w) => ({
    name: w.name,
    error: w.spec.error ?? null,
    fields: w.spec.env,
    presets: Object.entries(w.spec.presets).map(([name, p]) => ({ name, description: p.description ?? '' })),
    missing: missingEnv(w),
  })),
  shell: shellGate.state(),
  elevate: { on: win && !existsSync(NO_ELEVATE), admin },
  missing: lacking(),
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
  // the window's look: 'plum' or 'cream'
  theme: config.theme === 'cream' ? 'cream' : 'plum',
  paths: { log: LOG },
  // the page, as it is on disk: a window showing an older one loads it again
  page: statSync(join(here, 'station.html')).mtimeMs,
});
// ——— what the tray icon tells of: the job that ended last, or a request newly awaiting the owner's
// approval, whichever is newer. It shows each new one as a notification, which opens the window
// when clicked: an approval dialog shows only there ———
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
function askChanged() {
  const heads = [wsApprovals.head(), shellGate.state().pending].filter(Boolean);
  if (!heads.length) return told.clear();
  const p = heads.find((h) => !told.has(h.id));
  if (!p) return;
  told.add(p.id);
  const what = p.action === 'browse' ? (p.path ? `查看文件夹 ${p.path}` : '查看本机的磁盘列表') : p.action ? `${CHANGE[p.action]} ${p.name}` : `执行 Shell 命令：${p.command}`;
  asking = { key: `ask:${p.id}`, at: Date.now(), title: '有请求待审批', text: `服务器请求${clip(what, 120)}。单击此处打开渲染站审批，请在 5 分钟内处理。` };
}
/** for the tray icon, a line each: the mode, its tip, the pause item, what to tell of (its key, its
 *  title and text), starting with Windows and the shortcuts (1 or 0), and whether to start itself
 *  again (1: it was updated) */
function trayView() {
  const mode = running.size ? 'busy' : tunnel.state === 'up' ? 'idle' : tunnel.state;
  const waiting = queued.size ? `，另有 ${queued.size} 个任务排队` : '';
  const busy = running.size === 1 ? `执行中：${running.values().next().value.what}${waiting}` : `正在执行 ${running.size} 个任务${waiting}`;
  const tip = { busy, idle: `空闲，已连接服务器（端口 ${tunnel.port}）`, connecting: '正在连接服务器', retry: '无法连接服务器，将自动重试', auth: '无法登录服务器，请打开渲染站查看', off: '已暂停接收任务', unset: '尚未配置服务器，请在设置中填写' }[mode] ?? mode;
  const last = jobs[0];
  const ended = last && {
    key: `${last.id}@${last.started}`,
    at: last.started + (last.ms ?? 0),
    ...(last.ok ? { title: '任务已完成', text: `${last.what}，耗时 ${took(last.ms)}，结果已返回服务器。` } : { title: '任务失败', text: `${last.what}。详细输出见渲染站的「动态」页。` }),
  };
  const tell = asking && (!ended || asking.at > ended.at) ? asking : ended;
  const v = view();
  return [mode, `渲染站 · ${tip}`, tunnel.state === 'off' ? '恢复接收任务' : '暂停接收任务', tell?.key ?? '', tell?.title ?? '', tell?.text ?? '', v.autostart ? '1' : '0', v.shortcut ? '1' : '0', trayAgain ? '1' : '0']
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
const label = (e) => (e.kind === 'shell' ? `Shell：${e.command}` : `${e.workspace}/${e.preset}${e.args?.length ? ` ${e.args.join(' ')}` : ''}`);
let worker = null;
function startWorker() {
  // each running job's output, line by line
  const outs = new Map();
  const server = serve({
    workspaces,
    limit,
    keep: KEEP,
    shell: shellGate,
    manage: { mode: manageMode, change: serverChange, browse: serverBrowse },
    accepting: () => !config.paused && !quitting,
    on: (e) => {
      if (e.type === 'queued') {
        queued.set(e.id, { id: e.id, kind: e.kind, what: label(e), at: Date.now() });
        note(e.kind === 'shell' ? 'shell' : 'job', `任务 #${e.id} 正在排队：${label(e)}`);
      } else if (e.type === 'start') {
        const isShell = e.kind === 'shell';
        const job = { id: e.id, kind: e.kind, what: label(e), started: Date.now(), n: 0, total: null, ms: null, frames: false };
        queued.delete(e.id);
        running.set(e.id, job);
        note(isShell ? 'shell' : 'job', `开始执行任务 #${e.id}：${job.what}`);
        say('out', isShell ? `> [${e.cwd}] ${e.command} (${e.approval})` : `> ${e.command.join(' ')}`, e.id);
        outs.set(e.id, liner((line) => say('out', line, e.id)));
      } else if (e.type === 'log' && running.has(e.id)) {
        // progress, as a job prints it: "frame n/total", and after it "T=…  ms ms/frame" (render.mjs)
        const frames = [...e.text.matchAll(/frame (\d+)\/(\d+)(?:\s+T=[\d.]+\s+(\d+) ms\/frame)?/g)].at(-1);
        if (frames) Object.assign(running.get(e.id), { n: Number(frames[1]), total: Number(frames[2]), ms: frames[3] ? Number(frames[3]) : null, frames: true });
        outs.get(e.id)?.(e.text);
      } else if (e.type === 'end') {
        const job = running.get(e.id);
        const waited = queued.get(e.id);
        running.delete(e.id);
        queued.delete(e.id);
        if (e.kind === 'shell') note('shell', `Shell 任务 #${e.id} 执行${e.ok ? '成功' : '失败'}，退出码：${e.code ?? '无'}`);
        outs.get(e.id)?.('', true);
        outs.delete(e.id);
        // turned away before it started: why
        if (!job) say('out', e.tail.trim(), e.id);
        const what = job?.what ?? waited?.what ?? '（未开始执行即被拒绝）';
        jobs.unshift({ id: e.id, what, started: job?.started ?? Date.now(), ms: e.ms, ok: e.ok, files: e.files, paths: e.paths, tail: e.tail, rate: job?.ms ?? null });
        jobs.length = Math.min(jobs.length, 20);
        if (today.day !== new Date().toDateString()) today = { day: new Date().toDateString(), done: 0, failed: 0 };
        today[e.ok ? 'done' : 'failed']++;
        restock();
        note('job', e.ok ? `任务 #${e.id} 已完成：${what}，耗时 ${took(e.ms)}${e.files.length ? `，${e.files.length} 个文件已返回服务器` : ''}` : `任务 #${e.id} 失败：${what}，耗时 ${took(e.ms)}`);
        idle();
      }
      push();
    },
  });
  worker = server;
  server.on('listening', () => {
    workerError = null;
    note('station', `任务服务已就绪，监听 127.0.0.1:${WORKER}`);
  });
  server.on('error', (e) => {
    workerError = e.code === 'EADDRINUSE' ? `端口 ${WORKER} 已被占用，可能另有一个 worker.mjs 正在运行` : e.message;
    note('station', `任务服务无法启动：${workerError}。10 秒后重试`);
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
  if (!config.ssh.target) {
    tunnel = { state: 'unset' };
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
  note('tunnel', `正在连接服务器：ssh ${config.ssh.target}${config.ssh.port ? ` -p ${config.ssh.port}` : ''}，服务器端端口 ${port}`);
  const p = spawn('ssh', args, { windowsHide: true });
  ssh = p;
  tunnel = { state: 'connecting', port };
  push();
  let err = '';
  const up = () => {
    if (ssh !== p || tunnel.state !== 'connecting') return;
    tunnel = { state: 'up', port, since: Date.now() };
    tries = 0;
    note('tunnel', `隧道已建立：服务器的 127.0.0.1:${port} 已连接到本机的任务服务`);
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
      return note('tunnel', `无法登录服务器：${said || '原因不明'}`);
    }
    // the port on the server still held by a connection that died: the next one, at once
    const held = /remote port forwarding failed/i.test(err);
    if (held) slot++;
    const wait = held ? 500 : Math.min(30000, 2000 * 2 ** Math.min(tries, 4));
    tries++;
    tunnel = { state: 'retry', retryAt: Date.now() + wait, wait, message: said };
    note('tunnel', held ? `服务器端端口 ${port} 仍被已断开的旧连接占用，改用下一个端口` : `隧道已断开${said ? `：${said}` : ''}。${Math.round(wait / 1000)} 秒后重新连接`);
    timer = setTimeout(connect, wait);
  };
  p.on('error', (e) => end(e.code === 'ENOENT' ? 'ENOENT: no ssh on this machine' : e.message));
  p.on('close', () => end());
}
function stop() {
  shellGate.revoke();
  wsApprovals.clear();
  opened = [];
  // those waiting their turn: turned away, if the station no longer takes jobs
  worker?.schedule();
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
    note('tunnel', '本机已从睡眠中唤醒，重新连接');
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
  log('渲染站已退出');
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
  if ((path.startsWith('/shell/') || path.startsWith('/manage') || path === '/elevate') && req.headers['x-shell-local'] !== shellToken) return res.writeHead(403).end();
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
      note('shell', `Shell 任务：${data.on ? '已开启（auto 模式）' : '已关闭'}`);
    } else if (path === '/shell/yolo') {
      shellGate.setYolo(data.on);
    } else if (path === '/shell/decide') {
      shellGate.decide(data.id, data.action);
    } else if (path === '/shell/remove') {
      shellGate.remove(data.index);
    } else if (path === '/manage') {
      if (!['off', 'ask', 'allow'].includes(data.mode)) throw new Error('mode must be off, ask or allow');
      config.manage = data.mode;
      save();
      if (data.mode !== 'ask') wsApprovals.clear();
      opened = [];
      note('station', `服务器管理工作区：${{ off: '已关闭', ask: '需要本机审批', allow: '无需审批' }[data.mode]}`);
    } else if (path === '/manage/decide') {
      if (!['allow', 'deny'].includes(data.action)) throw new Error('action must be allow or deny');
      wsApprovals.decide(data.id, data.action);
    } else if (path === '/elevate') {
      if (typeof data.on !== 'boolean') throw new Error('on must be boolean');
      if (data.on) rmSync(NO_ELEVATE, { force: true });
      else writeFileSync(NO_ELEVATE, '');
      note('station', data.on ? '打开渲染站时将申请管理员权限' : '打开渲染站时将不再申请管理员权限');
    } else if (path === '/parallel') {
      if (!Number.isInteger(data.n) || data.n < 1 || data.n > 16) throw new Error('同时运行的任务数须为 1 到 16 之间的整数');
      config.parallel = data.n;
      save();
      note('station', `同时运行的任务数：${data.n}`);
      worker?.schedule();
    } else if (path === '/pause') {
      config.paused = true;
      save();
      stop();
      note('station', '已暂停接收任务，隧道已关闭');
    } else if (path === '/resume') {
      config.paused = false;
      save();
      note('station', '已恢复接收任务');
      restart();
    } else if (path === '/reconnect') {
      note('tunnel', '手动重新连接');
      restart();
    } else if (path === '/config') {
      let reconnect = false;
      if (data.ssh) {
        const ssh = { target: String(data.ssh.target ?? '').trim(), port: String(data.ssh.port ?? '').trim() };
        if (ssh.port && !/^\d{1,5}$/.test(ssh.port)) throw new Error('端口必须是数字');
        // never an option of ssh's own
        if (/^-|\s/.test(ssh.target)) throw new Error('SSH 地址的格式应为「用户名@服务器」');
        reconnect = ssh.target !== config.ssh.target || ssh.port !== config.ssh.port;
        config.ssh = ssh;
      }
      if (data.workspaces) {
        const list = checkWorkspaces(data.workspaces);
        // one added here: its settings may start from a station's from before workspaces
        const known = new Set(config.workspaces.map((w) => samePath(w.path)));
        for (const w of list) {
          if (known.has(samePath(w.path))) continue;
          const taken = adopt(w, config.env);
          if (taken.length) note('station', `已从旧版渲染站的设置中导入工作区 ${resolveWorkspaces([w])[0].name} 的 ${taken.length} 项设置：${taken.join('、')}`);
        }
        config.workspaces = list;
      }
      save();
      note('station', '设置已保存');
      if (reconnect) restart();
    } else if (path === '/autostart') {
      config.autostart = !!data.on;
      save();
      note('station', data.on ? '登录 Windows 后自动启动：已开启' : '登录 Windows 后自动启动：已关闭');
    } else if (path === '/shortcut') {
      config.shortcut = !!data.on;
      save();
      note('station', data.on ? '已在桌面和开始菜单中创建「渲染站」快捷方式' : '已删除桌面和开始菜单中的「渲染站」快捷方式');
    } else if (path === '/theme') {
      if (!['plum', 'cream'].includes(data.name)) throw new Error('name must be plum or cream');
      config.theme = data.name;
      save();
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
    note('station', `请求 ${path} 失败：${e.message}`);
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
  note('station', `渲染站已启动${admin ? '（以管理员身份运行）' : ''}，窗口地址：http://127.0.0.1:${UI}`);
  if (installed) clearOld(STAGE);
  // the one job folder of versions before jobs ran side by side
  rmSync(join(dir, 'job'), { recursive: true, force: true });
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
