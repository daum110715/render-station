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
2. On the server, `cli.mjs` probes these ports and submits the job to the worker that answers.
3. There are two kinds of job:
   - **Preset jobs.** The caller brings the files the preset allows (for example a script and its input). The device runs the preset's command in the job folder `.tools/remote/job/` and, on success, sends back the files in the preset's output folder.
   - **Shell jobs.** A command runs in a workspace, subject to local authorization on the device (see "Shell permissions").
4. The device also keeps a copy of each job's output in `.tools/remote/out/<time>/`, for the latest 30 jobs.

The worker runs one job at a time.

## Requirements

Device:

- Windows with Node.js and Git.
- Key-based SSH login to the server (the default key or one in ssh-agent). Running `ssh -p <port> <user>@<server>` in a terminal must not prompt for a password.
- The WebView2 runtime. Without it, the window opens as an Edge app window instead.
- Any other software a workspace's presets need, as that workspace documents.

Server: Node.js 18 or later and a checkout of this repository.

## Installation

On the device:

1. Clone this repository: `git clone https://github.com/daum110715/render-station.git`.
2. Run `npm install` in the repository root. It installs the two font packages the window uses.
3. Double-click `渲染站.exe` in the repository root. After the first start, a 渲染站 shortcut appears on the desktop and in the Start menu; use it from then on.
4. In the window's 设置 (Settings) page, enter the server's SSH address and port, register workspaces, and click 保存 (Save).

`渲染站.exe` must stay in the same folder as `station.mjs`, the repository root.

On the server, cloning this repository is enough: `cli.mjs` has no package dependencies.

### Migrating from the old location

The station used to live in qiqi.help's `promo/remote/`. To migrate, quit the old instance from its tray menu, then start the station from the new location as described above. The new instance recreates the shortcuts and the autostart entry and removes the old autostart entry. The old `%LOCALAPPDATA%\qiqi-render-station\` folder can be deleted by hand. If the old `.tools\remote\config.json` (under the root of the qiqi.help checkout) is copied to the same place in the new repository before the first start, the server address, the Shell allowlist and the other settings carry over, and the old `PROMO_*` settings are converted into a workspace.

## Configuration

The settings are stored in `.tools/remote/config.json` and edited in the window's Settings page.

### Server

Write the SSH address as `user@server`. The port is the server's SSH port; when empty, 22 is used. The station opens no tunnel until an address is set. Changing either reconnects the tunnel.

### Workspaces

Each workspace has:

| Item | Description |
|---|---|
| Name | The name the server uses to call its presets. When empty, the station uses the `name` in the workspace file, then the folder name. Letters, digits, `.`, `_` and `-` only; names must be unique. |
| Path | The folder on the device. |
| Settings the workspace file declares | After the path is saved, the Settings page lists the fields from the file's `env`. While a required field is empty, the workspace's presets are refused. |
| Other environment variables | One `NAME=value` per line, also passed to the workspace's jobs. |

Each workspace's presets are listed below it. The station rereads a workspace file when it changes; no restart is needed.

**Registering a workspace trusts its presets.** Presets run without approval. If a preset lets the caller upload a script and runs it, the caller can run any code on the device with the rights of the account the station runs under.

### This computer

These switches are on by default; turning one off undoes its effect:

- 自动更新 (Automatic updates): see "Automatic updates".
- 登录 Windows 后自动启动 (Start when signing in to Windows): visible under Startup apps in Task Manager.
- 桌面和开始菜单里放「渲染站」 (Shortcuts on the desktop and in the Start menu).

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
| `description` | Shown in the Settings page and in `cli.mjs status`. |

`command`, `cwd`, `env` and `collect` may use two placeholders: `{job}`, the job folder (`.tools/remote/job/` on the device, emptied before each job), and `{workspace}`, the workspace's path.

## Using the station

### Tray icon

The tray icon's color shows the state:

| Color | State |
|---|---|
| Green | Idle, waiting for jobs |
| Purple | Running a job |
| Yellow | Connecting |
| Red | Cannot log in to the server, or the station cannot start |
| Gray | Paused, or no server set |

Click the icon to open the window. The right-click menu has 打开渲染站 (Open), 暂停接单 (Pause; 继续接单, Resume, while paused), 重新连接 (Reconnect), 在浏览器里打开 (Open in browser), 查看日志 (View log) and 退出渲染站 (Quit). A notification appears when a job finishes.

### Window

The window is `station.html` in WebView2, without a system title bar; the minimize, close and drag controls are at the top of the page. The sidebar has four pages:

