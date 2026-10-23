# Render Station (渲染站)

English | [中文](README.zh-CN.md)

Render Station lets agents running on a server hand heavy jobs to another computer, currently a Windows machine. The machine that runs the jobs connects to the server through a reverse SSH tunnel, so it needs no public IP address and no open inbound port.

The name comes from its first use: rendering a promotional video for qiqi.help. The station's own window and messages are in Chinese.

## Terms

| Term | Meaning |
|---|---|
| Server | The machine that runs the agents and submits jobs, usually Linux. |
| Device | The Windows computer that runs the station and executes jobs. |
| Station | The tray program `渲染站.exe` together with the background process `station.mjs`. It manages the worker, the tunnel and the settings window. |
| Worker | `worker.mjs`. It listens on the device's `127.0.0.1:7700` and executes jobs. |
| Workspace | A folder registered on the device. Jobs run only in registered workspaces. |
| Preset | A job defined in a workspace's `render-station.json`. The server can run it without approval each time. |

## How it works

1. On the device, the station starts the worker and opens a reverse tunnel to the server: `ssh -N -R 77xx:127.0.0.1:7700 -p <port> <user>@<server>`. The server-side port starts at 7700. If a port is still held by a dead connection, the station tries the next one, up to 7709.
2. On the server, the command-line tool `rs` (`cli.mjs`) probes these ports and submits the job to the worker that answers.
3. There are two kinds of job:
   - **Preset jobs.** The caller brings the files the preset allows (for example a script and its input). The device runs the preset's command in a job folder of its own, `.tools/remote/jobs/<number>/`, and, on success, sends back the files in the preset's output folder.
   - **Shell jobs.** A command runs in a workspace, subject to local authorization on the device (see "Shell permissions").
4. The device also keeps a copy of each job's output in `.tools/remote/out/<time>/`, for the latest 30 jobs.

The worker can run several jobs at once:

- How many run at once is set on the device under 设置 → 本机 → 同时运行的任务数 (Settings → This computer → Jobs at once): 2 by default, 1–16.
- A workspace's presets run one at a time by default, since they may use the same files; the workspace file can allow more with `parallel`. Shell jobs count only toward the total.
- Jobs beyond the limit wait in the order they came; `rs` waits with them and says how many are ahead. A waiting job is cancelled if its submitter disconnects. At most 16 jobs can wait; beyond that, new jobs are refused.

## Requirements

Device:

- Windows 10 version 1803 or later, or Windows 11. With the installer, Node.js and Git need not be installed.
- Key-based SSH login to the server (the default key or one in ssh-agent). Running `ssh -p <port> <user>@<server>` in a terminal must not prompt for a password.
- The WebView2 runtime. Without it, the window opens as an Edge app window instead.
- Any other software a workspace's presets need, as that workspace documents.

Server: Node.js 18 or later and a checkout of this repository.

## Installation

### Device

