# Command-line manual

English | [中文](cli.zh-CN.md)

`render-station` is the command-line tool on the server. It submits jobs to the device and manages the device's workspaces. Its short name is `rs`. For the terms used here (server, device, workspace, preset) and for setting up the device, see the [README](../README.md).

## Installation

The server needs Node.js 18 or later and a checkout of this repository. Run this in the checkout:

```sh
npm link
```

This installs the commands `render-station` and `rs` into npm's global `bin` folder; that folder must be on `PATH`. The commands keep pointing at the checkout, so `git pull` updates them too. Without `npm link`, run `node /path/to/render-station/cli.mjs` instead; it behaves the same.

## Commands

| Command | Short form | Purpose |
|---|---|---|
| `status` | `st` | Whether the device is reached, the jobs running and waiting, and the workspaces. |
| `presets` | | The workspaces' presets and the arguments they take. |
| `run` | | Run a preset and fetch the files it makes. |
| `shell` | `sh` | Run a command in a workspace. |
| `workspace` | `ws` | List the workspaces, or add, change or remove one. |
| `ls` | | List a folder on the device, or its drives. |
| `help` | | Show what the commands do. |

## Common rules

- `--json`: print one JSON object, the result, to standard output, and nothing else. Every command takes it.
- `-h` and `--help`: show the command's help. `rs help <command>` does the same.
- Option placement: for `run` and `shell`, options come before the preset or the command, because what follows is passed on as arguments or as the command. Other commands take options anywhere. `--` ends the options.
- Progress messages, such as a job's place in the queue or a wait for approval, go to standard error and are left out with `--json`.
- The device is reached through the tunnel on ports 7700–7709 of the server. The command tries them in turn and uses the first one where the station answers. Set `RENDER_STATION_PORT` to use only that port.
- Paths on the device are full paths. Write them with forward slashes, as in `F:/projects/site`, or quote them when they use backslashes: `'F:\projects\site'`.

## status

```sh
rs status [--json]
```

Shows whether the device is reached, how many jobs run and wait there and how many may run at once, whether it is paused, the Shell mode, whether the server may manage workspaces, and each workspace with its presets and the settings it still lacks.

`--json` prints:

| Field | Description |
|---|---|
| `online` | Whether the device was reached. |
| `port` | The port it was reached on. |
| `protocol`, `features` | The protocol version and the features the station supports (see "Compatibility"). |
| `platform` | The device's operating system, such as `win32`. |
| `accepting` | `false` while the station is paused. |
| `limit` | How many jobs may run at once. |
| `running` | The jobs running, each with `id`, `kind` and its preset or command. |
| `queued` | How many jobs wait. |
| `shell` | The Shell mode: `disabled`, `auto` or `yolo`. |
| `manage` | Whether the server may manage workspaces: `off`, `ask` or `allow`. |
| `workspaces` | Each workspace's `name`, `path`, `missing` (settings not yet filled in), `parallel` and `presets`, and `error` if its workspace file is invalid. |

## presets

```sh
rs presets [<workspace>] [--json]
```

Lists the presets of every workspace, or of one workspace. For each preset it shows the description, the arguments it accepts (each argument must match one of the listed patterns in full), the files a job brings from the server, and the time limit.

`--json` prints `ok` and `presets`, a list in which each preset has `workspace`, `name`, `description`, `args`, `upload` and, if it has one, `timeout`.

## run

```sh
rs run [--src <dir>] [--out <dir>] [--json] <workspace>/<preset> [args…]
```

Runs a preset on the device and waits for it to end.

- Everything after `<workspace>/<preset>` is passed to the preset as arguments. The device refuses arguments the preset does not accept.
- `--src`: the folder in which the preset's `upload` globs are matched; defaults to the current folder. The files brought may total at most 48 MB.
- `--out`: where the returned files are saved; defaults to `.tools/results/<time>/` in the render-station checkout. Returned files may total at most 128 MB.
- When the device already runs as many jobs as it allows, the job waits in the queue and the command reports how many jobs are ahead. Interrupting the command, or losing the connection, cancels the job, whether it is waiting or running.
- The command prints the last 20 lines of the job's output, the paths of the returned files and the elapsed time.

```sh
cd ~/site
rs run site/build 1080p
```

`--json` prints:

| Field | Description |
|---|---|
| `ok` | Whether the job succeeded. |
| `exitCode` | The job's exit code; `null` if it did not run. |
| `kind` | `"preset"`. |
| `workspace`, `preset`, `args` | What was run. |
| `port`, `seconds` | The port used and the elapsed time. |
| `outDir`, `files` | The folder of the returned files and each file's path. |
| `log` | The job's output (the last 256 KiB). |
| `error` | Why the job failed; `null` on success. |

## shell

```sh
rs shell [--workspace <name>] [--cwd <dir>] [--timeout <s>] [--json] <command…>
```

Runs a command on the device and prints its whole output and its exit code. The device's owner must have enabled Shell; see "Shell permissions" in the README.

