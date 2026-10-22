# 渲染站

站长的 Windows 电脑上的渲染站：后台开着渲染服务（`worker.mjs`，只听本机的 127.0.0.1:7700）和到 lemon 的反向隧道。lemon 上的 `ask.mjs` 把 qiqi.help 宣传片的渲染交给它，站长授权的远程 Shell 任务也从这里接。

它和 qiqi.help 完全分离：这是独立的仓库，有自己的历史，不依赖 qiqi.help 里的代码。渲染要用的源码（`promo/render.mjs`、`lib/`、`stage/`）、素材和 `node_modules` 不在这里，取自一份 qiqi.help 检出：站长电脑上由设置里的 `PROMO_ROOT` 指定，lemon 上默认是 `/www/daum/qiqi.help`。

## 安装

- `npm install`：只装两个字体包（`@fontsource-variable/outfit`、`lxgw-wenkai-webfont`），站点字体从 `node_modules` 供给。
- 编译 `渲染站.exe`：`node exe/build.mjs`，要 lemon 上的 mingw-w64（`x86_64-w64-mingw32-gcc`），还要 `.tools/webview2/` 里解开的 WebView2 SDK（NuGet 的 `Microsoft.Web.WebView2`）。
- 测试：`node shell.test.mjs`。

## 在站长电脑上渲染

lemon 上改了舞台，要看渲染结果时，交给站长电脑去渲：

