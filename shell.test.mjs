import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createShellGate, executeShell, shellRequest } from './shell.mjs';
import { HEADER, serve } from './worker.mjs';

const repo = resolve(import.meta.dirname);
const scratch = join(repo, '.tools/.scratch');
mkdirSync(scratch, { recursive: true });
const fixture = () => {
  const workspace = mkdtempSync(join(scratch, 'shell-test-'));
  const policy = { enabled: true, rules: [] };
  const events = [];
  let saved = 0;
  const gate = createShellGate({ workspaces: () => [{ name: 'test', path: workspace }], policy: () => policy, save: () => saved++, audit: (line) => events.push(line), reviewTimeout: 50 });
  return { workspace, policy, gate, events, get saved() { return saved; }, close() { gate.revoke(); rmSync(workspace, { recursive: true, force: true }); } };
};

test('auto confines the initial cwd, including symlink destinations', () => {
  const f = fixture();
  try {
    assert.throws(() => shellRequest({ command: 'pwd', cwd: '..' }, f.workspace), /inside the workspace/);
    symlinkSync(scratch, join(f.workspace, 'escape'), 'dir');
    assert.throws(() => shellRequest({ command: 'pwd', cwd: 'escape' }, f.workspace), /inside the workspace/);
    assert.throws(() => shellRequest({ command: 'pwd', timeout: 0 }, f.workspace), /timeout/);
  } finally { f.close(); }
});

test('one-time approval does not persist; remember only matches the exact command and directory', async () => {
  const f = fixture();
  try {
    let request = f.gate.authorize({ command: 'node --version' });
    f.gate.decide(f.gate.state().pending.id, 'once');
    assert.equal((await request).approval, 'manual');
    assert.equal(f.saved, 0);
    request = f.gate.authorize({ command: 'node --version' });
    f.gate.decide(f.gate.state().pending.id, 'remember');
    await request;
    assert.equal(f.saved, 1);
    assert.equal((await f.gate.authorize({ command: 'node --version' })).approval, 'allowlist');
    request = f.gate.authorize({ command: 'node --version; echo injected' });
    assert.ok(f.gate.state().pending);
    f.gate.decide(f.gate.state().pending.id, 'deny');
    await assert.rejects(request, /denied/);
    mkdirSync(join(f.workspace, 'sub'));
    request = f.gate.authorize({ command: 'node --version', cwd: 'sub' });
    f.gate.decide(f.gate.state().pending.id, 'deny');
    await assert.rejects(request, /denied/);
    f.gate.remove(0);
    assert.equal(f.policy.rules.length, 0);
    assert.throws(() => f.gate.decide('stale', 'once'), /expired/);
  } finally { f.close(); }
});

test('disabled, expired, revoked and disconnected requests do not receive execution approval', async () => {
  const f = fixture();
  try {
    f.policy.enabled = false;
    await assert.rejects(f.gate.authorize({ command: 'pwd' }), /disabled/);
    f.policy.enabled = true;
    await assert.rejects(f.gate.authorize({ command: 'pwd' }), /expired/);
    let request = f.gate.authorize({ command: 'pwd' });
    f.gate.revoke();
    await assert.rejects(request, /cancelled/);
    const controller = new AbortController();
    request = f.gate.authorize({ command: 'pwd' }, controller.signal);
    controller.abort();
    await assert.rejects(request, /cancelled/);
    assert.equal(f.gate.state().pending, null);
  } finally { f.close(); }
});

test('YOLO requires local administrator, permits outside cwd, and resets on revocation and recreation', async () => {
  const f = fixture();
  try {
    assert.throws(() => f.gate.setYolo(true), /administrator/);
    const gate = createShellGate({ workspaces: () => [{ name: 'test', path: f.workspace }], policy: () => f.policy, save() {}, admin: true });
    gate.setYolo(true);
    assert.equal((await gate.authorize({ command: 'pwd', cwd: '..' })).approval, 'yolo');
    gate.revoke();
    assert.equal(gate.state().mode, 'auto');
    assert.equal(createShellGate({ workspaces: () => [], policy: () => f.policy, save() {}, admin: true }).state().mode, 'auto');
    f.policy.enabled = false;
    assert.throws(() => gate.setYolo(true), /enabled/);
  } finally { f.close(); }
});

test('a request names a registered workspace, or gets the first; with none, auto refuses', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.gate.authorize({ command: 'pwd', workspace: 'other' }), /no workspace "other"/);
    const none = createShellGate({ workspaces: () => [], policy: () => f.policy, save() {} });
    await assert.rejects(none.authorize({ command: 'pwd' }), /no workspace registered/);
    f.policy.rules.push({ command: 'pwd', cwd: realpathSync(f.workspace) });
    assert.equal((await f.gate.authorize({ command: 'pwd', workspace: 'test' })).workspace, 'test');
  } finally { f.close(); }
});

test('execution returns output and exit status and kills a timed-out process tree', async () => {
  const f = fixture();
  try {
    const result = await executeShell({ command: 'echo shell-ok', cwd: f.workspace, timeout: 2 });
    assert.equal(result.ok, true);
    assert.match(result.log, /shell-ok/);
    if (process.platform !== 'win32') {
      assert.equal((await executeShell({ command: 'exit 7', cwd: f.workspace, timeout: 2 })).code, 7);
      const timed = await executeShell({ command: 'sleep 10', cwd: f.workspace, timeout: 1 });
      assert.equal(timed.ok, false);
      assert.match(timed.log, /timed out/);
    }
  } finally { f.close(); }
});

test('worker protocol runs an allowlisted shell, blocks while paused, and refuses unknown jobs', async () => {
  const f = fixture();
  let accepting = true;
  const events = [];
  const server = serve({ port: 0, workspaces: () => [{ name: 'test', path: f.workspace, env: {}, spec: { env: [], presets: {} } }], shell: f.gate, accepting: () => accepting, on: (e) => events.push(e) });
  await new Promise((done) => server.once('listening', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (payload) => {
    const res = await fetch(`${base}/job`, { method: 'POST', headers: { [HEADER]: '1' }, body: gzipSync(JSON.stringify(payload)) });
    const bytes = Buffer.from(await res.arrayBuffer());
    // fetch transparently decompresses gzip responses; ask.mjs uses node:http instead.
    return { status: res.status, reply: res.status === 200 ? JSON.parse(bytes.toString()) : null };
  };
  try {
    f.policy.rules.push({ command: 'echo protocol-ok', cwd: realpathSync(f.workspace) });
    const result = await post({ type: 'shell', command: 'echo protocol-ok' });
    assert.equal(result.reply.ok, true);
    assert.match(result.reply.log, /protocol-ok/);
    assert.equal(events.find((e) => e.type === 'start').kind, 'shell');
    accepting = false;
    assert.equal((await post({ type: 'shell', command: 'echo protocol-ok' })).status, 503);
    accepting = true;
    const old = await post({ type: 'render', files: {}, args: [] });
    assert.equal(old.reply.ok, false);
    assert.match(old.reply.log, /unknown job type/);
    const preset = await post({ type: 'preset', workspace: 'test', preset: 'nothing' });
    assert.equal(preset.reply.ok, false);
    assert.equal(preset.reply.code, null);
    assert.match(preset.reply.log, /no preset "nothing"/);
    assert.equal((await fetch(`${base}/hello`)).status, 403);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    f.close();
  }
});
