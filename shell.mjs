// Local-owner approvals for remote shell jobs. This is an authorization gate, not an OS sandbox.
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
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

export function createShellGate({ workspace, policy, save, admin = false, changed = () => {}, audit = () => {}, reviewTimeout = 300000 }) {
  let yolo = false;
  let pending = null;
  let settle = null;
  const state = () => ({ mode: !policy().enabled ? 'disabled' : yolo ? 'yolo' : 'auto', admin, workspace, pending, rules: policy().rules ?? [] });
  const revoke = () => { yolo = false; settle?.(false); changed(); };
  return {
    state,
    revoke,
    setYolo(on) {
      if (typeof on !== 'boolean') throw new Error('on must be boolean');
      if (on && (!admin || !policy().enabled)) throw new Error('YOLO requires an elevated administrator station and shell enabled');
      yolo = on;
      audit(`Shell 模式：${on ? 'YOLO（管理员本次会话）' : 'auto'}`);
      changed();
    },
    remove(index) {
      if (!Number.isInteger(index) || index < 0 || index >= (policy().rules ?? []).length) throw new Error('rule no longer exists');
      const [rule] = policy().rules.splice(index, 1);
      save();
      audit(`移除 Shell 白名单：${JSON.stringify(rule)}`);
      changed();
    },
    decide(id, action) {
      if (!pending || pending.id !== id || !['once', 'remember', 'deny'].includes(action)) throw new Error('approval expired or invalid');
      if (action === 'remember') {
        policy().rules ??= [];
        if (!policy().rules.some((r) => matchesRule(r, pending))) policy().rules.push({ command: pending.command, cwd: pending.cwd });
        save();
      }
      audit(`Shell 本地审批 ${action}：${JSON.stringify(pending)}`);
      settle(action !== 'deny');
    },
    async authorize(input, signal) {
      if (!policy().enabled) throw new Error('Shell is disabled; enable it in the local station settings');
      if (signal?.aborted) throw new Error('request disconnected');
      const request = shellRequest(input, workspace, yolo);
      let approval = yolo ? 'yolo' : (policy().rules ?? []).some((r) => matchesRule(r, request)) ? 'allowlist' : null;
      if (!approval) {
        if (pending) throw new Error('another shell approval is pending');
        const allowed = await new Promise((done) => {
          pending = { ...request, id: randomUUID(), at: Date.now() };
          const timer = setTimeout(() => settle(false), reviewTimeout);
          const aborted = () => settle?.(false);
          settle = (ok) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', aborted);
            pending = null;
            settle = null;
            changed();
            done(ok);
          };
          signal?.addEventListener('abort', aborted, { once: true });
          audit(`Shell 等待本地审批：${JSON.stringify(pending)}`);
          changed();
        });
        if (!allowed) throw new Error('Shell approval denied, expired or cancelled');
        approval = 'manual';
      }
      if (!policy().enabled || signal?.aborted || (approval === 'yolo' && !yolo)) throw new Error('Shell authorization revoked');
      // Resolve again: a symlink may have changed while awaiting the owner's decision.
      const checked = shellRequest(input, workspace, approval === 'yolo');
      if (checked.cwd !== request.cwd) throw new Error('working directory changed during approval');
      audit(`Shell 执行（${approval}）：${JSON.stringify(checked)}`);
      return { ...checked, approval };
    },
  };
}

export function executeShell(request, { env = {}, signal, output = () => {} } = {}) {
  return new Promise((done) => {
    const win = process.platform === 'win32';
    const child = spawn(win ? 'powershell.exe' : '/bin/sh', win
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(request.command, 'utf16le').toString('base64')]
      : ['-c', request.command], { cwd: request.cwd, env: { ...process.env, ...env }, windowsHide: true, detached: !win, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let stopped = false;
    let finished = false;
    const append = (text) => { log = (log + text).slice(-262144); output(String(text)); };
    const kill = () => {
      if (stopped || finished) return;
      stopped = true;
      append('\nShell cancelled or timed out\n');
      if (!child.pid) return;
      if (win) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(kill, request.timeout * 1000);
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
      done({ ok: code === 0 && !stopped, code, log, files: {} });
    };
    child.on('error', (e) => { append(`${e.message}\n`); end(1); });
    child.on('close', end);
  });
}