- `--workspace`: the workspace to run in; defaults to the first one registered.
- `--cwd`: a folder within the workspace, relative to its root; defaults to the root.
- `--timeout`: time limit in seconds; default 600, maximum 7200.
- On Windows the command runs in a non-interactive PowerShell that loads no profile. It gets the workspace's settings as environment variables. No files are brought along.
- A command not on the device's allowlist waits up to 5 minutes for the owner's approval; the command then reports that it is waiting.
- Commands are shown in the approval dialog and written to the device's log. Never put keys or passwords in them.

```sh
rs sh --workspace site git status
rs sh --workspace site --cwd assets --timeout 60 'Get-ChildItem -Recurse | Measure-Object'
```

`--json` prints the same fields as `run`, with `kind` set to `"shell"` and `command` in place of `preset` and `args`.

## workspace

```sh
rs workspace [list] [--json]
rs workspace add <name> <path> [--create] [--env NAME=value …] [--json]
rs workspace set <name> [--path <path> [--create]] [--env NAME=value …] [--unset NAME …] [--json]
rs workspace remove <name> [--json]
```

Without an action, or with `list`, lists the workspaces as `status` does. The other actions change them:

- `add` registers a folder as a workspace. When the folder holds an old station's `.tools/remote/config.json`, the settings there that the workspace file declares are imported.
- `set` changes a workspace's path or settings. `--env NAME=` (an empty value) clears a setting, as `--unset NAME` does.
- `remove` unregisters a workspace. Its folder is left as it is.
- `--create`: make the folder if it does not exist yet. Without it, a missing folder is an error.
- `--env` and `--unset` may be given more than once.

Whether a change needs approval depends on the device's setting 服务器管理工作区 (Server manages workspaces); see "Approvals".

```sh
rs ws add site F:/projects/site
rs ws add scratch F:/scratch --create
rs ws set site --env FFMPEG=C:/ffmpeg/bin/ffmpeg.exe
rs ws remove scratch
```

Settings are shown in the approval dialog and written to the device's log. Never pass keys or passwords with `--env`.

`--json` prints `ok`, `action`, `workspace` (its `name`, `path`, `missing` and `presets` after the change; `null` after a removal), `imported` (the names of the settings imported), `created` (the folder made, or `null`) and, on failure, `error`. `list --json` prints `ok` and `workspaces`, as in `status --json`.

## ls

```sh
rs ls [<path>] [--json]
```

Lists a folder on the device: the name, size and time of last change of each file and folder in it. File contents are never read. Without a path, it lists the device's drives.

- Folders come first, then files, each in name order. At most 1000 entries are shown; the rest are counted.
- Folders inside a registered workspace are listed without approval. Other folders depend on 服务器管理工作区; see "Approvals".

```sh
rs ls
rs ls F:/
rs ls 'F:\projects'
```

`--json` prints `ok`, `path` (the folder in full; `null` for the drive list), `entries` (each with `name`, `type` (`"folder"` or `"file"`), `size` in bytes (`null` for folders) and `modified` in milliseconds since 1970) and `more` (how many entries were left out).

## help

```sh
rs help [<command>]
```

Shows the list of commands, or what one command does, its options and examples.

## Approvals

The device's setting 服务器管理工作区 (Server manages workspaces) decides what `workspace` and `ls` may do:

| Setting | `workspace` add, set, remove | `ls` |
|---|---|---|
| 关闭 (Off) | Refused. | Refused. |
| 需要审批 (Ask, the default) | Each change waits for approval. | Folders in a registered workspace: listed at once. Others: each request waits for approval. |
| 无需审批 (Allow) | Made at once. | Listed at once. |

- A request waiting for approval appears as a dialog in the device's window, and the tray icon shows a notification that opens the window when clicked. The command reports `waiting for the owner's approval on the device` and waits up to 5 minutes. A denial, a timeout or an interrupted command means the request has no effect.
- When the owner approves listing a folder, that folder and everything under it can be listed again for 10 minutes without another approval. Approving the drive list covers the drive list only. Changing the setting, pausing the station or reconnecting closes these windows.
- Requests and the folders listed outside workspaces appear on the device's Activity page and in its log.

## Exit status

| Exit status | Meaning |
|---|---|
| 0 | Done. |
| The job's own | A job ran and failed. |
| 1 | The request failed without running: an argument the preset does not accept, a denied or expired approval, a refused workspace change, a folder that cannot be listed, a station too old for the command. |
| 2 | The command was used incorrectly. |
| 3 | The device was not reached, the station is paused, or too many jobs already wait. |

A job's own exit status can coincide with 1, 2 or 3. When the difference matters, use `exitCode` in the `--json` output.

## Compatibility

The command and the station on the device must speak the same protocol version; otherwise every command reports `protocol mismatch`. Within a version, the station lists its features in `status --json`. A command that needs a feature the device lacks, such as `ls` or `--create`, reports that the station is too old; it updates itself, or the owner can click 立即检查 (Check now) in its Settings page.

## Typical tasks

Register a project folder on the device and see what it offers:

```sh
rs ls                     # the drives
rs ls F:/                 # needs one approval; folders under F:/ are then open for 10 minutes
rs ls F:/projects
rs ws add site F:/projects/site
rs presets site
```

Run a preset from a script and read its result:

```sh
rs run --json --src ~/site site/build 1080p > result.json
```

Check that the device is ready before submitting:

```sh
rs status --json | jq '.online and .accepting'
```