1. Download the installer: <https://8.137.206.169/assets/render-station/render-station-setup.exe> (about 40 MB, Node.js included).
2. Run it. The installer is not code-signed, so Windows may say "Windows protected your PC"; click "More info", then "Run anyway".
3. Click 安装 (Install). The station is installed for the current user in `%LOCALAPPDATA%\Programs\render-station\`, without administrator rights; it then starts and creates 渲染站 shortcuts on the desktop and in the Start menu.
4. In the window's 设置 → 连接 (Settings → Connection) page, enter the server's SSH address and port; then register workspaces in 设置 → 工作区 (Settings → Workspaces). Changes are saved as they are made.

The installer first closes a running station. Running a newer installer installs over the old copy and keeps the settings. To uninstall, find 渲染站 under Windows Settings → Apps → Installed apps and choose Uninstall; you can choose whether to keep the settings and the jobs' output.

A checkout of this repository also runs as it is: clone it, run `npm install` in its root, and double-click `渲染站.exe`. This needs Node.js and Git on the device and updates through Git (see "Automatic updates"). `渲染站.exe` must stay in the same folder as `station.mjs`.

### Server

Clone this repository and run `npm link` in it. This installs the commands `render-station` and `rs` (see "Command line"); without it, run `node cli.mjs` from the checkout instead.

### Migrating from the old location

The station used to live in qiqi.help's `promo/remote/`. Running the installer migrates it: the installer closes the old instance and, while the new copy has no settings, copies the old checkout's `.tools\remote\config.json`, so the server address, the Shell allowlist and the other settings carry over. The old `PROMO_*` settings are imported when the qiqi.help checkout is registered as a workspace (see "Workspaces"). The new instance recreates the shortcuts and the autostart entry and removes the old autostart entry. The old `%LOCALAPPDATA%\qiqi-render-station\` folder can be deleted by hand.

## Configuration

The settings are stored in `.tools/remote/config.json` and edited in the window's 设置 (Settings), which has five pages: 连接 (Connection), 工作区 (Workspaces), 权限与审批 (Permissions and approvals), 本机 (This computer) and 更新与关于 (Updates and about). Each change takes effect at once; there is no Save button.

### Server

In Settings → Connection. Write the SSH address as `user@server`. The port is the server's SSH port; when empty, 22 is used. The station opens no tunnel until an address is set. Changing either reconnects the tunnel.

### Workspaces

In Settings → Workspaces. Each workspace is a block showing its name, its path and whether it is ready; click it to open its settings. Each workspace has:

| Item | Description |
|---|---|
| Name | The name the server uses to call its presets. When empty, the station uses the `name` in the workspace file, then the folder name. Letters, digits, `.`, `_` and `-` only; names must be unique. |
| Path | The folder on the device. |
| Settings the workspace file declares | Once the path is set, the fields from the file's `env` are listed. While a required field is empty, the workspace's presets are refused. |
| Other environment variables | One `NAME=value` per line, also passed to the workspace's jobs. |

An opened workspace lists its presets. A field is saved when you leave it, a switch when you flip it. 添加工作区 (Add workspace) takes a name and a path; 移除工作区 (Remove workspace) asks first and leaves the folder alone. The station rereads a workspace file when it changes; no restart is needed.

When a workspace is added, in the Settings page or by the server, and its folder still holds an old station's `.tools\remote\config.json`, the settings there that the workspace file's `env` declares and that are not yet filled in are imported.

The server can also add, change and remove workspaces with `rs workspace`, as far as 服务器管理工作区 (Server manages workspaces) under Settings → Permissions and approvals allows (see "Command line").

**Registering a workspace trusts its presets.** Presets run without approval. If a preset lets the caller upload a script and runs it, the caller can run any code on the device with the rights of the account the station runs under.

### Permissions and approvals

- 服务器管理工作区 (Server manages workspaces): what the server may do with `rs workspace` and `rs ls`. 关闭 (Off), it can neither change workspaces nor list folders; 需要审批 (Ask, the default), each change, and each folder listing outside the registered workspaces, must be approved in the device's window; 无需审批 (Allow), it does all of these directly.
- 同步剪贴板 (Sync clipboard): off by default; see "Clipboard sync".
- Shell jobs, YOLO mode and the allowlist: see "Shell permissions".

### This computer

- 同时运行的任务数 (Jobs at once): see "How it works".
- 以管理员身份运行 (Run as administrator), on the 总览 (Overview) page under 本机: on by default. Each time the station starts, including with Windows, Windows asks through User Account Control whether it may run as administrator; if the answer is no, it runs with normal rights. While it runs as administrator, presets and Shell commands do too. When it runs with normal rights, the button 以管理员身份重新启动 (Restart as administrator) asks again; it needs no jobs running or waiting. Turned off, the station no longer asks from its next start on.

These switches are on by default; turning one off undoes its effect:

- 登录 Windows 后自动启动 (Start when signing in to Windows): visible under Startup apps in Task Manager.
- 在桌面和开始菜单中创建快捷方式 (Shortcuts on the desktop and in the Start menu).
- 自动更新 (Automatic updates), in Settings → Updates and about: see "Automatic updates". The same page shows the version and where the log is, and opens the log.

## Workspace file

The `render-station.json` file in a workspace's root declares the settings the workspace needs and the presets it offers. A workspace without this file can run Shell jobs only. Example:

```json
{
  "name": "video",
  "env": [
    { "key": "FFMPEG", "label": "ffmpeg", "required": true, "placeholder": "C:\\ffmpeg\\bin\\ffmpeg.exe" }
  ],
  "presets": {
    "transcode": {
      "description": "Convert the uploaded video to H.264",
      "command": ["node", "{job}/transcode.mjs", "{args}"],
      "upload": ["transcode.mjs", "input/*"],
      "args": ["--crf", "\\d{1,2}"],
      "collect": "{job}/output",
      "timeout": 3600
    }
  }
}
```

The `render-station.json` at the root of the qiqi.help repository is a real-world example.

The top-level `parallel` (1–16, default 1) sets how many of the workspace's preset jobs may run at once. Raise it only when they cannot contend for the same files.

### `env`: required settings

| Field | Description |
|---|---|
| `key` | The environment variable's name. |
| `label` | The name shown in the Settings page. |
| `required` | `true` for required, or a platform name such as `"win32"` for required on that platform only. |
| `placeholder` | Hint text in the input field. |
| `hint` | Additional explanation. |
| `type` | `"text"` (default) or `"switch"`. A switch's value is `"1"` or `"0"`. |
| `default` | The value used when the field is empty. |

### `presets`

| Field | Description |
|---|---|
| `command` | Required. An argument list whose first item is the program; `node` means the station's own Node.js. No shell interprets it. `"{args}"` expands to the caller's arguments and may appear at most once. |
| `args` | The arguments accepted, as a list of regular expressions; each argument must fully match one of them. When omitted, no arguments are accepted. |
| `upload` | The files a caller may bring, as relative globs (`*` and `?` stay within a folder, `**` crosses folders). The server collects matching files from the `--src` folder; the device accepts only matching files and puts them in the job folder. |
| `collect` | When the command succeeds (exit code 0), the files in this folder are sent back to the server. |
| `exclude` | Files not to send back, as globs; a glob without `/` matches a file name in any folder. |
| `cwd` | The working directory; defaults to `{workspace}`. |
| `env` | Additional environment variables. |
| `timeout` | Time limit in seconds, 1–86400; no limit when omitted. |
| `description` | Shown in the Settings page and by `rs status` and `rs presets`. |

`command`, `cwd`, `env` and `collect` may use two placeholders: `{job}`, the job folder (`.tools/remote/jobs/<number>/` on the device, one per job, removed when it ends), and `{workspace}`, the workspace's path.

## Using the station

### Tray icon

The tray icon's color shows the state:

| Color | State |
|---|---|
| Green | Idle, waiting for jobs |
| Purple | Running jobs |
| Yellow | Connecting |
| Red | Cannot log in to the server, or the station cannot start |
| Gray | Paused, or no server set |

Click the icon to open the window. The right-click menu has 打开渲染站 (Open), 暂停接收任务 (Pause; 恢复接收任务, Resume, while paused), 重新连接 (Reconnect), 在浏览器中打开 (Open in browser), 查看日志 (View log) and 退出渲染站 (Quit). A notification appears when a job finishes, and when a request from the server awaits approval; clicking it opens the window.

### Window

The window is `station.html` in WebView2, without a system title bar; the minimize, maximize and close buttons are at the page's top right. Drag the top of the page or an empty part of the sidebar to move the window; double-click there to maximize or restore it. The window opens where it was last, at its last size, maximized if it was. A closed window's page stays loaded in the background for 5 minutes, so opening it again within that time is instant. The sidebar has four items:

- 总览 (Overview): the state with a progress strip, today's counts, the last two minutes of CPU, memory and GPU load, and the recent jobs with their output. While more than one job runs or waits, 运行中 (Running) lists each with its progress.
- 输出 (Output): the files the jobs produced, kept on this device. Images and videos can be previewed (videos play on hover, click to enlarge, arrow keys to browse); other files open in their default program.
- 动态 (Activity): the connection's progress and the live output of ssh and the jobs, each line of a job's output marked with its number.
- 设置 (Settings): five pages, Connection, Workspaces, Permissions and approvals, This computer, and Updates and about; see "Configuration" and "Shell permissions". A page lacking a required setting has a yellow dot beside its name.

The same page is available in a browser at `http://127.0.0.1:7799`; append `#gallery`, `#feed`, `#connection`, `#workspaces`, `#access`, `#machine` or `#about` to open a page directly; `#settings` opens Connection.