- 总览 (Overview): the state, today's counts, the last two minutes of CPU, memory and GPU load, and the recent jobs with their output.
- 输出 (Output): the files the jobs produced, kept on this device. Images and videos can be previewed (videos play on hover, click to enlarge, arrow keys to browse); other files open in their default program.
- 动态 (Activity): the connection's progress and the live output of ssh and the jobs.
- 设置 (Settings): see "Configuration" and "Shell permissions".

The same page is available in a browser at `http://127.0.0.1:7799`; append `#gallery`, `#feed` or `#settings` to open a page directly.

Lines of the form `frame 12/300` in a job's output are read as progress and shown on the Overview page's ring.

### State and logs

After the device wakes from sleep, loses the network, or the worker exits, the station reopens the tunnel and restarts the worker on its own. The log is `.tools/remote/station.log`.

While the tunnel is open, anyone who can log in to the server can run the device's presets. Pause the station (in the window or the tray menu) when it is not needed; pausing closes the tunnel.

## Submitting jobs

Run these on the server. `cli.mjs` finds the tunnel's port on its own; set `RENDER_STATION_PORT` to use only that port. Options must come before the target (the preset or the command).

```sh
node cli.mjs status [--json]
node cli.mjs run [--json] [--src <dir>] [--out <dir>] <workspace>/<preset> [args…]
node cli.mjs shell [--json] [--workspace <name>] [--cwd <dir>] [--timeout <s>] <command…>
```

### Device status

`status` shows whether the device is online and idle, and each workspace's presets and missing settings.

### Preset jobs

```sh
cd /path/to/project
node /path/to/render-station/cli.mjs run video/transcode --crf 23
```

- Everything after `<workspace>/<preset>` is passed to the preset as arguments.
- `--src`: the folder the preset's `upload` globs are matched in; defaults to the current folder. Uploads may total at most 48 MB.
- `--out`: where returned files are saved; defaults to `.tools/results/<time>/` in this repository. Returned files may total at most 128 MB.

### Shell jobs

```sh
node cli.mjs shell 'node --version'
node cli.mjs shell --workspace video --cwd input --timeout 600 'dir'
```

- `--workspace`: the workspace; defaults to the first one registered on the device.
- `--cwd`: the working directory within the workspace; defaults to its root.
- `--timeout`: time limit in seconds; default 600, maximum 7200.

On Windows the command runs in a non-interactive PowerShell that loads no profile; elsewhere, in `/bin/sh`. It gets the workspace's environment variables. Shell jobs bring no files and can use only files already on the device. A command not on the allowlist waits for manual approval on the device, for up to 5 minutes.

While the command runs, its output appears live on the Activity page. When it ends, the last 256 KiB of output and the exit code go back to the server. Commands are shown in the approval dialog and written to the log, so never put keys or passwords in them.

### JSON output

With `--json`, `cli.mjs` prints one JSON object to standard output:

| Field | Description |
|---|---|
| `ok` | Whether the job succeeded. |
| `exitCode` | The command's exit code; `null` if the command did not run. |
| `kind` | `"preset"` or `"shell"`. |
| `workspace`, `preset`, `args` | The preset job's workspace, preset and arguments. |
| `command` | The Shell job's command. |
| `seconds` | Elapsed time. |
| `outDir`, `files` | The folder of the returned files and each file's path. |
| `log` | The command's output (the last 256 KiB). |
| `error` | Why the job failed; `null` on success. |

`status --json` prints the device's details: `online`, `platform`, `busy`, `accepting`, `shell` (the Shell mode) and `workspaces` (each with `name`, `path`, `missing`, `presets`, and `error` if its file is invalid).

### Exit status

| Exit status | Meaning |
|---|---|
| The command's own | The command ran; 0 on success. |
| 1 | The job failed before running, for example an argument the preset does not accept, or a denied approval. |
| 2 | `cli.mjs` was used incorrectly. |
| 3 | No worker answered, or it is busy or paused. |

A command's own exit status can coincide with 1, 2 or 3; use `exitCode` in the `--json` output when the difference matters.

## Shell permissions

The station refuses Shell jobs by default. Enable them on the device under 设置 → Shell 权限 (Settings → Shell permissions); they start in auto mode.

### Auto mode

- The actual working directory, after resolving symbolic links, must be inside the chosen workspace.
- A command runs automatically when the full command and the working directory exactly match an allowlist entry. Nothing is allowed by interpreter or command prefix.
- Otherwise the request waits for approval in the station's window (a dialog appears while the window is open), with the choices 拒绝 (Deny), 仅本次允许 (Allow once) and 允许并加入白名单 (Allow and add to the allowlist). A request not approved within 5 minutes fails.
- The allowlist is stored in the device's `.tools/remote/config.json`; entries can be removed in the Settings page.

