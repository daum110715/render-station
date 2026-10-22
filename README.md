# 渲染站

渲染站运行在一台 Windows 工作机上，通过反向 SSH 隧道接收 Linux 服务器 lemon 提交的任务。任务分两类：渲染 qiqi.help 宣传片的单帧、封面和预览片段，以及经工作机授权的 Shell 命令。

本仓库与 qiqi.help 相互独立，有各自的提交历史，不引用 qiqi.help 的代码。渲染所需的源码、素材和依赖从一份 qiqi.help 检出读取：工作机上由配置项 `PROMO_ROOT` 指定，lemon 上默认为 `/www/daum/qiqi.help`。

## 术语

| 术语 | 含义 |
|---|---|
| 工作机 | 运行渲染站的 Windows 电脑，目前为站长的电脑。 |
| lemon | 提交任务的 Linux 服务器，SSH 登录目标为 `lemon@23.251.32.150`，端口 22222。 |
| 渲染服务 | `worker.mjs`，监听工作机的 `127.0.0.1:7700`，负责执行任务。 |
| 渲染站 | 托盘程序 `渲染站.exe` 与后台进程 `station.mjs` 的合称，负责管理渲染服务、隧道和设置界面。 |
| 工作区 | Shell 任务可以使用的目录，取渲染站启动时的 `PROMO_ROOT`；未设置时为本仓库。 |

## 工作原理

1. 渲染站在工作机上启动渲染服务，并建立到 lemon 的反向隧道：`ssh -N -R 77xx:127.0.0.1:7700 -p 22222 lemon@23.251.32.150`。lemon 一侧的端口从 7700 开始；端口被失效的旧连接占用时，依次尝试下一个，最大为 7709。
2. lemon 上的 `ask.mjs` 探测这些端口，找到有响应的渲染服务后提交任务。
3. 渲染任务携带 lemon 上 qiqi.help 检出中的 `promo/render.mjs`、`lib/` 和 `stage/`，包括未提交的改动，压缩后约 20 KB。渲染服务在 `.tools/remote/job/` 中运行这份副本，不修改工作机上的 qiqi.help 检出。
4. 渲染结果传回 lemon，同时在工作机的 `.tools/remote/out/<时间>/` 中保留一份，最多保留最近 30 次任务的结果。

渲染服务一次只执行一个任务。单帧约数百 KB，半尺寸片段约数 MB。2026-10-16 实测：往返时延约 200 ms，工作机至 lemon 约 2.7 MB/s，lemon 至工作机约 1.9 MB/s。因此单次请求的耗时主要取决于往返时延，而非传输量。

## 环境要求

工作机：

- Windows，已安装 Node.js 和 Git。
- Chrome，以及带 libx264 的 ffmpeg。
- 一份已安装依赖的 qiqi.help 检出。
- 能以密钥登录 lemon（默认密钥或 ssh-agent 中的密钥）。在终端执行 `ssh -p 22222 lemon@23.251.32.150` 时不提示输入密码，即满足要求。
- WebView2 运行时。缺少时，窗口改用 Edge 的应用窗口打开。

lemon：Node.js，以及一份 qiqi.help 检出。

## 安装

在工作机上：

1. 克隆本仓库：`git clone https://github.com/daum110715/render-station.git`。
2. 在仓库根目录执行 `npm install`，安装窗口界面使用的两个字体包（`@fontsource-variable/outfit`、`lxgw-wenkai-webfont`）。
3. 双击仓库根目录下的 `渲染站.exe`。首次启动后，桌面和开始菜单中会出现「渲染站」快捷方式，此后可从快捷方式启动。
4. 在窗口的「设置」页填写配置项（见「配置」），然后点击「保存」。

`渲染站.exe` 必须与 `station.mjs` 位于同一目录，即仓库根目录。

从 qiqi.help 的 `promo/remote/` 迁移时，先退出旧实例，再按上述步骤从新位置启动。新实例会重新创建快捷方式和开机自启项。

## 配置

配置保存在 `.tools/remote/config.json`，通过窗口的「设置」页修改。