Lines of the form `frame 12/300` in a job's output are read as progress: shown on the Overview page's progress strip while one job runs, and in the Running list while several do.

### State and logs

After the device wakes from sleep, loses the network, or the worker exits, the station reopens the tunnel and restarts the worker on its own. The log is `.tools/remote/station.log`; open it from the tray menu's 查看日志 (View log) or from Settings → Updates and about.

While the tunnel is open, anyone who can log in to the server can run the device's presets. Pause the station (in the window or the tray menu) when it is not needed; pausing closes the tunnel.

## Command line

On the server, `render-station` (short name `rs`) submits jobs and manages the device's workspaces. Install it with `npm link` in the checkout (see "Installation"). The full manual, with every option, the JSON output and the exit codes, is [docs/cli.md](docs/cli.md); `rs help <command>` shows the same in brief.

| Command | Purpose |
|---|---|
| `rs status` | Whether the device is reached, the jobs running and waiting, and the workspaces. |
| `rs presets [<workspace>]` | The presets and the arguments they take. |
| `rs run <workspace>/<preset> [args…]` | Run a preset, bringing the files it takes from the current folder (`--src`), and save what it makes (`--out`). |
| `rs shell <command…>` | Run a command in a workspace, as the Shell permissions allow. |
| `rs workspace [list\|add\|set\|remove]` | List the workspaces, or change them; `--create` makes a missing folder. |
| `rs ls [<path>]` | List a folder on the device, or its drives. |
| `rs clip [ls\|set]` | Read what was copied on the device, or put something on its clipboard; see "Clipboard sync". |

