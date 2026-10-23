// Workspaces: the folders on this machine that jobs may work in, each registered in the station's
// settings with its path and the environment its jobs get. A workspace may carry a
// render-station.json at its root, which says what it needs and what it offers:
//   env      the environment its jobs read, shown as fields in the settings
//            ([{ key, label, required: true | '<platform>', placeholder, hint, type: 'switch', default }])
//   presets  the jobs the server may run in it without asking each time
//            ({ <name>: { description, command, cwd, env, upload, args, collect, exclude, timeout } })
//   parallel how many of its preset jobs may run at once (1 unless it says more: jobs of one
//            workspace may well use the same files)
// A preset's command is an argument list (no shell): '{args}' stands for the job's arguments, each of
// which must match one of `args` (regular expressions, whole), and '{job}' and '{workspace}' in any
// part, in cwd, env and collect, for the job's folder and the workspace's. `upload`: the files a job
// may bring (globs from the workspace's root on the server: '*' within a folder, '**' across them),
// set up in the job's folder; `collect`: the folder whose files go back once the command succeeds,
// but not those `exclude` names (a glob with no '/' in it names a file in any folder). Registering a
// workspace trusts its presets: what a job brings and runs has the account's rights.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const FILE = 'render-station.json';
/** what a workspace and a preset may be called */
export const NAME = /^[\w.-]{1,64}$/;
const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** a glob as a regular expression: '*' and '?' within a folder, '**' across folders */
export function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
/** a relative path with '/' between its parts, none of them empty, '.' or '..', and nothing a
 *  Windows path could read otherwise (a drive, a stream, a backslash) */
export const safeRel = (p) => typeof p === 'string' && p.length > 0 && p.length < 1024 && !/[\\:\0*?"<>|]/.test(p) && p.split('/').every((s) => s && s !== '.' && s !== '..');
/** '{job}' and '{workspace}' in `text`, filled in */
export const fill = (text, vars) => text.replace(/\{(job|workspace)\}/g, (_, k) => vars[k]);
const excluded = (globs, rel) => globs.some((g) => globRe(g).test(g.includes('/') ? rel : rel.split('/').pop()));

/** every file under dir */
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');
function check(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('not an object');
  if (spec.name != null && !(typeof spec.name === 'string' && NAME.test(spec.name))) throw new Error('name: letters, digits, ".", "_" and "-" only');
  if (spec.parallel != null && !(Number.isInteger(spec.parallel) && spec.parallel >= 1 && spec.parallel <= 16)) throw new Error('parallel: 1–16');
  const env = spec.env ?? [];
  if (!Array.isArray(env)) throw new Error('env: a list');
  for (const e of env) {
    if (!e || !KEY.test(e.key ?? '')) throw new Error(`env: a key that is not a variable's name: ${JSON.stringify(e?.key)}`);
    for (const k of ['label', 'placeholder', 'hint', 'default']) if (e[k] != null && typeof e[k] !== 'string') throw new Error(`env ${e.key}: ${k} is not text`);
    if (e.type != null && !['text', 'switch'].includes(e.type)) throw new Error(`env ${e.key}: type is "text" or "switch"`);
    if (e.required != null && e.required !== true && e.required !== false && typeof e.required !== 'string') throw new Error(`env ${e.key}: required is true or a platform`);
  }
  const presets = spec.presets ?? {};
  if (typeof presets !== 'object' || Array.isArray(presets)) throw new Error('presets: an object');
  for (const [name, p] of Object.entries(presets)) {
    const bad = (why) => new Error(`preset ${name}: ${why}`);
    if (!NAME.test(name)) throw bad('letters, digits, ".", "_" and "-" only');
    if (!p || typeof p !== 'object') throw bad('not an object');
    if (!strings(p.command) || !p.command.length || !p.command[0]) throw bad('command: a list of text, the program first');
    if (p.command.filter((s) => s === '{args}').length > 1 || p.command[0] === '{args}') throw bad('command: "{args}" once at most, and not as the program');
    if (p.args != null && !strings(p.args)) throw bad('args: a list of regular expressions');
    for (const r of p.args ?? []) {
      try {
        new RegExp(r);
      } catch {
        throw bad(`args: not a regular expression: ${r}`);
      }
    }
    if (p.upload != null && !(strings(p.upload) && p.upload.every((g) => safeRel(g.replace(/\*+|\?/g, 'x'))))) throw bad('upload: a list of relative globs');
    if (p.exclude != null && !strings(p.exclude)) throw bad('exclude: a list of globs');
    for (const k of ['description', 'cwd', 'collect']) if (p[k] != null && typeof p[k] !== 'string') throw bad(`${k} is not text`);
    if (p.env != null && (typeof p.env !== 'object' || Object.entries(p.env).some(([k, v]) => !KEY.test(k) || typeof v !== 'string'))) throw bad('env: { NAME: text }');
    if (p.timeout != null && !(Number.isInteger(p.timeout) && p.timeout >= 1 && p.timeout <= 86400)) throw bad('timeout: 1–86400 seconds');
  }
  return { name: spec.name ?? null, env, presets, ...(spec.parallel ? { parallel: spec.parallel } : {}) };
}

// read again only when the file changed
const cache = new Map();
/** a workspace's render-station.json, checked: { name, env, presets }, and `error` if it is not right */
export function readSpec(path) {
  const file = join(path, FILE);
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return { name: null, env: [], presets: {} };
  }
  const was = cache.get(file);
  if (was && was.mtimeMs === stat.mtimeMs && was.size === stat.size) return was.spec;
  let spec;
  try {
    spec = check(JSON.parse(readFileSync(file, 'utf8')));
  } catch (e) {
    spec = { name: null, env: [], presets: {}, error: `${FILE}: ${e.message}` };
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, spec });
  return spec;
}

