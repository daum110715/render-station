// 渲染站.exe, the render station's tray icon on the owner's Windows machine, and what the owner
// double-clicks. It starts the station (station.mjs, with node) with no window at all, starts it
// again whenever it stops, and shows in its colour how it is doing (green waiting, purple
// rendering, amber connecting, red stuck, grey paused); a click opens the station's window
// (station.html, in Edge's app window). It keeps what the window's settings ask for: starting with
// Windows (a value under HKCU\...\Run, so it shows in Task Manager's startup apps) and 渲染站 on
// the desktop and in the Start menu. The station and all it starts (ssh, a render's Chrome and
// ffmpeg) run in a job object, so quitting, or this ending any other way, ends them too. Only one
// runs: a second one opens the window and goes. It stays in the checkout's promo\remote\.
// Built on lemon with mingw-w64: node promo/remote/exe/build.mjs
// (-municode defines them too)
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define COBJMACROS
#define _WIN32_WINNT 0x0A00
#define NTDDI_VERSION 0x0A000000
#include <winsock2.h>
#include <windows.h>
#include <windowsx.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#define UI_PORT 7799
#define WM_TRAY (WM_APP + 1)
#define RUN_NAME L"qiqi 渲染站"
#define LINK_NAME L"渲染站.lnk"
#define TITLE L"渲染站"
enum { CMD_OPEN = 1, CMD_TOGGLE, CMD_RECONNECT, CMD_LOG, CMD_QUIT };
// the icons, as station.rc numbers them less one
enum { ICON_BUSY, ICON_IDLE, ICON_WAIT, ICON_BAD, ICON_OFF, ICONS };

// wide formatting that always ends the string
#define FMT(buf, ...) (_snwprintf(buf, sizeof buf / sizeof *buf - 1, __VA_ARGS__), buf[sizeof buf / sizeof *buf - 1] = 0)

static HINSTANCE inst;
static HWND hwnd;
static UINT taskbarCreated;
static NOTIFYICONDATAW nid;
static HICON icons[ICONS];
static wchar_t exePath[MAX_PATH], exeDir[MAX_PATH], repo[MAX_PATH], nodePath[MAX_PATH];

static HANDLE job, node;
static ULONGLONG startedAt, shownAt;
static int fails, gaveUp, quitting, wantOpen, up, off, seen;
static int lastAuto = -1, lastLink = -1;
static wchar_t toggleText[32] = L"暂停接单", lastMode[16], lastKey[64];

static int isFile(const wchar_t *p) {
  DWORD a = GetFileAttributesW(p);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

// ——— talking to the station: HTTP/1.0 on 127.0.0.1, the reply's body in buf ———
static int call(const char *method, const char *path, char *buf, int cap) {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) return -1;
  // not there: said at once, not after the seconds Windows spends trying a closed port again
  u_long nb = 1;
  ioctlsocket(s, FIONBIO, &nb);
  struct sockaddr_in a = { 0 };
  a.sin_family = AF_INET;
  a.sin_port = htons(UI_PORT);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  connect(s, (struct sockaddr *)&a, sizeof a);
  fd_set w, e;
  FD_ZERO(&w);
  FD_ZERO(&e);
  FD_SET(s, &w);
  FD_SET(s, &e);
  struct timeval tv = { 0, 400000 };
  if (select(0, NULL, &w, &e, &tv) < 1 || !FD_ISSET(s, &w)) {
    closesocket(s);
    return -1;
  }
  nb = 0;
  ioctlsocket(s, FIONBIO, &nb);
  DWORD ms = 3000;
  setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, (const char *)&ms, sizeof ms);
  char req[256];
  int n = snprintf(req, sizeof req, "%s %s HTTP/1.0\r\nHost: 127.0.0.1:%d\r\nx-station: 1\r\nContent-Length: 0\r\n\r\n", method, path, UI_PORT);
  if (send(s, req, n, 0) != n) {
    closesocket(s);
    return -1;
  }
  int got = 0, r;
  while (got < cap - 1 && (r = recv(s, buf + got, cap - 1 - got, 0)) > 0) got += r;
  closesocket(s);
  buf[got] = 0;
  if (got < 12 || strncmp(buf, "HTTP/1.", 7) || strncmp(buf + 9, "200", 3)) return -1;
  char *body = strstr(buf, "\r\n\r\n");
  if (!body) return -1;
  body += 4;
  memmove(buf, body, strlen(body) + 1);
  return 0;
}
static void post(const char *path) {
  char buf[512];
  call("POST", path, buf, sizeof buf);
}