### YOLO mode

- To enable it: quit the running station; on Windows, right-click it and choose Run as administrator (elsewhere, run it as root); then turn on YOLO in the Settings page and confirm.
- The station checks that its process has administrator rights; then any command and any working directory are allowed. With no workspace registered, working directories are relative to the user's home folder.
- The mode is kept in memory only. Pausing, reconnecting or restarting returns to auto mode.

### Security boundaries

- The job protocol has no way to change the allowlist, switch modes or register workspaces. These happen only in the device's Settings page; the server cannot turn on YOLO mode through job parameters.
- This is an authorization mechanism, not an operating-system sandbox. An approved command can read and write files with all the rights of the station's account; the directory check constrains only the initial working directory.
- The allowlist records command text and does not pin the content of scripts the command uses. If a script changes, the same command still runs automatically.
- Presets do not go through the Shell allowlist; for the trust they carry, see "Workspaces".
- A pending command never runs after a denial, an approval timeout, or the submitter disconnecting.
- Turning off Shell permissions or pausing refuses further jobs and cancels pending requests and YOLO mode, but does not stop a command already running. When a command times out or its submitter disconnects, the station tries to end its process tree.
- Mode changes, pending requests, manual decisions, executed commands, working directories and results are written to the device's `.tools/remote/station.log`.

## Automatic updates

When enabled, the station checks one minute after starting and every 30 minutes after that, fast-forwarding to the current branch's upstream. A checkout made with `git clone` already has an upstream. The 现在检查 (Check now) button in the Settings page checks immediately.

The station does not update while the working tree has uncommitted changes or there are unpushed commits. If a job is running, it waits for the job to finish.

When the station's code changes, the station restarts itself; when `渲染站.exe` changes, the tray program replaces itself with the new version.

## Tray program

`渲染站.exe`, built from `exe/station.c`:

- When started from the repository, it copies itself and `WebView2Loader.dll` to `%LOCALAPPDATA%\render-station\` and runs from there, so the repository's exe is never locked and updates can replace it.
- Starts `station.mjs` in the background and restarts it whenever it exits.
- Puts the station, ssh and the jobs' processes in one job object, so they all end when it quits.
- Requires Node.js on the device.

## Running without the tray program

Register workspaces in `.tools/remote/config.json` (or once through the tray program), then run in two terminals:

```sh
node worker.mjs
ssh -N -R 7700:127.0.0.1:7700 -p <port> <user>@<server>
```

Run this way, there is no approval interface for Shell jobs, so only presets run.

## Known limitations

- One server works with one device.
- Each job is one synchronous HTTP request: if the submitter disconnects, including when the tunnel drops, the job is stopped.
- Uploads may total at most 48 MB and returned files at most 128 MB.

## Development

- Tests: `node --test`.
- Build `渲染站.exe`: `node exe/build.mjs`. It cross-compiles on Linux into the repository root and needs mingw-w64 (`x86_64-w64-mingw32-gcc`) and the WebView2 SDK (the NuGet package `Microsoft.Web.WebView2`) unpacked in `.tools/webview2/`.
- After changing anything in `exe/`, rebuild and commit `渲染站.exe` together with the sources.

## Files

| Path | Description |
|---|---|
| `cli.mjs` | The command-line tool for submitting jobs from the server. |
| `worker.mjs` | The worker: receives jobs, runs them and returns the results. |
| `workspace.mjs` | Reading and checking workspace files, globs, and presets' commands and output. |
| `shell.mjs` | Approval, allowlist and execution of Shell jobs. |
| `station.mjs` | The station's background process: manages the worker, the tunnel and the settings, and serves the window at `127.0.0.1:7799`. |
| `station.html` | The station's window. |
| `渲染站.exe` | The built tray program. |
| `WebView2Loader.dll` | The WebView2 loader the tray program's window needs. |
| `exe/` | The tray program's sources (`station.c`, `station.rc`, `station.manifest`) and its build script `build.mjs`. |
| `*.test.mjs` | Tests. |
| `.tools/` | Runtime data (`remote/config.json`, `remote/station.log`, `remote/job/`, `remote/out/`, `results/`) and the WebView2 SDK (`webview2/`); not under version control. |

## License

MIT; see `LICENSE`. The exception is `WebView2Loader.dll`, which is Microsoft's and is used under the Microsoft WebView2 license terms, not the MIT License.
