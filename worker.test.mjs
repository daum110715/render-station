import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { HEADER, PROTOCOL, serve } from './worker.mjs';
import { FILE, changeWorkspaces, commandOf, gather, globRe, resolveWorkspaces, safeRel } from './workspace.mjs';

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
    nap: {
      command: ['node', '{job}/tool/nap.mjs'],
      upload: ['tool/*.mjs'],
      collect: '{job}/out',
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
// when it ran: a little while, to be seen beside another or not
const NAP = `import { mkdirSync, writeFileSync } from 'node:fs';
const start = Date.now();
await new Promise((done) => setTimeout(done, 400));
mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
writeFileSync(new URL('../out/times.json', import.meta.url), JSON.stringify({ start, end: Date.now() }));
`;

function fixture({ manage = null } = {}) {
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
  const limits = { all: 2 };
  const server = serve({ port: 0, workspaces: () => resolveWorkspaces(settings), keep, jobs: join(base, 'jobs'), limit: () => limits.all, manage });
  const ready = new Promise((done) => server.once('listening', done));
  // the steps the worker told of, and the reply (fetch undoes the gzip itself)
  const post = async (payload) => {
    await ready;
    const res = await fetch(`http://127.0.0.1:${server.address().port}/job`, { method: 'POST', headers: { [HEADER]: String(PROTOCOL) }, body: gzipSync(JSON.stringify(payload)) });
    if (res.status !== 200) return { status: res.status, reply: null, events: [] };
    const events = (await res.text()).trim().split('\n').map((line) => JSON.parse(line));
    return { status: res.status, reply: events.at(-1).reply, events: events.slice(0, -1) };
  };
  const files = (rel = 'tool/make.mjs', text = MAKE) => ({ [rel]: Buffer.from(text).toString('base64') });
  return {
    base, workspace, src, settings, keep, limits, server, ready, post, files,
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
    assert.deepEqual(Object.keys(status.json.workspaces[0].presets), ['make', 'nap']);
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

test('jobs past the limit wait their turn, as do a workspace\'s past its parallel', async () => {
  const f = fixture();
  f.settings[0].env = { DEMO_NEED: 'given' };
  // two at once, the times each ran, the earlier first; and whether one waited
  const two = async () => {
    const replies = await Promise.all([0, 1].map(() => f.post({ type: 'preset', workspace: 'demo', preset: 'nap', args: [], files: f.files('tool/nap.mjs', NAP) })));
    for (const r of replies) assert.equal(r.reply.ok, true, r.reply.log);
    const times = replies.map((r) => JSON.parse(Buffer.from(r.reply.files['times.json'], 'base64'))).sort((a, b) => a.start - b.start);
    return { apart: times[1].start >= times[0].end, waited: replies.filter((r) => r.events.some((e) => e.event === 'queued')).length };
  };
  try {
    f.limits.all = 1;
    assert.deepEqual(await two(), { apart: true, waited: 1 });
    // room for two, but one workspace's presets one at a time
    f.limits.all = 2;
    assert.deepEqual(await two(), { apart: true, waited: 1 });
    writeFileSync(join(f.workspace, FILE), JSON.stringify({ ...SPEC, parallel: 2 }));
    assert.deepEqual(await two(), { apart: false, waited: 0 });
    // each job's folder is gone once it is over
    assert.deepEqual(readdirSync(join(f.base, 'jobs')), []);
  } finally { f.close(); }
});

test('a change to the workspaces is checked, and a workspace added takes an old station\'s settings', () => {
  const f = fixture();
  try {
    // a checkout a station from before workspaces ran from
    mkdirSync(join(f.workspace, '.tools/remote'), { recursive: true });
    writeFileSync(join(f.workspace, '.tools/remote/config.json'), JSON.stringify({ env: { DEMO_NEED: 'kept', OTHER: 'not asked for' } }));
    const added = changeWorkspaces([], { action: 'add', name: 'mine', path: f.workspace, env: { EXTRA: '1' } });
    assert.deepEqual(added.list, [{ name: 'mine', path: resolve(f.workspace), env: { EXTRA: '1', DEMO_NEED: 'kept' } }]);
    assert.deepEqual(added.imported, ['DEMO_NEED']);
    assert.deepEqual(added.presets, ['make', 'nap']);
    assert.throws(() => changeWorkspaces(added.list, { action: 'add', name: 'mine', path: f.workspace }), /already registered/);
    assert.throws(() => changeWorkspaces([], { action: 'add', name: 'x', path: join(f.base, 'gone') }), /folder not found/);
    assert.throws(() => changeWorkspaces([], { action: 'add', name: 'x', path: 'relative/path' }), /full path/);
    assert.throws(() => changeWorkspaces([], { action: 'add', name: 'a b', path: f.workspace }), /name/);
    const set = changeWorkspaces(added.list, { action: 'set', name: 'mine', env: { DEMO_NEED: 'new' }, unset: ['EXTRA'] });
    assert.deepEqual(set.list[0].env, { DEMO_NEED: 'new' });
    assert.equal(set.lines.length, 2);
    assert.deepEqual(added.list[0].env.EXTRA, '1');
    assert.throws(() => changeWorkspaces(set.list, { action: 'set', name: 'mine', env: { DEMO_NEED: 'new' } }), /nothing to change/);
    assert.deepEqual(changeWorkspaces(set.list, { action: 'remove', name: 'mine' }).list, []);
    assert.throws(() => changeWorkspaces([], { action: 'remove', name: 'mine' }), /no workspace "mine"/);
  } finally { f.close(); }
});

test('cli.mjs workspace hands a change over, as far as the station lets it', async () => {
  const asked = [];
  const manage = { mode: () => 'allow', change: async (input) => (asked.push(input), { action: input.action, workspace: { name: input.name, path: input.path, missing: [], presets: ['make'] }, imported: [] }) };
  const f = fixture({ manage });
  try {
    await f.ready;
    const cli = (args) =>
      new Promise((done) =>
        execFile(process.execPath, [join(repo, 'cli.mjs'), ...args], { env: { ...process.env, RENDER_STATION_PORT: String(f.server.address().port) } }, (e, stdout) => done({ code: e?.code ?? 0, json: JSON.parse(stdout) })),
      );
    const added = await cli(['workspace', 'add', 'mine', 'D:/sites/mine', '--env', 'A=1', '--env', 'B=x=y', '--json']);
    assert.equal(added.code, 0);
    assert.equal(added.json.ok, true);
    assert.deepEqual(asked[0], { action: 'add', name: 'mine', path: 'D:/sites/mine', env: { A: '1', B: 'x=y' } });
    const bad = await cli(['workspace', 'remove', '--json', 'mine', '--path', 'x']);
    assert.equal(bad.code, 2);
    manage.mode = () => 'off';
    const off = await cli(['workspace', 'remove', '--json', 'mine']);
    assert.equal(off.code, 1);
    assert.match(off.json.error, /does not let the server manage/);
  } finally { f.close(); }
});
