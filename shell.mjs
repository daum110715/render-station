// Local-owner approvals for remote shell jobs (and the queue of requests awaiting the owner, which
// the station's workspace changes use too). This is an authorization gate, not an OS sandbox.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

export function isAdministrator() {
  if (process.platform !== 'win32') return process.getuid?.() === 0;
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { windowsHide: true, timeout: 5000, encoding: 'utf8' }).trim() === 'True';
  } catch { return false; }
}

export function shellRequest(input, workspace, unrestricted = false) {
  if (!input || typeof input.command !== 'string' || !input.command.trim() || input.command.length > 32768 || input.command.includes('\0')) throw new Error('shell command must be nonempty text (max 32768 characters)');
  if (input.cwd != null && typeof input.cwd !== 'string') throw new Error('cwd must be a path');
  if (!workspace) throw new Error('no workspace registered on this machine: add one in the local station settings');
  const root = realpathSync(workspace);
  const cwd = realpathSync(resolve(root, input.cwd ?? '.'));
  const rel = relative(root, cwd);
  if (!unrestricted && (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel))) throw new Error('auto mode: cwd must be inside the workspace');
  if (!statSync(cwd).isDirectory()) throw new Error('cwd must be a directory');
  const timeout = input.timeout ?? 600;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 7200) throw new Error('timeout must be 1–7200 seconds');
  return { command: input.command, cwd, timeout };
}

export const matchesRule = (rule, request) => rule?.command === request.command && rule?.cwd === request.cwd;

/** requests awaiting the owner's decision, shown one at a time in the order they came: `ask(item,
 *  signal)` settles with the owner's action, or null once `timeout` ms pass, the request disconnects
 *  or `clear()` cancels all; past `max` waiting, a request is refused at once */
export function createApprovals({ timeout = 300000, max = 8, changed = () => {} } = {}) {
  const waiting = [];
  const settle = (entry, action) => {
    const i = waiting.indexOf(entry);
    if (i < 0) return;
    waiting.splice(i, 1);
    entry.end(action);
    changed();
  };
  const shown = ({ end, ...item }) => item;
  return {
    /** the one shown now, and how many wait behind it */
    head: () => (waiting[0] ? shown(waiting[0]) : null),
    behind: () => Math.max(0, waiting.length - 1),
    find: (id) => {
      const entry = waiting.find((e) => e.id === id);
      return entry ? shown(entry) : null;
    },
    ask(item, signal) {
      if (waiting.length >= max) throw new Error(`${max} requests already await the owner's approval`);
      return new Promise((done) => {
        const entry = { ...item, id: randomUUID(), at: Date.now() };
        const timer = setTimeout(() => settle(entry, null), timeout);
        const aborted = () => settle(entry, null);
        entry.end = (action) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', aborted);
          done(action);
        };
        signal?.addEventListener('abort', aborted, { once: true });
        waiting.push(entry);
        changed();
      });
    },
    decide(id, action) {
      const entry = waiting.find((e) => e.id === id);
      if (!entry) throw new Error('approval expired or invalid');
      settle(entry, action);
    },
    clear: () => [...waiting].forEach((e) => settle(e, null)),
  };
}

/** the gate for Shell jobs: `workspaces()`, the registered ones ([{ name, path }]); a job names one,
 *  or gets the first (in YOLO, with none registered, the home folder) */
