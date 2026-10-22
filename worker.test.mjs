import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HEADER, serve } from './worker.mjs';
import { FILE, commandOf, gather, globRe, resolveWorkspaces, safeRel } from './workspace.mjs';

const repo = resolve(import.meta.dirname);
const scratch = join(repo, '.tools/.scratch');
mkdirSync(scratch, { recursive: true });

// a workspace with one preset: a script the job brings writes what it was given into out/
const SPEC = {
  name: 'demo',
  env: [
    { key: 'DEMO_NEED', label: '要填的', required: true },
    { key: 'DEMO_FLAG', type: 'switch', default: '1' },
  ],
  presets: {
    make: {
      description: 'writes a file',
      command: ['node', '{job}/tool/make.mjs', '{args}'],
      upload: ['tool/*.mjs'],
      args: ['--n', '\\d+'],
      env: { DEMO_ROOT: '{workspace}' },
      collect: '{job}/out',
      exclude: ['*.tmp'],
    },
  },
};
const MAKE = `import { mkdirSync, writeFileSync } from 'node:fs';
const out = new URL('../out/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('result.txt', out), JSON.stringify({ args: process.argv.slice(2), need: process.env.DEMO_NEED, flag: process.env.DEMO_FLAG, root: process.env.DEMO_ROOT, cwd: process.cwd() }));
writeFileSync(new URL('skip.tmp', out), 'x');
console.log('made it');
`;