```sh
rs ls F:/
rs ws add video F:/projects/video
rs presets video
rs run video/transcode --crf 23
```

- Every command takes `--json` and then prints one JSON object.
- When the device already runs as many jobs as it allows, a job waits its turn; interrupting the command cancels it.
- `rs workspace` changes and `rs ls` outside the registered workspaces depend on the device's 服务器管理工作区 (Server manages workspaces); by default each request waits up to 5 minutes for approval in the device's window. An approved folder stays open to `rs ls`, with everything under it, for 10 minutes.
- Commands and settings passed to the device are shown in approval dialogs and written to its log; never put keys or passwords in them.

## Shell permissions

The station refuses Shell jobs by default. Enable them on the device under 设置 → 权限与审批 (Settings → Permissions and approvals); they start in auto mode.

### Auto mode

- The actual working directory, after resolving symbolic links, must be inside the chosen workspace.
- A command runs automatically when the full command and the working directory exactly match an allowlist entry. Nothing is allowed by interpreter or command prefix.
- Otherwise the request waits for approval in the station's window (a dialog appears while the window is open, and the tray icon shows a notification that opens the window when clicked), with the choices 拒绝 (Deny), 仅本次允许 (Allow once) and 允许并加入白名单 (Allow and add to the allowlist). Several requests are shown one after another, in the order they came. A request not approved within 5 minutes fails.
- The allowlist is stored in the device's `.tools/remote/config.json`; entries can be removed in Settings → Permissions and approvals.

### YOLO mode

- To enable it: run the station as administrator (on Windows, choose Yes when User Account Control asks as it starts, or click 以管理员身份重新启动 on the Overview page; elsewhere, run it as root); then turn on YOLO in Settings → Permissions and approvals and confirm.
- The station checks that its process has administrator rights; then any command and any working directory are allowed. With no workspace registered, working directories are relative to the user's home folder.
- The mode is kept in memory only. Pausing, reconnecting or restarting returns to auto mode.

### Security boundaries

- The job protocol has no way to change the allowlist or switch the Shell mode. These happen only in the device's Settings page; the server cannot turn on YOLO mode.
- Whether the server may register, change or remove workspaces, make folders for them, and list folders outside them is up to 服务器管理工作区 on the device, which only the device can change. By default each request must be approved there. Set to 无需审批 (Allow), anyone who can log in to the server can list any folder, register any folder and run its presets, which amounts to running any code. Listing shows names, sizes and times, never file contents.
- This is an authorization mechanism, not an operating-system sandbox. An approved command can read and write files with all the rights of the station's account; the directory check constrains only the initial working directory.
- The allowlist records command text and does not pin the content of scripts the command uses. If a script changes, the same command still runs automatically.
- Presets do not go through the Shell allowlist; for the trust they carry, see "Workspaces".
- Run as administrator, the station and everything it runs have administrator rights, so a preset or an approved command can change system settings and any file. Windows asks through User Account Control each time; turn off 以管理员身份运行 to stop it asking.
- A pending command, workspace change or folder listing never takes effect after a denial, an approval timeout, or the submitter disconnecting.
- Turning off Shell permissions or pausing refuses further jobs and cancels pending requests, waiting jobs and YOLO mode, but does not stop a command already running. When a command times out or its submitter disconnects, the station tries to end its process tree.
- Mode changes, pending requests, manual decisions, executed commands, working directories, results, workspace changes and folders listed outside the workspaces are written to the device's `.tools/remote/station.log`.