| 配置项 | 说明 | Windows 上必填 |
|---|---|---|
| `PROMO_ROOT` | 渲染使用的 qiqi.help 检出。`render.mjs` 的依赖、`.tools`、站点构建和素材均从此处读取。 | 是 |
| `PROMO_WORK` | 录像目录。 | 是 |
| `PROMO_SITE` | 站点构建目录。留空时使用 `PROMO_ROOT` 下的 `public\`。 | 否 |
| `PROMO_CHROME` | Chrome 可执行文件的路径。 | 是 |
| `PROMO_FFMPEG` | ffmpeg 可执行文件的路径，须带 libx264。 | 是 |
| `PROMO_PROFILES` | 临时浏览器配置目录。留空时使用 `PROMO_ROOT` 下的 `.tools\.profiles`。 | 否 |
| `PROMO_GPU` | 对应开关「用显卡画」，默认开启。关闭后使用软件绘制，速度明显下降。 | 否 |
| SSH 地址、端口 | 隧道的登录目标，默认为 `lemon@23.251.32.150` 和 `22222`。 | 否 |

在其他系统上，只有 `PROMO_ROOT` 和 `PROMO_WORK` 为必填项。必填项缺失时，任务会失败。

保存后，隧道重新连接。修改 `PROMO_ROOT` 后须重启渲染站，因为工作区在启动时确定。

「这台电脑上」一组开关，默认均为开启，关闭即撤销对应的设置：

- 「自动更新」：见「自动更新」。
- 「登录 Windows 后自动启动」：开启后可在任务管理器的「启动应用」中看到。
- 「桌面和开始菜单里放『渲染站』」。

## 使用

### 托盘图标

托盘图标的颜色表示当前状态：

| 颜色 | 状态 |
|---|---|
| 绿色 | 空闲，等待任务 |
| 紫色 | 正在执行任务 |
| 黄色 | 正在连接 |
| 红色 | 无法登录 lemon，或渲染站无法启动 |
| 灰色 | 已暂停接单 |

单击图标打开窗口。右键菜单包括「打开渲染站」「暂停接单」（暂停后为「继续接单」）「重新连接」「在浏览器里打开」「查看日志」和「退出渲染站」。任务完成时，系统弹出通知。

### 窗口

窗口由 WebView2 加载 `station.html`，不使用系统标题栏，最小化、关闭和拖动的控件位于页面顶部。左侧导航包含四页：

- 「总览」：运行状态、当日统计、最近两分钟的处理器、内存和显卡占用，以及最近的任务及其输出。
- 「画廊」：本机保留的单帧、封面和片段。鼠标悬停时播放片段，单击查看大图，左右方向键切换。
- 「动态」：连接过程，以及 ssh 和 `render.mjs` 的实时输出。
- 「设置」：见「配置」和「Shell 权限」。

同一页面也可在浏览器中访问：`http://127.0.0.1:7799`。在地址后加 `#gallery`、`#feed` 或 `#settings` 可直接打开对应页面。

### 运行状态与日志

工作机从睡眠中唤醒、网络中断或渲染服务退出后，渲染站会自动重建隧道并重启服务。运行日志位于 `.tools/remote/station.log`。

隧道建立期间，任何能登录 lemon 的用户都可以让工作机运行本仓库的代码。不使用时，应在窗口或托盘菜单中选择「暂停接单」。暂停后隧道关闭，lemon 无法提交任务。

## 提交任务

以下命令在 lemon 上执行。`ask.mjs` 自动查找隧道所在的端口。

### 渲染任务

参数与 qiqi.help 的 `promo/render.mjs` 相同：

```sh
node /www/daum/render-station/ask.mjs --stills 19.9,20.3        # 单帧，全尺寸；加 --preview 为半尺寸
node /www/daum/render-station/ask.mjs --cover                   # 两张封面
node /www/daum/render-station/ask.mjs --from 13.49 --to 21.45   # 片段，固定为半尺寸、15 fps
```

录像尚未录全时，加 `--partial`。结果保存在 `/www/daum/render-station/.tools/.scratch/<时间>/`。

`ask.mjs` 读取以下环境变量：

- `PROMO_ROOT`：提供渲染源码的 qiqi.help 检出，默认为 `/www/daum/qiqi.help`。
- `PROMO_REMOTE`：隧道端口。设置后不再自动探测。

渲染服务只接受单帧、封面和半尺寸片段。按站长 2026-10-16 的约定，qiqi.help 正式上线前不渲染最高分辨率和最高帧率的视频；成片须在工作机上直接运行 `render.mjs`。

### Shell 任务

```sh
node /www/daum/render-station/ask.mjs --shell 'node --version'
node /www/daum/render-station/ask.mjs --shell 'node promo/capture/rec.mjs archive' --cwd . --timeout 600
```

- `--cwd`：工作机上的工作目录，默认为工作区。
- `--timeout`：执行时限，单位为秒，默认 600，上限 7200。

命令在 Windows 上由非交互、不加载配置文件的 PowerShell 执行，在其他系统上由 `/bin/sh` 执行。Shell 任务不同步源码，只能使用工作机上已有的文件；qiqi.help 的录像脚本及其参数以该仓库的 `promo/capture/clips/` 为准。

执行期间，输出实时显示在「动态」页。执行结束后，输出的最后 256 KiB 和退出码返回 lemon，托盘图标照常弹出通知。

命令会显示在审批窗口中并写入日志，因此不得在命令中包含密钥或密码。

## Shell 权限

渲染站默认不接受 Shell 任务。须在工作机的「设置 → Shell 权限」中开启，开启后为 auto 模式。

### auto 模式

- 实际工作目录（解析符号链接后）必须位于工作区内。
- 完整命令和工作目录与白名单中的某一条精确匹配时，自动执行。不按解释器或命令前缀放行。
- 未匹配时，工作机弹出审批窗口，可选择「拒绝」「仅本次允许」或「允许并加入白名单」。5 分钟内未获批准的任务失败。
- 白名单保存在工作机的 `.tools/remote/config.json` 中，可在设置页删除条目。

### YOLO 模式