// ——— the tray icon ———
static void addIcon(void) {
  nid.cbSize = sizeof nid;
  nid.hWnd = hwnd;
  nid.uID = 1;
  nid.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE | NIF_SHOWTIP;
  nid.uCallbackMessage = WM_TRAY;
  if (!nid.hIcon) nid.hIcon = icons[ICON_OFF];
  if (!nid.szTip[0]) lstrcpynW(nid.szTip, L"渲染站 · 正在启动", 128);
  Shell_NotifyIconW(NIM_ADD, &nid);
  nid.uVersion = NOTIFYICON_VERSION_4;
  Shell_NotifyIconW(NIM_SETVERSION, &nid);
}
static void show(int icon, const wchar_t *tip) {
  if (nid.hIcon == icons[icon] && !wcscmp(nid.szTip, tip)) return;
  nid.hIcon = icons[icon];
  lstrcpynW(nid.szTip, tip, 128);
  nid.uFlags = NIF_ICON | NIF_TIP | NIF_SHOWTIP;
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}
static void balloon(const wchar_t *title, const wchar_t *text, DWORD kind) {
  nid.uFlags = NIF_INFO;
  lstrcpynW(nid.szInfoTitle, title, 64);
  lstrcpynW(nid.szInfo, text, 256);
  nid.dwInfoFlags = kind;
  Shell_NotifyIconW(NIM_MODIFY, &nid);
}
static int iconFor(const wchar_t *mode) {
  if (!wcscmp(mode, L"busy")) return ICON_BUSY;
  if (!wcscmp(mode, L"idle")) return ICON_IDLE;
  if (!wcscmp(mode, L"connecting") || !wcscmp(mode, L"retry")) return ICON_WAIT;
  if (!wcscmp(mode, L"auth")) return ICON_BAD;
  return ICON_OFF;
}

// ——— the window, and the log ———
static void openLog(void) {
  wchar_t log[MAX_PATH + 32];
  FMT(log, L"\"%ls\\.tools\\remote\\station.log\"", repo);
  ShellExecuteW(NULL, L"open", L"notepad.exe", log, NULL, SW_SHOWNORMAL);
}
// Edge's app window, which every Windows has; failing that, the default browser
static void openWindow(void) {
  ULONGLONG now = GetTickCount64();
  if (shownAt && now - shownAt < 1500) return;
  shownAt = now;
  if (gaveUp) return openLog();
  const wchar_t *roots[] = { L"ProgramFiles(x86)", L"ProgramFiles", L"LOCALAPPDATA" };
  wchar_t root[MAX_PATH], edge[MAX_PATH + 64];
  for (int i = 0; i < 3; i++) {
    if (!GetEnvironmentVariableW(roots[i], root, MAX_PATH)) continue;
    FMT(edge, L"%ls\\Microsoft\\Edge\\Application\\msedge.exe", root);
    if (isFile(edge)) {
      ShellExecuteW(NULL, L"open", edge, L"--app=http://127.0.0.1:7799/ --window-size=840,940", NULL, SW_SHOWNORMAL);
      return;
    }
  }
  ShellExecuteW(NULL, L"open", L"http://127.0.0.1:7799/", NULL, NULL, SW_SHOWNORMAL);
}