export function createShellGate({ workspaces, policy, save, admin = false, changed = () => {}, audit = () => {}, reviewTimeout = 300000 }) {
  let yolo = false;
  const approvals = createApprovals({ timeout: reviewTimeout, changed });
  const state = () => ({ mode: !policy().enabled ? 'disabled' : yolo ? 'yolo' : 'auto', admin, workspaces: workspaces().map((w) => w.name), pending: approvals.head(), behind: approvals.behind(), rules: policy().rules ?? [] });
  function rootOf(name) {
    if (name != null && typeof name !== 'string') throw new Error('workspace must be a name');
    const list = workspaces();
    const w = name ? list.find((x) => x.name === name) : list[0];
    if (name && !w) throw new Error(`no workspace "${name}" on this machine`);
    return w ? { name: w.name, path: w.path } : { name: null, path: yolo ? homedir() : null };
  }
  const revoke = () => { yolo = false; approvals.clear(); changed(); };
  return {
    state,
    revoke,
    setYolo(on) {
      if (typeof on !== 'boolean') throw new Error('on must be boolean');
      if (on && (!admin || !policy().enabled)) throw new Error('YOLO requires an elevated administrator station and shell enabled');
      yolo = on;
      audit(`Shell 模式：${on ? 'YOLO（仅限本次会话，管理员权限）' : 'auto'}`);
      changed();
    },
    remove(index) {
      if (!Number.isInteger(index) || index < 0 || index >= (policy().rules ?? []).length) throw new Error('rule no longer exists');
      const [rule] = policy().rules.splice(index, 1);
      save();
      audit(`已从 Shell 白名单中移除：${JSON.stringify(rule)}`);
      changed();
    },
    decide(id, action) {
      const pending = approvals.find(id);
      if (!pending || !['once', 'remember', 'deny'].includes(action)) throw new Error('approval expired or invalid');
      if (action === 'remember') {
        policy().rules ??= [];
        if (!policy().rules.some((r) => matchesRule(r, pending))) policy().rules.push({ command: pending.command, cwd: pending.cwd });
        save();
      }
      audit(`Shell 审批结果（${{ once: '仅本次允许', remember: '允许并加入白名单', deny: '拒绝' }[action]}）：${JSON.stringify(pending)}`);
      approvals.decide(id, action);
    },
    /** a Shell job's request, allowed (`waiting()` once it waits for the owner's decision) */
    async authorize(input, signal, waiting = () => {}) {
      if (!policy().enabled) throw new Error('Shell is disabled; enable it in the local station settings');
      if (signal?.aborted) throw new Error('request disconnected');
      const root = rootOf(input.workspace);
      const request = { ...shellRequest(input, root.path, yolo), workspace: root.name };
      let approval = yolo ? 'yolo' : (policy().rules ?? []).some((r) => matchesRule(r, request)) ? 'allowlist' : null;
      if (!approval) {
        waiting();
        audit(`Shell 请求等待审批：${JSON.stringify(request)}`);
        const action = await approvals.ask(request, signal);
        if (!action || action === 'deny') throw new Error('Shell approval denied, expired or cancelled');
        approval = 'manual';
      }
      if (!policy().enabled || signal?.aborted || (approval === 'yolo' && !yolo)) throw new Error('Shell authorization revoked');
      // Resolve again: a symlink, or the workspace itself, may have changed while awaiting the owner's decision.
      const checked = { ...shellRequest(input, rootOf(input.workspace).path, approval === 'yolo'), workspace: root.name };
      if (checked.cwd !== request.cwd) throw new Error('working directory changed during approval');
      audit(`执行 Shell 命令（${{ allowlist: '白名单', manual: '人工批准', yolo: 'YOLO' }[approval]}）：${JSON.stringify(checked)}`);
      return { ...checked, approval };
    },
  };
}

/** a process (no shell between), its output passed on as it comes and the last 256 KiB kept; it and
 *  all it started are ended when `timeout` seconds pass (0: never) or `signal` aborts */
export function runProcess({ file, args = [], cwd, env = {}, timeout = 0, signal, output = () => {} }) {
  return new Promise((done) => {
    const win = process.platform === 'win32';
    let log = '';
    let stopped = false;
    let finished = false;
    const append = (text) => { log = (log + text).slice(-262144); output(String(text)); };
    let child;
    try {
      child = spawn(file, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      append(`${e.message}\n`);
      return done({ ok: false, code: null, log });
    }
    const kill = () => {
      if (stopped || finished) return;
      stopped = true;
      append('\nProcess cancelled or timed out\n');
      if (!child.pid) return;
      if (win) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = timeout ? setTimeout(kill, timeout * 1000) : null;
    signal?.addEventListener('abort', kill, { once: true });
    if (signal?.aborted) kill();
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', append);
    }
    const end = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      done({ ok: code === 0 && !stopped, code, log });
    };
    child.on('error', (e) => { append(`${e.message}\n`); end(null); });
    child.on('close', end);
  });
}

export async function executeShell(request, { env = {}, signal, output = () => {} } = {}) {
  const win = process.platform === 'win32';
  const reply = await runProcess({
    file: win ? 'powershell.exe' : '/bin/sh',
    args: win ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(request.command, 'utf16le').toString('base64')] : ['-c', request.command],
    cwd: request.cwd,
    env,
    timeout: request.timeout,
    signal,
    output,
  });
  return { ...reply, files: {} };
}