/** the workspaces in the settings, as jobs see them: each with its name (the one given, else its
 *  file's, else its folder's), its file read, and the environment its jobs get */
export function resolveWorkspaces(list) {
  return (list ?? []).map((w) => {
    const there = typeof w.path === 'string' && w.path && existsSync(w.path) && statSync(w.path).isDirectory();
    const spec = there ? readSpec(w.path) : { name: null, env: [], presets: {}, error: 'folder not found' };
    const name = w.name || spec.name || basename(w.path ?? '').replace(/[^\w.-]/g, '-');
    const env = {};
    for (const e of spec.env) if (e.default != null) env[e.key] = e.default;
    for (const [k, v] of Object.entries(w.env ?? {})) if (v !== '') env[k] = v;
    return { name, path: w.path, env, given: w.env ?? {}, spec };
  });
}

/** what a render station from before workspaces, run from a checkout of the folder, kept there of
 *  its jobs' environment (its .tools/remote/config.json's env) */
export function legacyEnv(path) {
  try {
    const { env } = JSON.parse(readFileSync(join(path, '.tools/remote/config.json'), 'utf8'));
    if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
    return Object.fromEntries(Object.entries(env).filter(([k, v]) => KEY.test(k) && typeof v === 'string' && v.trim()));
  } catch {
    return {};
  }
}
/** a workspace newly registered (a settings entry, { name, path, env }): what its file asks for and
 *  it was not given, taken from the settings of a station from before workspaces, those kept in its
 *  folder or else `fallback` (brought along by the installer); the keys taken */
export function adopt(entry, fallback = {}) {
  const old = { ...fallback, ...legacyEnv(entry.path) };
  const taken = readSpec(entry.path)
    .env.map((e) => e.key)
    .filter((k) => !entry.env[k] && typeof old[k] === 'string' && old[k].trim());
  for (const k of taken) entry.env[k] = old[k].trim();
  return taken;
}

/** a path, as two of the same folder compare equal */
export const samePath = (p, platform = process.platform) => (platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));
/** whether `path` is `root` or lies under it */
export function within(path, root) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/** a path on this machine as the server names it, in full (a drive alone, 'F:', is its root) */
export function fullPath(path) {
  const p = typeof path === 'string' ? path.trim().replace(/^([A-Za-z]:)$/, '$1/') : '';
  if (!p || !isAbsolute(p)) throw new Error(`path: a full path on this machine${process.platform === 'win32' ? ', such as D:/projects/site' : ''}`);
  return resolve(p);
}
/** a folder of this machine's, as the server names it: there, or with `create`, one that can be made
 *  (on a drive that is there, with no file in its way); whether it is to be made */