// ——— with Windows, and as an app: what the window's settings ask for ———
static void runKey(int on) {
  HKEY k;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, KEY_SET_VALUE, &k) != ERROR_SUCCESS) return;
  if (on) {
    wchar_t v[MAX_PATH + 16];
    FMT(v, L"\"%ls\" /quiet", exePath);
    RegSetValueExW(k, RUN_NAME, 0, REG_SZ, (const BYTE *)v, (DWORD)((wcslen(v) + 1) * sizeof(wchar_t)));
  } else
    RegDeleteValueW(k, RUN_NAME);
  RegCloseKey(k);
}
static void link(int folder, int on) {
  wchar_t dir[MAX_PATH], path[MAX_PATH + 32];
  if (SHGetFolderPathW(NULL, folder, NULL, 0, dir) != S_OK) return;
  FMT(path, L"%ls\\%ls", dir, LINK_NAME);
  if (!on) {
    DeleteFileW(path);
    return;
  }
  IShellLinkW *sl;
  IPersistFile *pf;
  if (FAILED(CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER, &IID_IShellLinkW, (void **)&sl))) return;
  IShellLinkW_SetPath(sl, exePath);
  IShellLinkW_SetWorkingDirectory(sl, exeDir);
  IShellLinkW_SetIconLocation(sl, exePath, 0);
  IShellLinkW_SetDescription(sl, L"qiqi.help 宣传片的渲染站");
  if (SUCCEEDED(IShellLinkW_QueryInterface(sl, &IID_IPersistFile, (void **)&pf))) {
    IPersistFile_Save(pf, path, TRUE);
    IPersistFile_Release(pf);
  }
  IShellLinkW_Release(sl);
}
// on the first word from the station, then whenever the setting changes
static void keep(int autostart, int shortcut) {
  if (autostart != lastAuto) runKey(lastAuto = autostart);
  if (shortcut != lastLink) {
    lastLink = shortcut;
    link(CSIDL_DESKTOPDIRECTORY, shortcut);
    link(CSIDL_PROGRAMS, shortcut);
  }
}

// ——— station.mjs, kept running ———
static void startStation(void) {
  // what the last one left behind (its ssh, a render) goes with it
  if (job) {
    TerminateJobObject(job, 1);
    CloseHandle(job);
  }
  job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION lim = { 0 };
  lim.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(job, JobObjectExtendedLimitInformation, &lim, sizeof lim);
  wchar_t cmd[MAX_PATH * 3];
  FMT(cmd, L"\"%ls\" \"%ls\\promo\\remote\\station.mjs\"", nodePath, repo);
  STARTUPINFOW si = { sizeof si };
  PROCESS_INFORMATION pi;
  startedAt = GetTickCount64();
  if (!CreateProcessW(nodePath, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW | CREATE_SUSPENDED, NULL, repo, &si, &pi)) {
    fails++;
    return;
  }
  AssignProcessToJobObject(job, pi.hProcess);
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  node = pi.hProcess;
}
// the station is not answering
static void down(void) {
  up = 0;
  // starting still
  if (node && WaitForSingleObject(node, 0) == WAIT_TIMEOUT) return show(ICON_OFF, L"渲染站 · 正在启动");
  // stopped: soon after it started, again and again, means it cannot start
  if (node) {
    if (GetTickCount64() - startedAt < 20000) fails++;
    else fails = 0;
    CloseHandle(node);
    node = NULL;
  }
  if (fails >= 3) {
    if (!gaveUp) {
      gaveUp = 1;
      balloon(L"渲染站起不来", L"连着几次一启动就停了，原因在日志里（点这里打开）。", NIIF_ERROR);
    }
    return show(ICON_BAD, L"渲染站 · 起不来，右键查看日志");
  }
  startStation();
  show(ICON_OFF, L"渲染站 · 正在启动");
}
// every two seconds: how the station is (/tray: mode, tip, the pause item, the newest job and
// what to say of it, the two settings, a line each)
static void tick(void) {
  if (quitting) return;
  static char buf[8192];
  static wchar_t w[8192];
  if (call("GET", "/tray", buf, sizeof buf)) return down();
  MultiByteToWideChar(CP_UTF8, 0, buf, -1, w, 8192);
  wchar_t *f[8];
  int n = 0;
  f[n++] = w;
  for (wchar_t *p = w; *p && n < 8; p++)
    if (*p == L'\n') {
      *p = 0;
      f[n++] = p + 1;
    }
  if (n < 8) return;
  up = 1;
  fails = 0;
  gaveUp = 0;
  const wchar_t *mode = f[0];
  if (!wcscmp(mode, L"auth") && wcscmp(lastMode, L"auth")) balloon(L"lemon 不让登录", L"自动连接要用不输密码的密钥登录。点这里打开渲染站看看。", NIIF_ERROR);
  lstrcpynW(lastMode, mode, 16);
  show(iconFor(mode), f[1]);
  lstrcpynW(toggleText, f[2], 32);
  off = !wcscmp(mode, L"off");
  // a job just done: say so
  if (!seen) {
    seen = 1;
    lstrcpynW(lastKey, f[3], 64);
  } else if (f[3][0] && wcscmp(f[3], lastKey)) {
    lstrcpynW(lastKey, f[3], 64);
    balloon(f[4], f[5], wcscmp(f[4], L"渲染完成") ? NIIF_WARNING : NIIF_INFO);
  }
  keep(f[6][0] == L'1', f[7][0] == L'1');
  if (wantOpen) {
    wantOpen = 0;
    openWindow();
  }
}