- 开启步骤：退出正在运行的渲染站；在 Windows 上右键选择「以管理员身份运行」（其他系统须以 root 运行）；在设置页开启 YOLO 并确认。
- 渲染站检查当前进程是否具有管理员权限，通过后允许任意命令和任意工作目录。
- 该模式只保存在内存中。暂停接单、重新连接或重启后，恢复为 auto 模式。

### 安全边界

- 任务协议不提供修改白名单或切换模式的接口。这些操作只能在工作机的设置页完成，lemon 无法通过任务参数开启 YOLO 模式。
- 该机制是授权机制，不是操作系统级沙箱。获准的命令可以读写文件，拥有渲染站运行账户的全部权限；目录检查只约束初始工作目录。
- 白名单记录的是命令文本，不固定命令所引用脚本的内容。脚本修改后，同一条命令仍会自动执行。
- 渲染任务本身会运行 lemon 发送的 JavaScript，属于已信任的代码通道，不受 Shell 白名单约束。
- 拒绝、审批超时或提交方断开连接时，待审批的命令不会执行。
- 关闭 Shell 权限或暂停接单后，后续任务被拒绝，待审批的请求和 YOLO 模式被撤销，已在运行的命令不会被中止。执行超时或提交方断开连接时，渲染站会尝试结束该命令的进程树。
- 模式切换、待审批的请求、人工决定、执行的命令、工作目录和执行结果均记录在工作机的 `.tools/remote/station.log` 中。

### Agent 使用授权

站长已于 2026-10-17 授权：agent 可以通过工作机上已批准的白名单，或工作机本地开启的 YOLO 模式提交 Shell 任务，无需因使用远程 Shell 而逐次请求许可。具体的工作范围以站长交代的任务为准。

## 自动更新

开启后，渲染站在启动 1 分钟后检查一次，此后每 30 分钟检查一次，以快进方式合并当前分支的上游分支。通过 `git clone` 得到的检出已设置上游分支。也可以在设置页点击「现在检查」手动检查。

以下情况不更新：工作树中有未提交的改动，或存在未推送的提交。有任务正在执行时，等任务完成后再更新。

更新涉及渲染站的代码时，渲染站自动重启；`渲染站.exe` 更新后，托盘程序自动替换为新版本。

## 托盘程序

`渲染站.exe` 的源码为 `exe/station.c`，其行为如下：

- 从仓库启动时，先将自身和 `WebView2Loader.dll` 复制到 `%LOCALAPPDATA%\qiqi-render-station\`，再从该位置运行。因此仓库中的 exe 不会被占用，更新时可以直接替换。
- 在后台启动 `station.mjs`，进程退出后自动重新启动。
- 将渲染站及其启动的 ssh、Chrome 和 ffmpeg 放入同一个作业对象，退出时一并结束。
- 需要工作机已安装 Node.js。

## 不使用托盘程序运行

先手动设置环境变量：至少 `PROMO_ROOT` 和 `PROMO_WORK`，Windows 上还需 `PROMO_CHROME` 和 `PROMO_FFMPEG`。然后在两个终端中分别运行：

```sh
node worker.mjs
ssh -N -R 7700:127.0.0.1:7700 -p 22222 lemon@23.251.32.150
```

## 开发

- 测试：`node shell.test.mjs`。
- 编译 `渲染站.exe`：`node exe/build.mjs`，在 Linux 上交叉编译，输出到仓库根目录。需要 mingw-w64（`x86_64-w64-mingw32-gcc`），以及解压到 `.tools/webview2/` 的 WebView2 SDK（NuGet 包 `Microsoft.Web.WebView2`）。
- 修改 `exe/` 中的文件后，须重新编译，并将 `渲染站.exe` 与源码一并提交。

## 文件

| 路径 | 说明 |
|---|---|
| `worker.mjs` | 渲染服务：接收任务，在 `.tools/remote/job/` 中执行，并返回结果。 |
| `ask.mjs` | 在 lemon 上提交任务的命令行工具。 |
| `shell.mjs` | Shell 任务的审批、白名单和执行。 |
| `shell.test.mjs` | `shell.mjs` 的测试。 |
| `station.mjs` | 渲染站的后台进程：管理渲染服务、隧道和配置，并在 `127.0.0.1:7799` 上提供窗口页面。 |
| `station.html` | 渲染站的窗口页面。 |
| `渲染站.exe` | 托盘程序的编译产物。 |
| `WebView2Loader.dll` | 托盘程序窗口所需的 WebView2 加载器。 |
| `exe/` | 托盘程序的源码（`station.c`、`station.rc`、`station.manifest`）和编译脚本 `build.mjs`。 |
| `.tools/` | 运行时数据（`remote/config.json`、`remote/station.log`、`remote/job/`、`remote/out/`）和 WebView2 SDK（`webview2/`），不纳入版本控制。 |

## 许可

本仓库以 MIT 许可证发布，见 `LICENSE`。`WebView2Loader.dll` 除外：该文件由 Microsoft 提供，按 Microsoft WebView2 的许可条款使用，不适用 MIT 许可证。