## Clipboard sync

With 同步剪贴板 (Sync clipboard) on in 设置 → 权限与审批 (Settings → Permissions and approvals), the device and the server share the clipboard:

- Text and pictures copied on the device are written over SSH to `~/.render-station/clipboard/` on the server within about a second: the newest as `latest.txt` or `latest.png` (pictures always become PNG), the last 50 in `history/`. Of several copied in a row, only the last is sent; while the tunnel is down, the newest is sent once it is back.
- The server puts text or a picture on the device's clipboard with `rs clip set`; what it puts there is not sent back.
- On the server, `rs clip` prints the newest (for a picture, its path) and `rs clip ls` lists the history. Both read the files on the server and do not need the device.
- What a password manager or similar program marks as not to be recorded, and anything over 20 MB, is not synced.
- Syncing shows no notification; the feed and the log record its direction, type and size, never the content.

```sh
rs clip
git diff | rs clip set
rs clip set --file shot.png
```

## Automatic updates

When enabled, the station checks one minute after starting and every 30 minutes after that; the 立即检查 (Check now) button in Settings → Updates and about checks immediately. While jobs run, wait or await approval, the update waits until all are over. When the station's own files change, it restarts itself; when `渲染站.exe` changes, the tray program replaces itself with the new version.

**A copy installed by the installer** takes new versions from the update server, `https://8.137.206.169/assets/render-station/`:

- The server's `latest.json` lists every file of the newest version with its SHA-256 and carries an Ed25519 signature by the release key. The station accepts only a validly signed release with a higher version number.
- Only changed files are downloaded (`files/<SHA-256>.gz`). Each is checked before any is put in place, and if one cannot be put in place, all are restored. Replaced files are first renamed `*.old` and deleted at the next start.
- `release.json` in the installed folder records the current version.

**A Git checkout** fast-forwards to its current branch's upstream; a checkout made with `git clone` already has one. It does not update while the working tree has uncommitted changes or there are unpushed commits.

## Tray program

`渲染站.exe`, built from `exe/station.c`:

