// Compiles 渲染站.exe and the installer's program (setup.exe) with mingw-w64, from a folder
// exe/build.mjs has put together (the sources, the resources, the icons it drew, WebView2Loader.dll,
// and in sdk/ WebView2.h), into its out/ with the loader beside them. On Linux with the cross compilers
// (x86_64-w64-mingw32-gcc and -windres); on Windows with those in the bin folder MINGW names (as
// w64devkit has them: gcc.exe and windres.exe), which is how the render-station workspace's preset
// `exe` runs it on the device (render-station.json): one copy of the flags, wherever it compiles.
// usage: node exe/compile.mjs <folder> [--setup]   (--setup: the installer's program alone)
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? '.');
const setupOnly = process.argv.includes('--setup');
const out = join(dir, 'out');
mkdirSync(out, { recursive: true });

const win = process.platform === 'win32';
const bin = process.env.MINGW ?? '';
if (win && !bin) {
  console.error('MINGW: the bin folder of mingw-w64 (gcc.exe, windres.exe), in the workspace settings');
  process.exit(1);
}
const tool = (name) => (win ? join(bin, `${name}.exe`) : `x86_64-w64-mingw32-${name}`);
// windres preprocesses with the gcc it finds on the PATH
const env = win ? { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } : process.env;
const run = (name, args) => execFileSync(tool(name), args, { cwd: dir, env, stdio: 'inherit' });

const flags = ['-O2', '-s', '-Wall', '-municode', '-mwindows', '-static-libgcc'];
if (!setupOnly) {
  run('windres', ['-c', '65001', '-i', 'station.rc', '-O', 'coff', '-o', 'station.res.o']);
  // the SDK's headers (in sdk/) as a system's: its IIDs, defined in the header, are not ours to be
  // warned about
  run('gcc', [...flags, '-isystem', join(dir, 'sdk'), '-o', join(out, '渲染站.exe'), 'station.c', 'station.res.o', '-lws2_32', '-lole32', '-luuid', '-lshell32', '-ladvapi32', '-ldwmapi', '-lcomctl32']);
  copyFileSync(join(dir, 'WebView2Loader.dll'), join(out, 'WebView2Loader.dll'));
}
run('windres', ['-c', '65001', '-i', 'setup.rc', '-O', 'coff', '-o', 'setup.res.o']);
run('gcc', [...flags, '-o', join(out, 'setup.exe'), 'setup.c', 'setup.res.o', '-lshell32', '-ladvapi32', '-lcomctl32']);
console.log(`compiled${win ? '' : ' with the cross compilers'}: ${setupOnly ? 'setup.exe' : '渲染站.exe, setup.exe'}`);
