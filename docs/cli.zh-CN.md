# 命令行手册

[English](cli.md) | 中文

`render-station` 是服务器上的命令行工具，用于向设备提交任务和管理设备上的工作区，简称 `rs`。服务器、设备、工作区、预设任务等术语，以及设备的安装和配置，见 [README](../README.zh-CN.md)。

## 安装

服务器需要 Node.js 18 或更高版本和本仓库的克隆。在仓库目录中执行：

```sh
npm link
```

该命令把 `render-station` 和 `rs` 两个命令安装到 npm 的全局 `bin` 目录，该目录须在 `PATH` 中。命令始终指向这份克隆，`git pull` 后命令随之更新。不执行 `npm link` 时，可改用 `node /path/to/render-station/cli.mjs`，用法相同。

## 命令一览

| 命令 | 简写 | 用途 |
|---|---|---|
| `status` | `st` | 查看设备是否在线、正在运行和排队的任务，以及各工作区。 |
| `presets` | | 查看各工作区的预设任务及其接受的参数。 |
| `run` | | 运行预设任务，并取回其生成的文件。 |
| `shell` | `sh` | 在工作区中执行命令。 |
| `workspace` | `ws` | 列出工作区，或添加、修改、移除工作区。 |
| `ls` | | 列出设备上某个文件夹的内容，或列出设备的磁盘。 |
| `clip` | | 读取设备上复制的内容，或写入设备的剪贴板。 |
| `help` | | 查看命令说明。 |

## 通用规则

- `--json`：只在标准输出打印一个 JSON 对象，即执行结果。所有命令都支持。
- `-h`、`--help`：显示该命令的说明，与 `rs help <命令>` 相同。
- 选项位置：`run` 和 `shell` 的选项必须写在预设任务或命令之前，因为其后的内容会作为参数或命令原样传递。其他命令的选项可以写在任意位置。`--` 表示选项到此结束。
- 过程提示（例如任务在队列中的位置、正在等待审批）输出到标准错误；加 `--json` 时不输出。
- 命令通过隧道连接设备，依次尝试服务器的 7700–7709 端口，使用第一个有渲染站响应的端口。设置环境变量 `RENDER_STATION_PORT` 时只使用该端口。
- 设备上的路径须写完整路径。可以用正斜杠，例如 `F:/projects/site`；使用反斜杠时须加引号，例如 `'F:\projects\site'`。

## status

```sh
rs status [--json]
```

显示设备是否在线、正在运行和排队的任务数、同时运行的任务数上限、是否已暂停、Shell 模式、是否允许服务器管理工作区，以及各工作区的预设任务和尚未填写的设置。

加 `--json` 时输出：

| 字段 | 说明 |
|---|---|
| `online` | 是否连接到设备。 |
| `port` | 使用的端口。 |
| `protocol`、`features` | 协议版本和渲染站支持的功能（见「兼容性」）。 |
| `platform` | 设备的操作系统，例如 `win32`。 |
| `accepting` | 渲染站暂停接收任务时为 `false`。 |
| `limit` | 同时运行的任务数上限。 |
| `running` | 正在运行的任务，每项包括 `id`、`kind` 以及预设任务或命令。 |
| `queued` | 排队的任务数。 |
| `shell` | Shell 模式：`disabled`、`auto` 或 `yolo`。 |
| `manage` | 是否允许服务器管理工作区：`off`、`ask` 或 `allow`。 |
| `workspaces` | 每个工作区的 `name`、`path`、`missing`（尚未填写的设置）、`parallel`、`presets`，以及工作区文件无效时的 `error`。 |

## presets

```sh
rs presets [<工作区>] [--json]
```

列出所有工作区或指定工作区的预设任务。每个预设任务显示说明、接受的参数（每个参数必须完整匹配所列的某个模式）、任务从服务器带上的文件，以及执行时限。

加 `--json` 时输出 `ok` 和 `presets`。`presets` 为列表，每项包括 `workspace`、`name`、`description`、`args`、`upload`，有时限时还包括 `timeout`。

## run

```sh
rs run [--src <目录>] [--out <目录>] [--json] <工作区>/<预设任务> [参数…]
```

在设备上运行预设任务，并等待其结束。

- `<工作区>/<预设任务>` 之后的全部内容作为预设任务的参数。预设不接受的参数会被设备拒绝。
- `--src`：按预设的 `upload` 收集文件的目录，默认为当前目录。上传总量不超过 48 MB。
- `--out`：传回的文件保存的目录，默认为 render-station 仓库中的 `.tools/results/<时间>/`。传回总量不超过 128 MB。
- 设备上运行的任务数已达上限时，任务进入队列，命令会提示前面还有几个任务。中断命令或连接断开时，任务被取消，无论是在排队还是正在运行。
- 命令输出任务的最后 20 行输出、传回文件的路径和耗时。

```sh
cd ~/site
rs run site/build 1080p
```

加 `--json` 时输出：