function fixture() {
  const base = mkdtempSync(join(scratch, 'worker-test-'));
  const workspace = join(base, 'workspace');
  const src = join(base, 'src');
  mkdirSync(workspace);
  mkdirSync(join(src, 'tool'), { recursive: true });
  writeFileSync(join(workspace, FILE), JSON.stringify(SPEC));
  writeFileSync(join(src, 'tool/make.mjs'), MAKE);
  writeFileSync(join(src, 'tool/notes.txt'), 'not brought');
  const settings = [{ name: '', path: workspace, env: {} }];
  const keep = join(base, 'keep');
  const server = serve({ port: 0, workspaces: () => resolveWorkspaces(settings), keep });
  const ready = new Promise((done) => server.once('listening', done));
  const post = async (payload) => {
    await ready;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/job`, { method: 'POST', headers: { [HEADER]: '1' }, body: gzipSync(JSON.stringify(payload)) });
    return { status: res.status, reply: res.status === 200 ? JSON.parse(Buffer.from(await res.arrayBuffer()).toString()) : null };
  };
  const files = (rel = 'tool/make.mjs') => ({ [rel]: Buffer.from(MAKE).toString('base64') });
  return {
    base, workspace, src, settings, keep, server, ready, post, files,
    async close() {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('globs, relative paths and preset arguments', () => {
  assert.ok(globRe('promo/lib/*').test('promo/lib/a.mjs'));
  assert.ok(!globRe('promo/lib/*').test('promo/lib/x/a.mjs'));
  assert.ok(globRe('promo/**').test('promo/lib/x/a.mjs'));
  assert.ok(!globRe('a.mjs').test('aXmjs'));
  for (const bad of ['', '/abs', '../up', 'a/../b', 'a//b', 'C:/x', 'a\\b', './a']) assert.equal(safeRel(bad), false, bad);
  assert.ok(safeRel('promo/render.mjs'));
  const preset = SPEC.presets.make;
  assert.deepEqual(commandOf(preset, ['--n', '3'], { job: '/j', workspace: '/w' }), ['node', '/j/tool/make.mjs', '--n', '3']);
  assert.throws(() => commandOf(preset, ['--n', '3; rm'], { job: '/j', workspace: '/w' }), /not taken/);
  assert.throws(() => commandOf({ command: ['x'] }, ['anything'], {}), /not taken/);
});

test('a workspace is named by its settings, else its file; its file is checked', () => {
  const f = fixture();
  try {
    const [w] = resolveWorkspaces(f.settings);
    assert.equal(w.name, 'demo');
    assert.equal(w.env.DEMO_FLAG, '1');
    assert.equal(resolveWorkspaces([{ name: 'mine', path: f.workspace }])[0].name, 'mine');
    writeFileSync(join(f.workspace, FILE), JSON.stringify({ presets: { bad: { command: [] } } }));
    assert.match(resolveWorkspaces(f.settings)[0].spec.error, /preset bad: command/);
    assert.match(resolveWorkspaces([{ path: join(f.base, 'gone') }])[0].spec.error, /not found/);
  } finally { f.close(); }
});

test('the server gathers what the upload globs name', () => {
  const f = fixture();
  try {
    assert.deepEqual(gather(f.src, ['tool/*.mjs']), ['tool/make.mjs']);
    assert.deepEqual(gather(f.src, ['tool/**', 'missing/*']), ['tool/make.mjs', 'tool/notes.txt']);
  } finally { f.close(); }
});

test('a preset runs once its workspace is set up, and brings back what it made', async () => {
  const f = fixture();
  try {
    const lacking = await f.post({ type: 'preset', workspace: 'demo', preset: 'make', args: [], files: f.files() });
    assert.equal(lacking.reply.ok, false);
    assert.match(lacking.reply.log, /not set up here yet: DEMO_NEED/);
    f.settings[0].env = { DEMO_NEED: 'given' };
    const { reply } = await f.post({ type: 'preset', workspace: 'demo', preset: 'make', args: ['--n', '3'], files: f.files() });
    assert.equal(reply.ok, true, reply.log);
    assert.equal(reply.code, 0);
    assert.match(reply.log, /made it/);
    assert.deepEqual(Object.keys(reply.files), ['result.txt']);
    const result = JSON.parse(Buffer.from(reply.files['result.txt'], 'base64'));
    assert.deepEqual(result.args, ['--n', '3']);
    assert.equal(result.need, 'given');
    assert.equal(result.flag, '1');
    assert.equal(result.root, f.workspace);
    assert.equal(resolve(result.cwd), resolve(f.workspace));
    const [kept] = readdirSync(f.keep);
    assert.equal(JSON.parse(readFileSync(join(f.keep, kept, 'job.json'))).preset, 'make');
  } finally { f.close(); }
});

test('a preset refuses files and arguments it does not take', async () => {
  const f = fixture();
  f.settings[0].env = { DEMO_NEED: 'given' };
  try {
    for (const [payload, why] of [
      [{ files: f.files('tool/other.txt') }, /not taken by the preset: tool\/other.txt/],
      [{ files: f.files('../tool/make.mjs') }, /not taken by the preset/],
      [{ files: f.files(), args: ['--out', 'x'] }, /argument not taken/],
    ]) {
      const { reply } = await f.post({ type: 'preset', workspace: 'demo', preset: 'make', args: [], ...payload });
      assert.equal(reply.ok, false);
      assert.equal(reply.code, null);
      assert.match(reply.log, why);
    }
  } finally { f.close(); }
});

test('cli.mjs run --json hands a preset over and writes back what it made', async () => {
  const f = fixture();
  f.settings[0].env = { DEMO_NEED: 'given' };
  try {
    await f.ready;
    const out = join(f.base, 'results');
    const run = (args) =>
      new Promise((done) =>
        execFile(process.execPath, [join(repo, 'cli.mjs'), ...args], { env: { ...process.env, RENDER_STATION_PORT: String(f.server.address().port) } }, (e, stdout) => done({ code: e?.code ?? 0, json: JSON.parse(stdout) })),
      );
    const status = await run(['status', '--json']);
    assert.equal(status.code, 0);
    assert.deepEqual(Object.keys(status.json.workspaces[0].presets), ['make']);
    const ran = await run(['run', '--json', '--src', f.src, '--out', out, 'demo/make', '--n', '4']);
    assert.equal(ran.code, 0, ran.json.log);
    assert.equal(ran.json.ok, true);
    assert.deepEqual(ran.json.files, [join(out, 'result.txt')]);
    assert.ok(existsSync(join(out, 'result.txt')));
    const refused = await run(['run', '--json', '--src', f.src, 'demo/make', '--bad']);
    assert.equal(refused.code, 1);
    assert.equal(refused.json.exitCode, null);
    assert.match(refused.json.error, /argument not taken/);
    const unknown = await run(['run', '--json', 'demo/none']);
    assert.equal(unknown.code, 1);
    assert.match(unknown.json.error, /no preset "none"/);
  } finally { f.close(); }
});