- When started, it copies itself and `WebView2Loader.dll` to `%LOCALAPPDATA%\render-station\` and runs from there, so the installed (or repository) exe is never locked and updates can replace it.
- Starts `station.mjs` in the background and restarts it whenever it exits, with the installed folder's `node\node.exe` if there is one, else the system's Node.js.
- Puts the station, ssh and the jobs' processes in one job object, so they all end when it quits.
- Started without administrator rights, it asks for them through User Account Control (`runas`) and leaves the rest to the copy so started, unless `.tools\remote\no-elevate` exists (以管理员身份运行 turned off); if the answer is no, it goes on with normal rights. A restart after an update keeps the rights it had without asking again. Run as administrator, it still takes the messages of processes without those rights: a second start opening the window, the installer asking it to quit, and Explorer's.
- The window's position, size and maximized state are kept in the registry under `HKCU\Software\render-station`; uninstalling removes them.
- `渲染站.exe --uninstall` uninstalls a copy the installer installed; Windows' Installed apps runs it.
- `渲染站.exe --try` is a trial: beside the running station, a new build's window on the same page, with a tray icon of its own to open the window again or end the trial. It starts no background process, changes neither autostart nor the shortcuts, and asks for no administrator rights; its log and WebView2 data are in `%LOCALAPPDATA%\render-station\try\`. Starting a trial again has the previous one quit first; a trial ends by itself 5 minutes after its window is closed.

## Running without the tray program

Register workspaces in `.tools/remote/config.json` (or once through the tray program), then run in two terminals:

```sh
node worker.mjs
ssh -N -R 7700:127.0.0.1:7700 -p <port> <user>@<server>
```

Run this way, there is no approval interface, so only presets run, and the server can neither manage workspaces nor list folders. How many jobs run at once is `parallel` in `config.json`, 2 by default.

## Known limitations

- One server works with one device.
- Each job is one synchronous HTTP request: if the submitter disconnects, including when the tunnel drops, the job is stopped.
- Uploads may total at most 48 MB and returned files at most 128 MB.

## Development

- Tests: `node --test`.
- Build `渲染站.exe`: `node exe/build.mjs`. It gathers the sources, the resources, the icons and the WebView2 SDK's header and `WebView2Loader.dll` (the SDK is the NuGet package `Microsoft.Web.WebView2`, unpacked in `.tools/webview2/`) in `.tools/exe-build/`, and `exe/compile.mjs` compiles them into the repository root. It also builds the installer's program, `.tools/exe-build/setup.exe`.
  - When the device is reached and set up for it, it compiles there, with the preset `render-station/exe`; otherwise here, with mingw-w64 (`x86_64-w64-mingw32-gcc`). `--local` always compiles here.
  - Setting up the device: register the station's own installed folder as the workspace `render-station` (its `render-station.json` offers the preset) and set its `MINGW` to mingw-w64's `bin` folder, such as [w64devkit](https://github.com/skeeto/w64devkit)'s `w64devkit\bin`. The preset compiles what it is brought and runs none of it.
  - `node exe/build.mjs --try`: compiled on the device, the new `渲染站.exe` is started there with `--try` by a Shell job, which the owner approves on the device.
- After changing anything in `exe/`, rebuild and commit `渲染站.exe` together with the sources.

### Releasing

1. Set the version in `package.json` and commit everything.
2. `node release/build.mjs` packs the committed files, the window's fonts and Node.js for Windows (`NODE` in `release/build.mjs`, downloaded from nodejs.org and checked on first use), and writes the signed `latest.json`, the update files `files/<SHA-256>.gz` and the installer to `.tools/release/out/`.
3. `node release/publish.mjs` uploads them over `ssh lu1` to lu1's `/home/user1/apps/render-station/public/`: the files first, then the installer (with `render-station-setup.exe` made a link to it), then `latest.json`; it finally reads `latest.json` back from the public address to check it.

The release key's private half is `.tools/release/key.pem`, outside version control; its public half is `KEY` in `update.mjs`. Back up the private key elsewhere: without it, installed copies cannot accept new versions and must be reinstalled.

## Files

| Path | Description |
|---|---|
| `cli.mjs` | The command-line tool on the server, installed as `render-station` and `rs`. |
| `docs/` | The command-line manual (`cli.md`, `cli.zh-CN.md`). |
| `update.mjs` | Updates of an installed copy: checking a release's signature, and fetching, checking and replacing files. |
| `worker.mjs` | The worker: receives jobs, queues and runs them and returns the results; passes on the server's workspace changes and folder listings. |
| `workspace.mjs` | Reading and checking workspace files, globs, presets' commands and output, checking workspace changes, importing old settings, and listing folders. |
| `shell.mjs` | Approval, allowlist and execution of Shell jobs, and the approval queue. |
| `station.mjs` | The station's background process: manages the worker, the tunnel and the settings, and serves the window at `127.0.0.1:7799`. |
| `station.html` | The station's window. |
| `渲染站.exe` | The built tray program. |
| `WebView2Loader.dll` | The WebView2 loader the tray program's window needs. |
| `exe/` | The tray program's sources (`station.c`, `station.rc`, `station.manifest`), the installer's (`setup.c`, `setup.rc`), `common.h` shared by both, and the build scripts: `build.mjs` gathers the files and chooses where to compile, `compile.mjs` runs mingw-w64. |
| `render-station.json` | The station's own workspace file: with its installed folder registered as a workspace, it offers the preset `exe`, which compiles `渲染站.exe` on the device. |
| `release/` | Release scripts: `build.mjs` packs and signs, `publish.mjs` uploads to the update server. |
| `*.test.mjs` | Tests. |
| `release.json` | Only in an installed copy: the signed manifest of its version. |
| `.tools/` | Runtime data (`remote/config.json`, `remote/station.log`, `remote/no-elevate`, `remote/jobs/`, `remote/out/`, `results/`, `update/`), the WebView2 SDK (`webview2/`) and release files (`release/`); not under version control. |

## License

MIT; see `LICENSE`. The exception is `WebView2Loader.dll`, which is Microsoft's and is used under the Microsoft WebView2 license terms, not the MIT License.