| 字段 | 说明 |
|---|---|
| `ok` | 任务是否成功。 |
| `exitCode` | 任务的退出码；任务没有运行时为 `null`。 |
| `kind` | `"preset"`。 |
| `workspace`、`preset`、`args` | 运行的工作区、预设任务和参数。 |
| `port`、`seconds` | 使用的端口和耗时。 |
| `outDir`、`files` | 传回文件所在的目录和各文件的路径。 |
| `log` | 任务的输出（最后 256 KiB）。 |
| `error` | 失败原因；成功时为 `null`。 |

## shell

```sh
rs shell [--workspace <名称>] [--cwd <目录>] [--timeout <秒>] [--json] <命令…>
```

在设备上执行命令，输出命令的全部输出和退出码。设备上须已开启 Shell，见 README 的「Shell 权限」。

- `--workspace`：执行命令的工作区，默认为设备上登记的第一个工作区。
- `--cwd`：工作区中的文件夹，相对于工作区根目录，默认为根目录。
- `--timeout`：执行时限，单位为秒，默认 600，上限 7200。
- 在 Windows 上，命令由非交互、不加载配置文件的 PowerShell 执行，并以环境变量的形式获得该工作区的设置。Shell 任务不带上任何文件。
- 输出一律为 UTF-8。命令以非零退出码结束时，任务的退出码与之相同；最后一条命令出错但没有退出码时（例如 PowerShell 命令出错），退出码为 1。
- 不在设备白名单中的命令须等待设备上的审批，最长 5 分钟；此时命令会提示正在等待审批。
- 命令会显示在审批窗口中并写入设备的日志，因此不得在命令中包含密钥或密码。

```sh
rs sh --workspace site git status
rs sh --workspace site --cwd assets --timeout 60 'Get-ChildItem -Recurse | Measure-Object'
```

加 `--json` 时输出的字段与 `run` 相同，其中 `kind` 为 `"shell"`，并以 `command` 代替 `preset` 和 `args`。

## workspace

```sh
rs workspace [list] [--json]
rs workspace add <名称> <路径> [--create] [--env 名称=值 …] [--json]
rs workspace set <名称> [--path <路径> [--create]] [--env 名称=值 …] [--unset 名称 …] [--json]
rs workspace remove <名称> [--json]
```

不带操作或使用 `list` 时，按 `status` 的格式列出工作区。其他操作用于变更工作区：

- `add`：把文件夹登记为工作区。该文件夹中留有旧版渲染站的 `.tools/remote/config.json` 时，其中工作区文件声明的设置会自动导入。
- `set`：修改工作区的路径或设置。`--env 名称=`（值为空）与 `--unset 名称` 相同，都会清除该设置。
- `remove`：取消登记工作区，不改动其文件夹。
- `--create`：文件夹不存在时新建。不加此选项时，文件夹不存在会报错。
- `--env` 和 `--unset` 可以重复使用。

变更是否需要审批，由设备上的「服务器管理工作区」决定，见「审批」。

```sh
rs ws add site F:/projects/site
rs ws add scratch F:/scratch --create
rs ws set site --env FFMPEG=C:/ffmpeg/bin/ffmpeg.exe
rs ws remove scratch
```

设置值会显示在审批窗口中并写入设备的日志，因此不得通过 `--env` 传递密钥或密码。

加 `--json` 时输出 `ok`、`action`、`workspace`（变更后的 `name`、`path`、`missing`、`presets`，移除时为 `null`）、`imported`（导入的设置名）、`created`（新建的文件夹，未新建时为 `null`），以及失败时的 `error`。`list --json` 输出 `ok` 和 `workspaces`，格式与 `status --json` 相同。

## ls

```sh
rs ls [<路径>] [--json]
```

列出设备上某个文件夹的内容，包括其中各文件和文件夹的名称、大小和修改时间，不读取文件内容。不带路径时列出设备的磁盘。

- 先列文件夹，再列文件，各按名称排序。最多显示 1000 项，其余只给出数量。
- 已登记工作区内的文件夹无需审批即可列出。其他文件夹按「服务器管理工作区」的设置处理，见「审批」。

```sh
rs ls
rs ls F:/
rs ls 'F:\projects'
```

加 `--json` 时输出 `ok`、`path`（文件夹的完整路径，列出磁盘时为 `null`）、`entries`（每项包括 `name`、`type`（`"folder"` 或 `"file"`）、以字节为单位的 `size`（文件夹为 `null`）、以 1970 年起的毫秒数表示的 `modified`）和 `more`（未列出的项数）。

## clip

```sh
rs clip [--json]
rs clip ls [--json]
rs clip set [<文字…>] [--file <路径>] [--json]
```

设备上开启「同步剪贴板」后，在设备上复制的文字和图片会自动写入服务器的 `~/.render-station/clipboard/`，见 README 的「剪贴板同步」。