function folder(path, create = false) {
  const p = fullPath(path);
  if (existsSync(p)) {
    if (!statSync(p).isDirectory()) throw new Error(`not a folder: ${p}`);
    return { path: p, create: false };
  }
  if (!create) throw new Error(`folder not found on this machine: ${p} (to have it made, add --create)`);
  let up = p;
  while (!existsSync(up)) {
    if (dirname(up) === up) throw new Error(`no such drive on this machine: ${up}`);
    up = dirname(up);
  }
  if (!statSync(up).isDirectory()) throw new Error(`not a folder: ${up}`);
  return { path: p, create: true };
}
/** a change the server asks of the workspaces (cli.mjs workspace: { action: 'add' | 'set' | 'remove',
 *  name, path, create, env, unset }), made to `list`, the settings' (left as it is): the list it
 *  leaves; the lines that say what it changes, for the owner; the keys a workspace added took from a
 *  station from before workspaces (adopt, with `fallback`); the presets of the workspace's folder; and
 *  the folder to be made for it, if any (made by the caller, once the change is allowed) */
export function changeWorkspaces(list, input, fallback = {}) {
  const { action, name } = input ?? {};
  if (!['add', 'set', 'remove'].includes(action)) throw new Error('action: add, set or remove');
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error('name: letters, digits, ".", "_" and "-" only');
  const env = input.env ?? {};
  if (typeof env !== 'object' || Array.isArray(env) || Object.entries(env).some(([k, v]) => !KEY.test(k) || typeof v !== 'string' || v.length > 4096)) throw new Error('env: { NAME: text }');
  const unset = input.unset ?? [];
  if (!Array.isArray(unset) || unset.some((k) => typeof k !== 'string' || !KEY.test(k))) throw new Error('unset: a list of names');
  if (input.create != null && typeof input.create !== 'boolean') throw new Error('create: true or false');
  const after = list.map((w) => ({ ...w, env: { ...w.env } }));
  const at = resolveWorkspaces(list).findIndex((w) => w.name === name);
  const lines = [];
  let imported = [];
  let entry = null;
  let create = null;
  const made = (f) => (f.create ? ((create = f.path), '（新建文件夹）') : '');
  if (action === 'add') {
    if (at >= 0) throw new Error(`a workspace "${name}" is already registered`);
    const f = folder(input.path, input.create);
    entry = { name, path: f.path, env: Object.fromEntries(Object.entries(env).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])) };
    imported = adopt(entry, fallback);
    after.push(entry);
    lines.push(`路径：${entry.path}${made(f)}`, ...Object.entries(entry.env).map(([k, v]) => `${k}：${v}${imported.includes(k) ? '（从旧版渲染站的设置中导入）' : ''}`));
  } else if (at < 0) throw new Error(`no workspace "${name}" on this machine`);
  else if (action === 'remove') {
    lines.push(`路径：${after[at].path}`);
    after.splice(at, 1);
  } else {
    entry = after[at];
    if (input.path != null) {
      const f = folder(input.path, input.create);
      if (samePath(f.path) !== samePath(entry.path)) lines.push(`路径：${entry.path} → ${f.path}${made(f)}`);
      entry.path = f.path;
    }
    for (const [k, v] of Object.entries(env)) {
      const was = entry.env[k];
      const now = v.trim();
      if ((was ?? '') === now) continue;
      lines.push(`${k}：${was ?? '（未设置）'} → ${now || '（清除）'}`);
      if (now) entry.env[k] = now;
      else delete entry.env[k];
    }
    for (const k of unset)
      if (Object.hasOwn(entry.env, k)) {
        lines.push(`${k}：${entry.env[k]} → （清除）`);
        delete entry.env[k];
      }
    if (!lines.length) throw new Error('nothing to change: the workspace already has these settings');
  }
  const names = resolveWorkspaces(after).map((w) => w.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new Error(`two workspaces would be named "${twice}"`);
  return { list: after, lines, imported, presets: entry ? Object.keys(readSpec(entry.path).presets) : [], create };
}

