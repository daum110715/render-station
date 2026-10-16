# 渲染站's tray icon, on the owner's Windows machine: starts station.mjs, starts it again whenever
# it stops, and shows in its colour how it is doing (green waiting, purple rendering, amber
# connecting, red stuck, grey paused); a click opens the window. station.vbs (and the 渲染站
# shortcuts) run it with -Open, hidden, so no terminal shows; the Startup folder's script runs it
# without, when 「登录 Windows 后自动启动」 is on. Only one runs: a second one opens the window and goes.
# usage: powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File station.ps1 [-Open]
param([switch]$Open)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$base = 'http://127.0.0.1:7799'
$log = Join-Path $repo '.tools\remote\station.log'

# a request to the station: its state, parsed (UTF-8 whatever the system's code page)
function Call([string]$method, [string]$path) {
  $req = [System.Net.HttpWebRequest]::Create("$base$path")
  $req.Method = $method
  $req.Timeout = 2000
  $req.Proxy = $null
  if ($method -eq 'POST') {
    $req.Headers.Add('x-station', '1')
    $req.ContentLength = 0
  }
  $res = $req.GetResponse()
  try {
    $reader = New-Object System.IO.StreamReader($res.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $reader.ReadToEnd() | ConvertFrom-Json
  } finally {
    $res.Close()
  }
}
function State { try { Call 'GET' '/state' } catch { $null } }

$script:shown = [DateTime]::MinValue
$script:gaveUp = $false
# the window: Edge's app window, which every Windows has; failing that, the default browser
function Show-Window {
  if (((Get-Date) - $script:shown).TotalSeconds -lt 1.5) { return }
  $script:shown = Get-Date
  if ($script:gaveUp) { return Open-Log }
  $edge = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($edge) { Start-Process $edge -ArgumentList "--app=$base/", '--window-size=840,940' }
  else { Start-Process "$base/" }
}
function Open-Log { if (Test-Path $log) { Start-Process notepad.exe -ArgumentList "`"$log`"" } }

$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\qiqi-render-station-tray', [ref]$created)
if (-not $created) {
  if ($Open) { Show-Window }
  exit
}

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# sharp on a scaled screen
try {
  Add-Type -Namespace QiqiStation -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
  [void][QiqiStation.Dpi]::SetProcessDPIAware()
} catch {}
[System.Windows.Forms.Application]::EnableVisualStyles()

$node = (Get-Command node -ErrorAction SilentlyContinue).Path
if (-not $node) {
  [void][System.Windows.Forms.MessageBox]::Show('没找到 node。装好 Node.js（node 能在终端里直接运行）再打开渲染站。', '渲染站', 'OK', 'Error')
  exit
}

# ——— station.mjs, kept running ———
$script:proc = $null
$script:startedAt = [DateTime]::MinValue
$script:fails = 0
$script:quitting = $false
function Start-Station {
  # an ssh a stopped station left behind still holds a tunnel; the new station opens its own (a
  # tunnel opened by hand to the worker goes too)
  Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match '-R\s*77\d\d:127\.0\.0\.1:7700\b' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $node
  $info.Arguments = '"' + (Join-Path $PSScriptRoot 'station.mjs') + '"'
  $info.WorkingDirectory = $repo
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $script:proc = [System.Diagnostics.Process]::Start($info)
  $script:startedAt = Get-Date
}

# ——— the icon: a dot in the state's colour with a play mark, as the window's ———
function Draw-Dot([string]$hex, [int]$size) {
  $k = [single]($size / 32)
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $fill = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $g.FillEllipse($fill, [single](1 * $k), [single](1 * $k), [single](30 * $k), [single](30 * $k))
  $mark = [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF ([single](12.5 * $k)), ([single](9 * $k))),
    (New-Object System.Drawing.PointF ([single](23.5 * $k)), ([single](16 * $k))),
    (New-Object System.Drawing.PointF ([single](12.5 * $k)), ([single](23 * $k)))
  )
  $g.FillPolygon($white, $mark)
  $g.Dispose(); $fill.Dispose(); $white.Dispose()
  $bmp
}
function New-Dot([string]$hex) { [System.Drawing.Icon]::FromHandle((Draw-Dot $hex 32).GetHicon()) }
# the shortcuts' icon (station.mjs makes them): one 256px PNG in an .ico
function Save-Ico([string]$path) {
  $png = New-Object System.IO.MemoryStream
  (Draw-Dot '#6a4c9e' 256).Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $png.ToArray()
  $out = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter($out)
  # the header: an icon, one image; the image: 256 across (0), no palette, 32 bits, where it is
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
  $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32)
  $w.Write([uint32]$bytes.Length); $w.Write([uint32]22)
  $w.Write($bytes)
  $w.Flush()
  [System.IO.File]::WriteAllBytes($path, $out.ToArray())
}
try {
  $tools = Join-Path $repo '.tools\remote'
  [void](New-Item -ItemType Directory -Force -Path $tools)
  Save-Ico (Join-Path $tools 'station.ico')
} catch {}
$icons = @{
  idle       = New-Dot '#2a9d80'
  busy       = New-Dot '#6a4c9e'
  connecting = New-Dot '#d99a1e'
  retry      = New-Dot '#d99a1e'
  auth       = New-Dot '#d4563a'
  gone       = New-Dot '#d4563a'
  off        = New-Dot '#9a8a9d'
  start      = New-Dot '#9a8a9d'
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.ShowImageMargin = $false
$itemOpen = $menu.Items.Add('打开渲染站')
$itemOpen.Font = New-Object System.Drawing.Font($itemOpen.Font, [System.Drawing.FontStyle]::Bold)
$itemToggle = $menu.Items.Add('暂停接单')
$itemReconnect = $menu.Items.Add('重新连接')
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$itemLog = $menu.Items.Add('查看日志')
$itemQuit = $menu.Items.Add('退出渲染站')

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icons['start']
$tray.Text = '渲染站 · 正在启动'
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

$script:mode = $null
$script:last = $null
$script:wantOpen = [bool]$Open
function Show-Mode([string]$mode, [string]$text) {
  # a tray tip holds 63 characters
  if ($text.Length -gt 63) { $text = $text.Substring(0, 62) + '…' }
  $tray.Text = $text
  $icon = $icons[$mode]
  if (-not $icon) { $icon = $icons['gone'] }
  if ($tray.Icon -ne $icon) { $tray.Icon = $icon }
  $script:mode = $mode
}
function Took($ms) {
  $s = [math]::Round($ms / 1000)
  if ($s -lt 60) { "$s 秒" } else { '{0} 分 {1:00} 秒' -f [math]::Floor($s / 60), ($s % 60) }
}

function Tick {
  if ($script:quitting) { return }
  $s = State
  if (-not $s) {
    $itemToggle.Enabled = $false
    $itemReconnect.Enabled = $false
    # starting still
    if ($script:proc -and -not $script:proc.HasExited) { return Show-Mode 'start' '渲染站 · 正在启动' }
    # stopped: soon after it started, again and again, means it cannot start
    if ($script:proc) {
      if (((Get-Date) - $script:startedAt).TotalSeconds -lt 20) { $script:fails++ } else { $script:fails = 0 }
      $script:proc = $null
    }
    if ($script:fails -ge 3) {
      if (-not $script:gaveUp) {
        $script:gaveUp = $true
        $tray.ShowBalloonTip(8000, '渲染站起不来', '连着几次一启动就停了，原因在日志里（点这里打开）。', 'Error')
      }
      return Show-Mode 'gone' '渲染站 · 起不来，右键查看日志'
    }
    Start-Station
    return Show-Mode 'start' '渲染站 · 正在启动'
  }
  $script:fails = 0
  $script:gaveUp = $false
  $state = $s.tunnel.state
  $mode = if ($s.job) { 'busy' } elseif ($state -eq 'up') { 'idle' } else { $state }
  $text = switch ($mode) {
    'busy' { "渲染中：$($s.job.what)" }
    'idle' { "空闲，已连上 lemon:$($s.tunnel.port)" }
    'connecting' { '正在连接 lemon' }
    'retry' { '连不上 lemon，会自己重试' }
    'auth' { 'lemon 不让登录，点开看看' }
    'off' { '已暂停接单' }
    default { $mode }
  }
  if ($mode -eq 'auth' -and $script:mode -ne 'auth') {
    $tray.ShowBalloonTip(8000, 'lemon 不让登录', '自动连接要用不输密码的密钥登录。点这里打开渲染站看看。', 'Error')
  }
  Show-Mode $mode "渲染站 · $text"
  $itemToggle.Text = if ($state -eq 'off') { '继续接单' } else { '暂停接单' }
  $itemToggle.Enabled = $true
  $itemReconnect.Enabled = $state -ne 'off'

  # a job just done: say so
  $newest = $s.jobs | Select-Object -First 1
  $key = if ($newest) { "$($newest.id)@$($newest.started)" } else { '' }
  if ($null -eq $script:last) { $script:last = $key }
  elseif ($key -and $key -ne $script:last) {
    $script:last = $key
    if ($newest.ok) { $tray.ShowBalloonTip(5000, '渲染完成', "$($newest.what)，用了 $(Took $newest.ms)，已交回 lemon。", 'Info') }
    else { $tray.ShowBalloonTip(8000, '渲染失败', "$($newest.what)。日志在渲染站「最近的任务」里。", 'Warning') }
  }
  if ($script:wantOpen) {
    $script:wantOpen = $false
    Show-Window
  }
}
function Post([string]$path) {
  try { [void](Call 'POST' $path) } catch {}
  Tick
}

function Quit {
  $s = State
  if ($s -and $s.job) {
    $answer = [System.Windows.Forms.MessageBox]::Show("正在渲染：$($s.job.what)`n现在退出，这个任务就作废了。", '渲染站', 'OKCancel', 'Warning')
    if ($answer -ne 'OK') { return }
  }
  $script:quitting = $true
  $timer.Stop()
  if ($s -and $s.job -and $script:proc -and -not $script:proc.HasExited) {
    # the render's own processes (Chrome, ffmpeg) with it
    & taskkill.exe /PID $script:proc.Id /T /F | Out-Null
  } else {
    try { [void](Call 'POST' '/quit') } catch {}
    if ($script:proc -and -not $script:proc.WaitForExit(3000)) { $script:proc.Kill() }
  }
  $tray.Visible = $false
  $tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

$itemOpen.add_Click({ try { Show-Window } catch {} })
$itemToggle.add_Click({
  try {
    $s = State
    if ($s.tunnel.state -eq 'off') { Post '/resume' } else { Post '/pause' }
  } catch {}
})
$itemReconnect.add_Click({ Post '/reconnect' })
$itemLog.add_Click({ try { Open-Log } catch {} })
$itemQuit.add_Click({ try { Quit } catch { [System.Windows.Forms.Application]::Exit() } })
$tray.add_MouseClick({
  param($o, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { try { Show-Window } catch {} }
})
$tray.add_BalloonTipClicked({ try { Show-Window } catch {} })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ try { Tick } catch {} })
$timer.Start()
try { Tick } catch {}
[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