- `rs clip`：输出最新的一份。文字原样输出；图片输出其 PNG 文件的路径。
- `rs clip ls`：列出最近 50 份，从新到旧，包括时间、类型、大小、路径和文字的开头。
- 以上两个命令只读取服务器上的文件，不需要设备在线。
- `rs clip set`：写入设备的剪贴板，内容依次取自命令后的文字、`--file` 指定的文件或标准输入。PNG、JPEG、GIF、BMP 和 TIFF 文件作为图片写入，其余内容作为 UTF-8 文字写入；上限 20 MB。以 `--` 开头的文字须放在 `--` 之后。写入的内容不会再同步回服务器。

```sh
rs clip
rs clip ls
git diff | rs clip set
rs clip set --file shot.png
```

### 作为 xclip 使用

服务器上的程序（例如 Claude Code 粘贴图片时）通过 `xclip` 读写剪贴板。把 `rs` 链接为 `xclip`，并放在 PATH 中靠前的文件夹里：

```sh
ln -s "$(command -v rs)" ~/.local/bin/xclip
```

此后，这些程序读到的是设备上最近复制的内容（与 `rs clip` 相同），写入的内容则通过 `rs clip set` 写入设备的剪贴板。这样，在设备上复制的图片可以直接粘贴到服务器上的 Claude Code 中。Claude Code 在 Linux 上用 Ctrl+V 粘贴图片，而 Windows 终端会把 Ctrl+V 留给自己粘贴文字；可以在服务器的 `~/.claude/keybindings.json` 中把 Alt+V 也绑定到粘贴图片：`{"bindings": [{"context": "Chat", "bindings": {"alt+v": "chat:imagePaste"}}]}`。支持 xclip 的 `-selection`、`-target`（含 `TARGETS`）、`-out`、`-in`、`-filter` 和 `-rmlastnl` 选项，以及它们的缩写。不要在有图形界面的机器上这样做，否则会盖住真正的 xclip。

加 `--json` 时，`rs clip` 输出 `ok`、`path`、`type`（`"text"` 或 `"image"`）、以字节为单位的 `size`、以 1970 年起的毫秒数表示的 `at`，文字另有 `text`；`rs clip ls` 输出 `ok` 和 `entries`，各项字段同上（不含 `text`）；`rs clip set` 输出 `ok`、`type` 和 `size`。

## help

```sh
rs help [<命令>]
```

显示命令列表，或某个命令的用途、选项和示例。

## 审批

`workspace` 和 `ls` 能做什么，由设备上的「服务器管理工作区」决定：

| 设置 | `workspace` 的添加、修改、移除 | `ls` |
|---|---|---|
| 关闭 | 拒绝。 | 拒绝。 |
| 需要审批（默认） | 每项变更都须等待审批。 | 已登记工作区内的文件夹直接列出；其他文件夹每次都须等待审批。 |
| 无需审批 | 直接执行。 | 直接列出。 |

- 等待审批的请求以对话框形式显示在设备的窗口中，托盘图标同时弹出通知，单击即可打开窗口。命令会提示 `waiting for the owner's approval on the device`，最长等待 5 分钟。请求被拒绝、超时或命令被中断时，请求不产生任何效果。
- 批准查看某个文件夹后，10 分钟内再次列出该文件夹及其下的任何文件夹都无需再次批准。批准查看磁盘列表只对磁盘列表本身有效。修改该设置、暂停接收任务或重新连接后，这些已批准的文件夹全部失效。
- 请求，以及在工作区以外列出的文件夹，都会显示在设备的「动态」页并写入日志。

## 退出码

| 退出码 | 含义 |
|---|---|
| 0 | 执行成功。 |
| 任务自身的退出码 | 任务已运行，但失败。 |
| 1 | 请求在运行前失败：参数不被预设接受、审批被拒绝或超时、工作区变更被拒绝、文件夹无法列出，或设备上的渲染站版本过旧。 |
| 2 | 命令的用法错误。 |
| 3 | 无法连接设备，或渲染站已暂停、排队的任务已满。 |

任务自身的退出码可能与 1、2、3 重合；需要区分时，使用 `--json` 输出中的 `exitCode`。

## 兼容性

命令与设备上的渲染站须使用相同的协议版本，否则所有命令都会报告 `protocol mismatch`。在同一协议版本内，渲染站在 `status --json` 中列出其支持的功能。命令需要的功能（例如 `ls` 或 `--create`）设备不支持时，会提示设备上的渲染站版本过旧；渲染站会自动更新，也可以在其「设置 → 更新与关于」页单击「立即检查」。

## 常用操作

在设备上登记项目文件夹，并查看它提供的预设任务：

```sh
rs ls                     # 列出磁盘
rs ls F:/                 # 须批准一次；此后 10 分钟内，F:/ 下的文件夹无需再次批准
rs ls F:/projects
rs ws add site F:/projects/site
rs presets site
```

在脚本中运行预设任务并读取结果：

```sh
rs run --json --src ~/site site/build 1080p > result.json
```

提交任务前检查设备是否就绪：

```sh
rs status --json | jq '.online and .accepting'
```