static void quit(void) {
  if (!wcscmp(lastMode, L"busy") && MessageBoxW(hwnd, L"正在渲染。现在退出，这个任务就作废了。", TITLE, MB_OKCANCEL | MB_ICONWARNING) != IDOK) return;
  quitting = 1;
  KillTimer(hwnd, 1);
  post("/quit");
  if (node) WaitForSingleObject(node, 2000);
  // and whatever it started
  if (job) TerminateJobObject(job, 0);
  Shell_NotifyIconW(NIM_DELETE, &nid);
  DestroyWindow(hwnd);
}

static void menu(int x, int y) {
  HMENU m = CreatePopupMenu();
  AppendMenuW(m, MF_STRING, CMD_OPEN, L"打开渲染站");
  AppendMenuW(m, MF_STRING | (up ? 0 : MF_GRAYED), CMD_TOGGLE, toggleText);
  AppendMenuW(m, MF_STRING | (up && !off ? 0 : MF_GRAYED), CMD_RECONNECT, L"重新连接");
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  AppendMenuW(m, MF_STRING, CMD_LOG, L"查看日志");
  AppendMenuW(m, MF_STRING, CMD_QUIT, L"退出渲染站");
  SetMenuDefaultItem(m, CMD_OPEN, FALSE);
  SetForegroundWindow(hwnd);
  UINT align = GetSystemMetrics(SM_MENUDROPALIGNMENT) ? TPM_RIGHTALIGN : TPM_LEFTALIGN;
  TrackPopupMenuEx(m, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | align, x, y, hwnd, NULL);
  PostMessageW(hwnd, WM_NULL, 0, 0);
  DestroyMenu(m);
}

