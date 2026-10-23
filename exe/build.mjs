// Builds 渲染站.exe from station.c with mingw-w64: draws the icons (a dot in each state's colour
// with a play mark, as the window's) into .ico files, and puts them in .tools/exe-build/ with the
// sources, the resources and what it takes of the WebView2 SDK (NuGet's Microsoft.Web.WebView2,
// unpacked in .tools/webview2/). Then compile.mjs compiles them: on the device, as the preset
// render-station/exe of its render station (the workspace of the station's own folder, with MINGW
// set), when it is reached and set up so; else here, with the cross compilers. The exe goes to the
// repository's root with the SDK's WebView2Loader.dll; commit both after changing station.c,
// common.h, the resources or the icons. It also builds the installer's program (setup.c) into
// .tools/exe-build/setup.exe, which release/build.mjs appends a release to; --setup builds that alone.
// --local: here, whatever the device. --try: then, compiled on the device, starts it there as a
// trial (渲染站.exe --try: a window of its own on the station running there), once its owner allows
// the Shell command that does.
// usage: node exe/build.mjs [--setup] [--local] [--try]
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '..');
const build = join(repo, '.tools/exe-build');
const out = join(here, '..', '渲染站.exe');
const sdk = join(repo, '.tools/webview2/build/native');

// ——— PNG ———
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(body));
  return Buffer.concat([head, body, tail]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits a channel
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ——— the dot: on a 32-unit square, the circle (16, 16, r 15) and the mark, 8×8 samples a pixel ———
const MARK = [
  [12.5, 9],
  [23.5, 16],
  [12.5, 23],
];
const inMark = (x, y) => {
  const side = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const d = [side(MARK[0], MARK[1]), side(MARK[1], MARK[2]), side(MARK[2], MARK[0])];
  return d.every((v) => v >= 0) || d.every((v) => v <= 0);
};
function dot(hex, size) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const px = Buffer.alloc(size * size * 4);
  const S = 8;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let disc = 0;
      let mark = 0;
      for (let j = 0; j < S; j++)
        for (let i = 0; i < S; i++) {
          const u = ((x + (i + 0.5) / S) * 32) / size;
          const v = ((y + (j + 0.5) / S) * 32) / size;
          if ((u - 16) ** 2 + (v - 16) ** 2 > 15 * 15) continue;
          disc++;
          if (inMark(u, v)) mark++;
        }
      if (!disc) continue;
      const white = mark / disc;
      const o = (y * size + x) * 4;
      px[o] = Math.round(r + (255 - r) * white);
      px[o + 1] = Math.round(g + (255 - g) * white);
      px[o + 2] = Math.round(b + (255 - b) * white);
      px[o + 3] = Math.round((disc / (S * S)) * 255);
    }
  return png(size, px);
}
// an .ico of PNGs, one a size
function ico(hex, sizes) {
  const images = sizes.map((s) => dot(hex, s));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let at = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s;
    head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(at, e + 12);
    at += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

const setupOnly = process.argv.includes('--setup');
rmSync(build, { recursive: true, force: true });
mkdirSync(join(build, 'sdk'), { recursive: true });
const TRAY = [16, 20, 24, 32, 40, 48, 64];
// the program's own icon is the busy one, the accent: big enough for Explorer's large views too
writeFileSync(join(build, 'busy.ico'), ico('#6a4c9e', [...TRAY, 96, 128, 256]));
for (const [name, hex] of Object.entries({ idle: '#2a9d80', wait: '#d99a1e', bad: '#d4563a', off: '#9a8a9d' })) writeFileSync(join(build, `${name}.ico`), ico(hex, TRAY));
for (const f of ['station.c', 'setup.c', 'common.h', 'station.rc', 'setup.rc', 'station.manifest']) copyFileSync(join(here, f), join(build, f));
copyFileSync(join(sdk, 'include/WebView2.h'), join(build, 'sdk/WebView2.h'));
// WebView2.h asks for EventToken.h, which mingw-w64 has in lower case
writeFileSync(join(build, 'sdk/EventToken.h'), '#include <eventtoken.h>\n');
copyFileSync(join(sdk, 'x64/WebView2Loader.dll'), join(build, 'WebView2Loader.dll'));

// on the device, if it can; a job that ran there and failed is the end of it, one that could not run
// there is compiled here instead
let onDevice = false;
if (!process.argv.includes('--local')) {
  const job = spawnSync(process.execPath, [join(repo, 'cli.mjs'), 'run', '--json', '--src', build, '--out', join(build, 'out'), 'render-station/exe', ...(setupOnly ? ['--setup'] : [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let reply = null;
  try {
    reply = JSON.parse(job.stdout);
  } catch {}
  if (reply?.log?.trim()) console.log(reply.log.trim());
  if (reply?.ok) {
    onDevice = true;
    console.log(`compiled on the device in ${reply.seconds} s`);
  } else if (reply?.exitCode != null) {
    console.error('compiling on the device failed');
    process.exit(1);
  } else console.log(`compiling here: not on the device (${(reply?.error ?? job.stderr ?? '').trim().split('\n').at(-1)})`);
}
if (!onDevice) execFileSync(process.execPath, [join(here, 'compile.mjs'), build, ...(setupOnly ? ['--setup'] : [])], { stdio: 'inherit' });
if (!setupOnly) {
  copyFileSync(join(build, 'out/渲染站.exe'), out);
  copyFileSync(join(sdk, 'x64/WebView2Loader.dll'), join(repo, 'WebView2Loader.dll'));
  console.log(out);
}
copyFileSync(join(build, 'out/setup.exe'), join(build, 'setup.exe'));
console.log(join(build, 'setup.exe'));

// the trial: the newest 渲染站.exe the device compiled (kept there with what each job made, beside the
// loader), started with --try, as its owner allows
if (process.argv.includes('--try')) {
  if (!onDevice || setupOnly) {
    console.error('--try: only for 渲染站.exe as the device compiled it');
    process.exit(1);
  }
  const start = [
    "$kept = Get-ChildItem .tools/remote/out -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'WebView2Loader.dll') } | Sort-Object Name | Select-Object -Last 1",
    "$exe = Get-ChildItem $kept.FullName -Filter *.exe | Where-Object Name -ne 'setup.exe' | Select-Object -First 1",
    "Start-Process $exe.FullName -ArgumentList '--try'",
    'Write-Output $exe.FullName',
  ].join('; ');
  const trial = spawnSync(process.execPath, [join(repo, 'cli.mjs'), 'shell', '--workspace', 'render-station', start], { stdio: 'inherit' });
  process.exit(trial.status ?? 1);
}