/** the drives of this machine (Windows), else its root */
export const drives = (platform = process.platform) => (platform === 'win32' ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((l) => `${l}:\\`).filter((d) => existsSync(d)) : ['/']);
/** what a folder of this machine's holds, for the server to look through (cli.mjs ls): each entry's
 *  name, whether it is a folder, its size and when it last changed, but nothing of what is in it;
 *  folders first, the first `max` of them, and how many more. `path` null: the drives */
export function listFolder(path, max = 1000) {
  if (path == null) return { path: null, entries: drives().map((name) => ({ name, type: 'folder', size: null, modified: null })), more: 0 };
  const p = fullPath(path);
  let found;
  try {
    found = readdirSync(p, { withFileTypes: true });
  } catch (e) {
    throw new Error({ ENOENT: `folder not found on this machine: ${p}`, ENOTDIR: `not a folder: ${p}`, EACCES: `not allowed to look into: ${p}`, EPERM: `not allowed to look into: ${p}` }[e.code] ?? e.message);
  }
  const stat = (name) => {
    try {
      return statSync(join(p, name));
    } catch {
      return null;
    }
  };
  // a link (a junction, on Windows) is what it leads to
  const entries = found.map((e) => ({ name: e.name, type: (e.isSymbolicLink() ? stat(e.name)?.isDirectory() : e.isDirectory()) ? 'folder' : 'file' }));
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' }) : a.type === 'folder' ? -1 : 1));
  return {
    path: p,
    entries: entries.slice(0, max).map((e) => {
      const s = stat(e.name);
      return { ...e, size: e.type === 'file' && s ? s.size : null, modified: s ? Math.round(s.mtimeMs) : null };
    }),
    more: Math.max(0, entries.length - max),
  };
}

/** the settings a workspace's file asks for on this platform that it has not been given */
export const missingEnv = (w, platform = process.platform) =>
  w.spec.env.filter((e) => e.type !== 'switch' && (e.required === true || e.required === platform) && !w.env[e.key]).map((e) => e.key);

/** a preset's command for `args`, every part filled in: refused if an argument is not one it takes */
export function commandOf(preset, args, vars) {
  if (!strings(args) || args.length > 256 || args.some((a) => a.length > 4096 || a.includes('\0'))) throw new Error('args: a list of text');
  const allow = (preset.args ?? []).map((r) => new RegExp(`^(?:${r})$`));
  for (const a of args) if (!allow.some((re) => re.test(a))) throw new Error(`argument not taken by the preset: ${a}`);
  return preset.command.flatMap((part) => (part === '{args}' ? args : [fill(part, vars)]));
}

/** whether a job may bring the file at `rel` */
export const uploadable = (preset, rel) => safeRel(rel) && (preset.upload ?? []).some((g) => globRe(g).test(rel));

/** the files under `root` that the globs name, by their paths from root (on the server) */
export function gather(root, globs) {
  const found = new Set();
  for (const glob of globs) {
    const parts = glob.split('/');
    const fixed = [];
    for (const part of parts) {
      if (/[*?]/.test(part)) break;
      fixed.push(part);
    }
    const base = join(root, ...fixed);
    if (!existsSync(base)) continue;
    if (fixed.length === parts.length) {
      if (statSync(base).isFile()) found.add(glob);
      continue;
    }
    const re = globRe(glob);
    for (const file of walk(base)) {
      const rel = relative(root, file).split(sep).join('/');
      if (re.test(rel)) found.add(rel);
    }
  }
  return [...found].sort();
}

/** what a preset's job made: the files in its collect folder, but not those it excludes, by their
 *  paths from that folder; refused past `limit` bytes */
export function collect(preset, vars, limit = 128 * 1024 * 1024) {
  if (!preset.collect) return {};
  const dir = fill(preset.collect, vars);
  if (!existsSync(dir)) return {};
  const made = {};
  let size = 0;
  for (const file of walk(dir)) {
    const rel = relative(dir, file).split(sep).join('/');
    if (excluded(preset.exclude ?? [], rel)) continue;
    const data = readFileSync(file);
    size += data.length;
    if (size > limit) throw new Error(`what the job made is over ${Math.round(limit / 1024 / 1024)} MB: not sent back`);
    made[rel] = data;
  }
  return made;
}