static LRESULT CALLBACK proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
  case WM_TRAY:
    switch (LOWORD(lp)) {
    case NIN_SELECT:
    case NIN_KEYSELECT:
    case NIN_BALLOONUSERCLICK:
      openWindow();
      break;
    case WM_CONTEXTMENU:
      menu(GET_X_LPARAM(wp), GET_Y_LPARAM(wp));
      break;
    }
    return 0;
  case WM_TIMER:
    tick();
    return 0;
  case WM_COMMAND:
    switch (LOWORD(wp)) {
    case CMD_OPEN:
      openWindow();
      break;
    case CMD_TOGGLE:
      post(off ? "/resume" : "/pause");
      tick();
      break;
    case CMD_RECONNECT:
      post("/reconnect");
      tick();
      break;
    case CMD_LOG:
      openLog();
      break;
    case CMD_QUIT:
      quit();
      break;
    }
    return 0;
  case WM_DESTROY:
    PostQuitMessage(0);
    return 0;
  }
  // Explorer started again: the icon is gone with the old taskbar
  if (msg == taskbarCreated && taskbarCreated) {
    addIcon();
    return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

// the menus dark when Windows is (uxtheme's unnamed SetPreferredAppMode and FlushMenuThemes)
static void darkMenus(void) {
  HMODULE ux = LoadLibraryExW(L"uxtheme.dll", NULL, LOAD_LIBRARY_SEARCH_SYSTEM32);
  if (!ux) return;
  int(WINAPI * mode)(int) = (int(WINAPI *)(int))(void *)GetProcAddress(ux, MAKEINTRESOURCEA(135));
  void(WINAPI * flush)(void) = (void(WINAPI *)(void))(void *)GetProcAddress(ux, MAKEINTRESOURCEA(136));
  if (mode) mode(1);
  if (flush) flush();
}

static int findNode(void) {
  if (SearchPathW(NULL, L"node.exe", NULL, MAX_PATH, nodePath, NULL)) return 1;
  // where the installer puts it, should this have started without the PATH that names it
  wchar_t root[MAX_PATH];
  if (GetEnvironmentVariableW(L"ProgramFiles", root, MAX_PATH)) {
    FMT(nodePath, L"%ls\\nodejs\\node.exe", root);
    if (isFile(nodePath)) return 1;
  }
  return 0;
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE prev, PWSTR args, int how) {
  (void)prev;
  (void)how;
  inst = hi;
  int quiet = args && wcsstr(args, L"/quiet") != NULL;
  wantOpen = !quiet;
  CreateMutexW(NULL, TRUE, L"Local\\qiqi-render-station-tray");
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    if (!quiet) openWindow();
    return 0;
  }

  GetModuleFileNameW(NULL, exePath, MAX_PATH);
  lstrcpynW(exeDir, exePath, MAX_PATH);
  wchar_t *slash = wcsrchr(exeDir, L'\\');
  if (slash) *slash = 0;
  wchar_t up2[MAX_PATH + 8], check[MAX_PATH + 64];
  FMT(up2, L"%ls\\..\\..", exeDir);
  GetFullPathNameW(up2, MAX_PATH, repo, NULL);
  FMT(check, L"%ls\\promo\\remote\\station.mjs", repo);
  if (!isFile(check)) {
    MessageBoxW(NULL, L"渲染站.exe 要留在仓库的 promo\\remote 文件夹里，和 station.mjs 放在一起。\n\n桌面上的「渲染站」是它的快捷方式，以后从那里打开就行。", TITLE, MB_ICONERROR);
    return 1;
  }
  if (!findNode()) {
    MessageBoxW(NULL, L"没找到 Node.js。装好 Node.js（nodejs.org，选 LTS）之后再打开渲染站。", TITLE, MB_ICONERROR);
    return 1;
  }

  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
  darkMenus();
  int cx = GetSystemMetrics(SM_CXSMICON), cy = GetSystemMetrics(SM_CYSMICON);
  for (int i = 0; i < ICONS; i++) icons[i] = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(i + 1), IMAGE_ICON, cx, cy, 0);

  WNDCLASSW wc = { 0 };
  wc.lpfnWndProc = proc;
  wc.hInstance = inst;
  wc.lpszClassName = L"QiqiRenderStation";
  RegisterClassW(&wc);
  hwnd = CreateWindowExW(0, wc.lpszClassName, TITLE, WS_OVERLAPPED, 0, 0, 0, 0, NULL, NULL, inst, NULL);
  taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
  addIcon();
  SetTimer(hwnd, 1, 2000, NULL);
  tick();

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  if (job) CloseHandle(job);
  return 0;
}
