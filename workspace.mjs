// Workspaces: the folders on this machine that jobs may work in, each registered in the station's
// settings with its path and the environment its jobs get. A workspace may carry a
// render-station.json at its root, which says what it needs and what it offers:
//   env      the environment its jobs read, shown as fields in the settings
//            ([{ key, label, required: true | '<platform>', placeholder, hint, type: 'switch', default }])
//   presets  the jobs the server may run in it without asking each time
//            ({ <name>: { description, command, cwd, env, upload, args, collect, exclude, timeout } })
// A preset's command is an argument list (no shell): '{args}' stands for the job's arguments, each of
// which must match one of `args` (regular expressions, whole), and '{job}' and '{workspace}' in any
// part, in cwd, env and collect, for the job's folder and the workspace's. `upload`: the files a job
// may bring (globs from the workspace's root on the server: '*' within a folder, '**' across them),
// set up in the job's folder; `collect`: the folder whose files go back once the command succeeds,
// but not those `exclude` names (a glob with no '/' in it names a file in any folder). Registering a
// workspace trusts its presets: what a job brings and runs has the account's rights.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

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
  return { name: spec.name ?? null, env, presets };
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
