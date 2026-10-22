// Publishes the release release/build.mjs put together to the update server, lu1: the release's
// files first (only new ones: each is named by its hash and never changes), then the installer, and
// render-station-setup.exe made a link to it, latest.json last, so that a station checking meanwhile
// finds the old release whole or the new one whole. lu1 serves them at
// https://8.137.206.169/assets/render-station/: they are kept in /home/user1/apps/render-station/public/,
// which a link in qiqi-assets' releases/ (served as /assets/ by its Nginx, behind OpenResty's TLS)
// points to; nothing of lu1's configuration changes.
// usage: node release/publish.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER, openRelease } from '../update.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, '.tools/release/out');
const ROOT = 'apps/render-station/public';
const LINK = 'apps/qiqi-assets/releases/render-station';

const text = readFileSync(join(out, 'latest.json'), 'utf8');
const release = openRelease(text);
const ssh = (cmd) => execFileSync('ssh', ['-o', 'ConnectTimeout=15', 'lu1', cmd], { stdio: 'inherit' });
const rsync = (args, input) => execFileSync('rsync', args, { cwd: out, input, stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'] });

ssh(`mkdir -p ${ROOT}/files && chmod 755 apps/render-station ${ROOT} ${ROOT}/files && { test -e ${LINK} || ln -s /home/user1/${ROOT} ${LINK}; }`);
const blobs = [...new Set(Object.values(release.files).map((f) => `files/${f.sha256}.gz`))];
rsync(['-a', '--ignore-existing', '--chmod=D755,F644', '--files-from=-', '.', `lu1:${ROOT}/`], blobs.join('\n'));
rsync(['-a', '--chmod=F644', release.setup, `lu1:${ROOT}/`]);
ssh(`cd ${ROOT} && ln -sfn ${release.setup} .setup-link && mv -Tf .setup-link render-station-setup.exe`);
rsync(['-a', '--chmod=F644', 'latest.json', `lu1:${ROOT}/latest.json`]);

// as a station finds it
const seen = openRelease(await (await fetch(`${SERVER}latest.json?t=${Date.now()}`)).text());
if (seen.version !== release.version) throw new Error(`the server lists ${seen.version}, not ${release.version}`);
console.log(`published ${release.version}`);
console.log(`${SERVER}${release.setup}`);
console.log(`${SERVER}render-station-setup.exe`);