- **站长电脑上：** 双击 `渲染站.exe`，打开「渲染站」，不弹终端；第一次打开后桌面和开始菜单里都有「渲染站」，以后从那里打开。任务栏右下角出现它的图标，颜色就是状态：绿色空闲等活，紫色在渲染，黄色在连接，红色登录不上或起不来，灰色暂停接单；点图标打开窗口，右键可以暂停、重连、看日志、退出。窗口是它自己的（WebView2 里的 `station.html`，没有系统的标题栏，最小化、关闭和拖动都在页面顶上；电脑上没有 WebView2 时退回 Edge 的应用窗口）。窗口左边一条侧栏，四页：「总览」是状态、今天的数字、这台电脑最近两分钟的处理器、内存和显卡占用、最近的任务和各自的输出；「画廊」摆出这台电脑渲出来的单帧、封面和片段（每次在 `.tools/remote/out/<时间>/` 留一份，最近 30 次），片段指着就播，点开看大图、左右键翻；「动态」实时列出连接的经过和 ssh、render.mjs 的输出（终端里会看到的都在这里）；「设置」见下。同一个页面在浏览器里也能开：`http://127.0.0.1:7799`，`#gallery`、`#feed`、`#settings` 直接到那一页。渲染站在后台开着渲染服务（`worker.mjs`，只听本机的 127.0.0.1:7700）和到 lemon 的反向隧道（`ssh -N -R 77xx:127.0.0.1:7700 -p 22222 lemon@23.251.32.150`）；电脑睡醒、断网、服务停了，都会自己接回去，渲完一个任务会弹通知。
  - 第一次打开时，在窗口的「设置」里填环境变量：渲染用的 qiqi.help 检出（`PROMO_ROOT`）、录像目录（`PROMO_WORK`）、站点构建（`PROMO_SITE`）、Chrome、ffmpeg、临时浏览器配置、用不用显卡。存在 `.tools/remote/config.json`。`PROMO_ROOT` 和 `PROMO_WORK` 必填；改了 `PROMO_ROOT` 要重启渲染站，Shell 的工作区是在启动时定下的。「登录 Windows 后自动启动」（任务管理器的「启动应用」里能看到）和「桌面和开始菜单里放『渲染站』」默认都开着，在设置里关掉就撤掉。
  - 自动更新（设置里，默认开）：开机一分钟后和之后每半小时，按这份仓库跟着的远程分支快进更新，只在仓库里没有自己的改动、也没有没推的提交时动手，渲着的时候等它渲完；渲染站的代码变了它自己重启，exe 变了托盘图标自己换成新的。
  - `渲染站.exe` 是托盘图标本身（`exe/station.c`）：每次从仓库里那份启动时，先把自己和 `WebView2Loader.dll` 复制到 `%LOCALAPPDATA%\qiqi-render-station\` 再从那里运行，所以仓库里的 exe 不会被占着，更新时可以直接换掉。它在后台起 `station.mjs`，停了就再起，把渲染站和它起的 ssh、Chrome、ffmpeg 放在一个作业对象里，退出时一起结束。它要和 `station.mjs` 放在仓库根目录，要求装了 Node.js。编好的 exe 和 `WebView2Loader.dll` 也放在仓库根目录，改了 `exe/` 里的东西就重新编译并一起提交。
  - 隧道没人输密码，要能用密钥直接登录 lemon（默认密钥或 ssh-agent 里的）：终端里 `ssh -p 22222 lemon@23.251.32.150` 不问密码就行。lemon 那头的端口从 7700 起，被睡死的旧连接占着就换下一个，最多到 7709。
  - 记录在 `.tools/remote/station.log`。不用渲染站也行：环境变量自己设好（至少 `PROMO_ROOT`、`PROMO_WORK`），开两个窗口分别跑 `node worker.mjs` 和上面的 ssh（端口用 7700）。
- **lemon 上：** 参数和 `render.mjs` 一样，隧道在哪个端口它自己找：
  ```bash
  node /www/daum/render-station/ask.mjs --stills 19.9,20.3              # 单帧，全尺寸（加 --preview 半尺寸）
  node /www/daum/render-station/ask.mjs --cover                         # 两张封面
  node /www/daum/render-station/ask.mjs --from 13.49 --to 21.45         # 片段，总是半尺寸、15 fps
  ```
  还没录全时加 `--partial`。结果落在 `/www/daum/render-station/.tools/.scratch/<时间>/`。

每次请求把 lemon 上 qiqi.help 的 `promo/render.mjs`、`lib/`、`stage/` 原样带过去（`PROMO_ROOT` 没设时是 `/www/daum/qiqi.help`），没提交的改动也算，压缩后约 20 KB。站长电脑在 `.tools/remote/job/` 里渲，不碰自己那份代码；渲染用的 `render.mjs`、`node_modules`、`.tools`、站点构建和素材，都取自设置里 `PROMO_ROOT` 指的那份检出，录像和站点构建用的是 `PROMO_WORK`、`PROMO_SITE` 指的本机目录。传回来的是渲好的文件：单帧几百 KB，半尺寸片段几 MB。2026-10-16 测过这条线路：往返约 200 ms，站长电脑到 lemon 约 2.7 MB/s，lemon 到站长电脑约 1.9 MB/s，所以一次请求的开销主要是往返，不是数据量。

服务接单帧、封面、半尺寸片段，以及本机开启后接收的 Shell 任务，一次一个；正式上线之前不渲最高分辨率和帧率（站长，2026-10-16），成片在站长电脑上直接跑 `render.mjs`。隧道开着的时候，能登录 lemon 的人都能让站长电脑跑这里的代码，所以不用时在渲染站里「暂停接单」（托盘图标右键也行）。

### 远程 Shell（站长授权，2026-10-17）

在工作机「设置 → Shell 权限」开启接单，默认是 auto。lemon 提交：

```sh
node /www/daum/render-station/ask.mjs --shell 'node --version'
node /www/daum/render-station/ask.mjs --shell 'node promo/capture/rec.mjs archive' --cwd . --timeout 600
```

命令在工作区里运行，工作区是设置里 `PROMO_ROOT` 指的 qiqi.help 检出（没设时是这个仓库）；Windows 用无配置、非交互 PowerShell，其他系统用 `/bin/sh`。`--cwd` 是工作机路径，默认为工作区；`--timeout` 为执行秒数，默认 600，上限 7200。不会同步源码，引用的是工作机已有的文件。具体录像脚本与参数仍以 `capture/clips/` 为准（在 qiqi.help 里）。Shell 输出实时进入「动态」，完成后输出（最多最后 256 KiB）和退出码交回 lemon，托盘照常通知。

- **auto**：实际工作目录（解析符号链接后）必须在工作区内。完整命令与目录精确匹配本机白名单才会自动执行，不做解释器前缀放行。未匹配时本机窗口弹出审批，可拒绝、仅本次允许、允许并加入白名单；5 分钟未批准则失败。白名单保存在工作机 `.tools/remote/config.json`，设置中可删除。任务协议不提供修改白名单或开启模式的接口，这些操作由本机设置页发起。
- **YOLO**：先退出普通实例，再在 Windows 右键以管理员身份运行渲染站（其他系统需 root），在设置中手动开启并确认。服务端检查当前进程的管理员权限，允许任意命令与目录。该模式只存在内存中，暂停、重连或重启后恢复 auto，不能通过 lemon 的任务参数开启。
- 这是本机授权机制，不是操作系统文件沙箱。获准命令可读写文件，并拥有渲染站运行账户的全部权限；目录检查只限定初始工作目录。引用的脚本可变化，记住整条命令也不冻结脚本内容。原有渲染任务本身会运行远端送来的 JavaScript，也属于已信任的代码通道，不受 Shell 白名单隔离。
- 模式切换、待审批请求、人工决定、执行命令、目录与结果记入工作机 `station.log`。拒绝、超时、断开请求都不会把待审批命令执行掉。关闭 Shell 或暂停接单拒绝后续任务、撤销待审批和 YOLO，不会中止已运行命令；执行超时或提交连接断开会尝试结束该命令的进程树。

这项授权允许 agent 使用站长批准的白名单或本机启用的 YOLO 接单，无需再因“远程 Shell”这一类别重复索要许可；具体工作仍以站长交代的任务范围为准。不要在命令行里放密钥或密码，它会出现在审批和日志里。

## 文件

- `worker.mjs`：渲染服务。收 lemon 的任务，在 `.tools/remote/job/` 里渲，把渲好的东西送回去。
- `ask.mjs`：lemon 上向它要渲染结果的命令（读 `PROMO_ROOT` 指的 qiqi.help 检出）。
- `shell.mjs`、`shell.test.mjs`：远程 Shell 的审批、白名单和执行；测试。
- `station.mjs`、`station.html`、`渲染站.exe`（源码在 `exe/`）和它窗口要的 `WebView2Loader.dll`：渲染站，在站长的 Windows 电脑上管着渲染服务和隧道：后台服务、它的窗口（127.0.0.1:7799）、托盘图标兼双击打开的程序。
- `exe/`：托盘程序的源码（`station.c`、`station.rc`、`station.manifest`）和编译脚本 `build.mjs`。
- `.tools/`：运行时产生的东西（`config.json`、`station.log`、`remote/job`、`remote/out`、`webview2`），不进仓库。

## 许可

MIT，见 `LICENSE`。例外：`WebView2Loader.dll` 是微软的文件，按微软的 WebView2 许可条款使用，不在 MIT 之内。
