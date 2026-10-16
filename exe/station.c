// 渲染站.exe, the render station's tray icon on the owner's Windows machine, and what the owner
// double-clicks. It starts the station (station.mjs, with node) with no window at all, starts it
// again whenever it stops, and shows in its colour how it is doing (green waiting, purple
// rendering, amber connecting, red stuck, grey paused); a click opens the station's window: a
// window of its own with no frame but the page's (station.html in WebView2, through
// WebView2Loader.dll beside it), or failing that Edge's app window. The page drags it, minimizes
// and closes it, and opens what a job made, by messages. It keeps what the settings ask for: starting with
// Windows (a value under HKCU\...\Run, so it shows in Task Manager's startup apps) and 渲染站 on
// the desktop and in the Start menu. The station and all it starts (ssh, a render's Chrome and
// ffmpeg) run in a job object, so quitting, or this ending any other way, ends them too. Only one
// runs: a second one opens the window and goes. It stays in the checkout's promo\remote\, but runs
// from a copy of itself in %LOCALAPPDATA%\qiqi-render-station\ (it copies itself there, with the
// loader, and starts the copy), so the checkout's file is never held and an update can replace it;
// when the station has updated it, the copy starts the checkout's again (--after) and goes.
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
#include <dwmapi.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include "WebView2.h"

#define UI_PORT 7799
#define WM_TRAY (WM_APP + 1)
#define RUN_NAME L"qiqi 渲染站"
#define LINK_NAME L"渲染站.lnk"
#define TITLE L"渲染站"
enum { CMD_OPEN = 1, CMD_TOGGLE, CMD_RECONNECT, CMD_BROWSER, CMD_LOG, CMD_QUIT };
// the window's timers, and its word to itself to give up on WebView2
enum { TIMER_RETRY = 2, TIMER_WATCH };
#define WM_GIVE_UP (WM_APP + 2)
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
// the checkout's 渲染站.exe: what the shortcuts and starting with Windows start
static wchar_t launcher[MAX_PATH];
static void again(void);

static HANDLE job, node;
static ULONGLONG startedAt, shownAt;
static int fails, gaveUp, quitting, wantOpen, up, off, seen;
static int lastAuto = -1, lastLink = -1;
// the window, while it is open; WebView2's environment maker from its loader
static HWND frame;
static ICoreWebView2Controller *ctl;
static ICoreWebView2 *wv;
typedef HRESULT(STDAPICALLTYPE *CreateEnv)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions *, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);
static CreateEnv createEnv;
static int dpi = 96, dark;
static ICoreWebView2Environment *wenv;
static int navTries, crashes;
static wchar_t logPath[MAX_PATH + 64];
// a line in the station's log (station.log, beside station.mjs's own): how the window went
static void say(const wchar_t *fmt, ...) {
  if (!logPath[0]) return;
  wchar_t text[600];
  va_list ap;
  va_start(ap, fmt);
  _vsnwprintf(text, 599, fmt, ap);
  va_end(ap);
  text[599] = 0;
  SYSTEMTIME t;
  GetSystemTime(&t);
  char line[2000];
  int n = snprintf(line, sizeof line, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ  ", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
  n += WideCharToMultiByte(CP_UTF8, 0, text, -1, line + n, (int)sizeof line - n - 2, NULL, NULL) - 1;
  line[n++] = '\n';
  HANDLE f = CreateFileW(logPath, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (f == INVALID_HANDLE_VALUE) return;
  DWORD wrote;
  WriteFile(f, line, n, &wrote, NULL);
  CloseHandle(f);
}
#define DIP(v) MulDiv(v, dpi, 96)
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
static void openEdge(void) {
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

// ——— the window of its own ———
static void closeFrame(void) {
  if (ctl) {
    ICoreWebView2Controller_Close(ctl);
    ICoreWebView2Controller_Release(ctl);
    ctl = NULL;
  }
  if (wv) {
    ICoreWebView2_Release(wv);
    wv = NULL;
  }
  if (frame) {
    HWND h = frame;
    frame = NULL;
    DestroyWindow(h);
  }
}
// it could not be made, or shows nothing: a browser's, as before
static void fallBack(void) {
  say(L"窗口：改用浏览器打开");
  closeFrame();
  openEdge();
}
// what a job made, kept under promo\out\remote: opened, or shown in its folder
static void reveal(const wchar_t *path, int folder) {
  wchar_t root[MAX_PATH + 32], full[MAX_PATH * 2];
  FMT(root, L"%ls\\promo\\out\\remote\\", repo);
  if (!GetFullPathNameW(path, MAX_PATH * 2, full, NULL) || _wcsnicmp(full, root, wcslen(root)) || !isFile(full)) return;
  if (folder) {
    wchar_t arg[MAX_PATH * 2 + 16];
    FMT(arg, L"/select,\"%ls\"", full);
    ShellExecuteW(NULL, L"open", L"explorer.exe", arg, NULL, SW_SHOWNORMAL);
  } else
    ShellExecuteW(NULL, L"open", full, NULL, NULL, SW_SHOWNORMAL);
}

// WebView2's callbacks: objects with nothing but their table, never freed
static HRESULT STDMETHODCALLTYPE anyQI(IUnknown *self, REFIID riid, void **out) {
  (void)riid;
  *out = self;
  return S_OK;
}
static ULONG STDMETHODCALLTYPE oneRef(IUnknown *self) {
  (void)self;
  return 1;
}
// the page's word: drag, min, close, or open/show and a path
static HRESULT STDMETHODCALLTYPE onMessage(ICoreWebView2WebMessageReceivedEventHandler *self, ICoreWebView2 *sender, ICoreWebView2WebMessageReceivedEventArgs *args) {
  (void)self;
  (void)sender;
  LPWSTR s = NULL;
  if (FAILED(ICoreWebView2WebMessageReceivedEventArgs_TryGetWebMessageAsString(args, &s)) || !s) return S_OK;
  if (frame && !wcscmp(s, L"drag")) {
    // as if its title bar had been pressed: moved, snapped to the screen's sides
    POINT pt;
    GetCursorPos(&pt);
    ReleaseCapture();
    PostMessageW(frame, WM_NCLBUTTONDOWN, HTCAPTION, MAKELPARAM(pt.x, pt.y));
  } else if (frame && !wcscmp(s, L"min"))
    ShowWindow(frame, SW_MINIMIZE);
  else if (frame && !wcscmp(s, L"close"))
    PostMessageW(frame, WM_CLOSE, 0, 0);
  else if (!wcsncmp(s, L"open\t", 5))
    reveal(s + 5, 0);
  else if (!wcsncmp(s, L"show\t", 5))
    reveal(s + 5, 1);
  else if (!wcscmp(s, L"browser"))
    ShellExecuteW(NULL, L"open", L"http://127.0.0.1:7799/", NULL, NULL, SW_SHOWNORMAL);
  CoTaskMemFree(s);
  return S_OK;
}
static ICoreWebView2WebMessageReceivedEventHandlerVtbl messageTable = { (void *)anyQI, (void *)oneRef, (void *)oneRef, onMessage };
static ICoreWebView2WebMessageReceivedEventHandler messageHandler = { &messageTable };

// the page loaded, or not (the station starting still): again a second later, six times
static HRESULT STDMETHODCALLTYPE onNavigated(ICoreWebView2NavigationCompletedEventHandler *self, ICoreWebView2 *sender, ICoreWebView2NavigationCompletedEventArgs *args) {
  (void)self;
  (void)sender;
  BOOL ok = FALSE;
  COREWEBVIEW2_WEB_ERROR_STATUS status = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
  ICoreWebView2NavigationCompletedEventArgs_get_IsSuccess(args, &ok);
  ICoreWebView2NavigationCompletedEventArgs_get_WebErrorStatus(args, &status);
  if (!frame) return S_OK;
  if (ok) {
    KillTimer(frame, TIMER_WATCH);
    say(L"窗口：页面打开了");
    return S_OK;
  }
  say(L"窗口：页面没打开（WebErrorStatus %d），第 %d 次", (int)status, navTries + 1);
  if (++navTries < 6) SetTimer(frame, TIMER_RETRY, 1000, NULL);
  else PostMessageW(frame, WM_GIVE_UP, 0, 0);
  return S_OK;
}
static ICoreWebView2NavigationCompletedEventHandlerVtbl navigatedTable = { (void *)anyQI, (void *)oneRef, (void *)oneRef, onNavigated };
static ICoreWebView2NavigationCompletedEventHandler navigatedHandler = { &navigatedTable };
// WebView2's own processes: the page's gone, loaded again; worse, or again and again, a browser's
static HRESULT STDMETHODCALLTYPE onFailed(ICoreWebView2ProcessFailedEventHandler *self, ICoreWebView2 *sender, ICoreWebView2ProcessFailedEventArgs *args) {
  (void)self;
  (void)sender;
  COREWEBVIEW2_PROCESS_FAILED_KIND kind = COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
  ICoreWebView2ProcessFailedEventArgs_get_ProcessFailedKind(args, &kind);
  say(L"窗口：WebView2 的进程出了问题（ProcessFailedKind %d）", (int)kind);
  if (!frame) return S_OK;
  if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED && ++crashes < 3 && wv) ICoreWebView2_Reload(wv);
  else PostMessageW(frame, WM_GIVE_UP, 0, 0);
  return S_OK;
}
static ICoreWebView2ProcessFailedEventHandlerVtbl failedTable = { (void *)anyQI, (void *)oneRef, (void *)oneRef, onFailed };
static ICoreWebView2ProcessFailedEventHandler failedHandler = { &failedTable };

static HRESULT STDMETHODCALLTYPE onController(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *self, HRESULT result, ICoreWebView2Controller *made) {
  (void)self;
  if (FAILED(result) || !made || !frame) {
    say(L"窗口：WebView2 没建起来（0x%08lx）", (unsigned long)result);
    if (frame) PostMessageW(frame, WM_GIVE_UP, 0, 0);
    else openEdge();
    return S_OK;
  }
  ctl = made;
  ICoreWebView2Controller_AddRef(ctl);
  ICoreWebView2Controller_get_CoreWebView2(ctl, &wv);
  // the page's own paper behind it while it loads
  ICoreWebView2Controller2 *c2;
  if (SUCCEEDED(ICoreWebView2Controller_QueryInterface(ctl, &IID_ICoreWebView2Controller2, (void **)&c2))) {
    COREWEBVIEW2_COLOR bg = dark ? (COREWEBVIEW2_COLOR){ 255, 0x17, 0x12, 0x16 } : (COREWEBVIEW2_COLOR){ 255, 0xf8, 0xf6, 0xf5 };
    ICoreWebView2Controller2_put_DefaultBackgroundColor(c2, bg);
    ICoreWebView2Controller2_Release(c2);
  }
  // an app's window, not a browser's
  ICoreWebView2Settings *st;
  if (SUCCEEDED(ICoreWebView2_get_Settings(wv, &st))) {
    ICoreWebView2Settings_put_AreDevToolsEnabled(st, FALSE);
    ICoreWebView2Settings_put_IsStatusBarEnabled(st, FALSE);
    ICoreWebView2Settings_put_IsZoomControlEnabled(st, FALSE);
    ICoreWebView2Settings3 *s3;
    if (SUCCEEDED(ICoreWebView2Settings_QueryInterface(st, &IID_ICoreWebView2Settings3, (void **)&s3))) {
      ICoreWebView2Settings3_put_AreBrowserAcceleratorKeysEnabled(s3, FALSE);
      ICoreWebView2Settings3_Release(s3);
    }
    ICoreWebView2Settings_Release(st);
  }
  EventRegistrationToken token;
  ICoreWebView2_add_WebMessageReceived(wv, &messageHandler, &token);
  ICoreWebView2_add_NavigationCompleted(wv, &navigatedHandler, &token);
  ICoreWebView2_add_ProcessFailed(wv, &failedHandler, &token);
  ShowWindow(frame, SW_SHOWNORMAL);
  SetForegroundWindow(frame);
  RECT rc;
  GetClientRect(frame, &rc);
  ICoreWebView2Controller_put_Bounds(ctl, rc);
  ICoreWebView2Controller_put_IsVisible(ctl, TRUE);
  say(L"窗口：WebView2 建好了，%ldx%ld，打开页面", rc.right - rc.left, rc.bottom - rc.top);
  navTries = 0;
  crashes = 0;
  ICoreWebView2_Navigate(wv, L"http://127.0.0.1:7799/");
  // nothing to show for it in twelve seconds: a browser's window instead
  SetTimer(frame, TIMER_WATCH, 12000, NULL);
  ICoreWebView2Controller_MoveFocus(ctl, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
  return S_OK;
}
static ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerVtbl controllerTable = { (void *)anyQI, (void *)oneRef, (void *)oneRef, onController };
static ICoreWebView2CreateCoreWebView2ControllerCompletedHandler controllerHandler = { &controllerTable };

static HRESULT STDMETHODCALLTYPE onEnvironment(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *self, HRESULT result, ICoreWebView2Environment *env) {
  (void)self;
  if (SUCCEEDED(result) && env && !wenv) {
    // kept: the next window is made from it at once
    wenv = env;
    ICoreWebView2Environment_AddRef(wenv);
  }
  HRESULT made = E_FAIL;
  if (SUCCEEDED(result) && env && frame) made = ICoreWebView2Environment_CreateCoreWebView2Controller(env, frame, &controllerHandler);
  if (FAILED(made)) {
    say(L"窗口：WebView2 起不来（0x%08lx / 0x%08lx）", (unsigned long)result, (unsigned long)made);
    fallBack();
  }
  return S_OK;
}
static ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandlerVtbl environmentTable = { (void *)anyQI, (void *)oneRef, (void *)oneRef, onEnvironment };
static ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler environmentHandler = { &environmentTable };

static LRESULT CALLBACK frameProc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
  case WM_NCCALCSIZE:
    if (wp) {
      // no title bar, the page draws its own; the sides and the bottom still resize it
      NCCALCSIZE_PARAMS *p = (NCCALCSIZE_PARAMS *)lp;
      LONG top = p->rgrc[0].top;
      DefWindowProcW(h, msg, wp, lp);
      p->rgrc[0].top = top + (IsZoomed(h) ? GetSystemMetrics(SM_CYFRAME) + GetSystemMetrics(SM_CXPADDEDBORDER) : 0);
      return 0;
    }
    break;
  case WM_SIZE:
    if (ctl) {
      RECT rc;
      GetClientRect(h, &rc);
      ICoreWebView2Controller_put_Bounds(ctl, rc);
    }
    return 0;
  case WM_ACTIVATE:
    if (ctl && LOWORD(wp) != WA_INACTIVE) ICoreWebView2Controller_MoveFocus(ctl, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    break;
  case WM_GETMINMAXINFO: {
    MINMAXINFO *m = (MINMAXINFO *)lp;
    m->ptMinTrackSize.x = DIP(520);
    m->ptMinTrackSize.y = DIP(560);
    return 0;
  }
  case WM_TIMER:
    KillTimer(h, wp);
    if (wp == TIMER_RETRY && wv) ICoreWebView2_Navigate(wv, L"http://127.0.0.1:7799/");
    if (wp == TIMER_WATCH) {
      say(L"窗口：12 秒了页面还没出来");
      fallBack();
    }
    return 0;
  case WM_GIVE_UP:
    fallBack();
    return 0;
  case WM_CLOSE:
    closeFrame();
    return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}
static int makeFrame(void) {
  RECT work;
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  int w = DIP(840), h = DIP(940);
  if (h > work.bottom - work.top - DIP(32)) h = work.bottom - work.top - DIP(32);
  frame = CreateWindowExW(0, L"QiqiRenderStationWindow", TITLE, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_CLIPCHILDREN,
                          work.left + (work.right - work.left - w) / 2, work.top + (work.bottom - work.top - h) / 2, w, h, NULL, NULL, inst, NULL);
  if (!frame) return 0;
  // the edge dark with the page, the corners round (Windows 11)
  BOOL on = dark;
  DwmSetWindowAttribute(frame, 20, &on, sizeof on);
  int round = 2;
  DwmSetWindowAttribute(frame, 33, &round, sizeof round);
  SetWindowPos(frame, NULL, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  return 1;
}
static void openWindow(void) {
  if (frame) {
    // still being made: it shows itself
    if (!ctl) return;
    ShowWindow(frame, IsIconic(frame) ? SW_RESTORE : SW_SHOW);
    SetForegroundWindow(frame);
    return;
  }
  ULONGLONG now = GetTickCount64();
  if (shownAt && now - shownAt < 1500) return;
  shownAt = now;
  if (gaveUp) return openLog();
  if (createEnv && makeFrame()) {
    if (wenv && SUCCEEDED(ICoreWebView2Environment_CreateCoreWebView2Controller(wenv, frame, &controllerHandler))) return;
    wchar_t data[MAX_PATH + 32];
    FMT(data, L"%ls\\.tools\\remote\\webview2", repo);
    HRESULT hr = createEnv(NULL, data, NULL, &environmentHandler);
    if (SUCCEEDED(hr)) return;
    say(L"窗口：WebView2 起不来（0x%08lx）", (unsigned long)hr);
  } else
    say(createEnv ? L"窗口：建不了窗口" : L"窗口：没有 WebView2Loader.dll");
  fallBack();
}

// ——— with Windows, and as an app: what the window's settings ask for ———
static void runKey(int on) {
  HKEY k;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run", 0, KEY_SET_VALUE, &k) != ERROR_SUCCESS) return;
  if (on) {
    wchar_t v[MAX_PATH + 16];
    FMT(v, L"\"%ls\" /quiet", launcher);
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
  wchar_t dirOf[MAX_PATH];
  lstrcpynW(dirOf, launcher, MAX_PATH);
  wchar_t *cut = wcsrchr(dirOf, L'\\');
  if (cut) *cut = 0;
  IShellLinkW_SetPath(sl, launcher);
  IShellLinkW_SetWorkingDirectory(sl, dirOf);
  IShellLinkW_SetIconLocation(sl, launcher, 0);
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
    DWORD code = 0;
    GetExitCodeProcess(node, &code);
    // 75: it stopped to start again, updated
    if (code == 75) fails = 0;
    else if (GetTickCount64() - startedAt < 20000) fails++;
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
  wchar_t *f[9] = { 0 };
  int n = 0;
  f[n++] = w;
  for (wchar_t *p = w; *p && n < 9; p++)
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
  if (n > 8 && f[8][0] == L'1') return again();
  if (wantOpen) {
    wantOpen = 0;
    openWindow();
  }
}

// updated: the checkout's 渲染站.exe, the new one, starts once this has gone, and the station with it
static void again(void) {
  quitting = 1;
  KillTimer(hwnd, 1);
  wchar_t cmd[MAX_PATH * 2 + 64];
  FMT(cmd, L"\"%ls\" --after %lu%ls", launcher, GetCurrentProcessId(), frame ? L"" : L" /quiet");
  STARTUPINFOW si = { sizeof si };
  PROCESS_INFORMATION pi;
  if (CreateProcessW(launcher, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
  post("/quit");
  if (node) WaitForSingleObject(node, 2000);
  if (job) TerminateJobObject(job, 0);
  closeFrame();
  Shell_NotifyIconW(NIM_DELETE, &nid);
  DestroyWindow(hwnd);
}

static void quit(void) {
  if (!wcscmp(lastMode, L"busy") && MessageBoxW(hwnd, L"正在渲染。现在退出，这个任务就作废了。", TITLE, MB_OKCANCEL | MB_ICONWARNING) != IDOK) return;
  quitting = 1;
  KillTimer(hwnd, 1);
  post("/quit");
  if (node) WaitForSingleObject(node, 2000);
  // and whatever it started
  if (job) TerminateJobObject(job, 0);
  closeFrame();
  Shell_NotifyIconW(NIM_DELETE, &nid);
  DestroyWindow(hwnd);
}

static void menu(int x, int y) {
  HMENU m = CreatePopupMenu();
  AppendMenuW(m, MF_STRING, CMD_OPEN, L"打开渲染站");
  AppendMenuW(m, MF_STRING | (up ? 0 : MF_GRAYED), CMD_TOGGLE, toggleText);
  AppendMenuW(m, MF_STRING | (up && !off ? 0 : MF_GRAYED), CMD_RECONNECT, L"重新连接");
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  AppendMenuW(m, MF_STRING | (up ? 0 : MF_GRAYED), CMD_BROWSER, L"在浏览器里打开");
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
    case CMD_BROWSER:
      ShellExecuteW(NULL, L"open", L"http://127.0.0.1:7799/", NULL, NULL, SW_SHOWNORMAL);
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
  (void)args;
  int argc = 0, quiet = 0;
  DWORD after = 0;
  const wchar_t *from = NULL;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; argv && i < argc; i++) {
    if (!wcscmp(argv[i], L"/quiet")) quiet = 1;
    else if (!wcscmp(argv[i], L"--after") && i + 1 < argc) after = wcstoul(argv[++i], NULL, 10);
    else if (!wcscmp(argv[i], L"--from") && i + 1 < argc) from = argv[++i];
  }
  wantOpen = !quiet;
  GetModuleFileNameW(NULL, exePath, MAX_PATH);
  lstrcpynW(exeDir, exePath, MAX_PATH);
  wchar_t *slash = wcsrchr(exeDir, L'\\');
  if (slash) *slash = 0;

  // the last one, going after an update: once it has
  if (after) {
    HANDLE old = OpenProcess(SYNCHRONIZE, FALSE, after);
    if (old) {
      WaitForSingleObject(old, 10000);
      CloseHandle(old);
    }
  }
  // run from the copy: the checkout's file left free. From the checkout, copy over and start it
  wchar_t home[MAX_PATH], copy[MAX_PATH + 32];
  home[0] = 0;
  if (GetEnvironmentVariableW(L"LOCALAPPDATA", home, MAX_PATH)) {
    wcsncat(home, L"\\qiqi-render-station", MAX_PATH - wcslen(home) - 1);
  }
  int isCopy = home[0] && !_wcsicmp(exeDir, home);
  lstrcpynW(launcher, isCopy && from ? from : exePath, MAX_PATH);
  HANDLE running = OpenMutexW(SYNCHRONIZE, FALSE, L"Local\\qiqi-render-station-tray");
  if (!isCopy && home[0] && !running) {
    wchar_t dll[MAX_PATH + 32], dllCopy[MAX_PATH + 32];
    CreateDirectoryW(home, NULL);
    FMT(copy, L"%ls\\渲染站.exe", home);
    FMT(dll, L"%ls\\WebView2Loader.dll", exeDir);
    FMT(dllCopy, L"%ls\\WebView2Loader.dll", home);
    if (CopyFileW(exePath, copy, FALSE)) {
      CopyFileW(dll, dllCopy, FALSE);
      wchar_t cmd[MAX_PATH * 3];
      FMT(cmd, L"\"%ls\" --from \"%ls\"%ls", copy, exePath, quiet ? L" /quiet" : L"");
      STARTUPINFOW si = { sizeof si };
      PROCESS_INFORMATION pi;
      if (CreateProcessW(copy, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return 0;
      }
    }
    // could not: from here, as before
  }
  if (running) CloseHandle(running);
  CreateMutexW(NULL, TRUE, L"Local\\qiqi-render-station-tray");
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    // the one running opens its window, and may bring it to the front
    HWND other = FindWindowW(L"QiqiRenderStation", NULL);
    if (other && !quiet) {
      DWORD pid = 0;
      GetWindowThreadProcessId(other, &pid);
      AllowSetForegroundWindow(pid);
      PostMessageW(other, WM_COMMAND, CMD_OPEN, 0);
    }
    return 0;
  }

  // the checkout: two up from the checkout's 渲染站.exe
  wchar_t launcherDir[MAX_PATH], up2[MAX_PATH + 8], check[MAX_PATH + 64];
  lstrcpynW(launcherDir, launcher, MAX_PATH);
  slash = wcsrchr(launcherDir, L'\\');
  if (slash) *slash = 0;
  FMT(up2, L"%ls\\..\\..", launcherDir);
  GetFullPathNameW(up2, MAX_PATH, repo, NULL);
  FMT(check, L"%ls\\promo\\remote\\station.mjs", repo);
  if (!isFile(check)) {
    MessageBoxW(NULL, L"渲染站.exe 要留在仓库的 promo\\remote 文件夹里，和 station.mjs 放在一起。\n\n桌面上的「渲染站」是它的快捷方式，以后从那里打开就行。", TITLE, MB_ICONERROR);
    return 1;
  }
  FMT(logPath, L"%ls\\.tools\\remote\\station.log", repo);
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
  HDC screen = GetDC(NULL);
  dpi = GetDeviceCaps(screen, LOGPIXELSY);
  ReleaseDC(NULL, screen);
  DWORD light = 1, size = sizeof light;
  RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", L"AppsUseLightTheme", RRF_RT_REG_DWORD, NULL, &light, &size);
  dark = light == 0;
  // WebView2's loader, beside this
  wchar_t loader[MAX_PATH + 32];
  FMT(loader, L"%ls\\WebView2Loader.dll", exeDir);
  HMODULE wl = LoadLibraryW(loader);
  if (wl) createEnv = (CreateEnv)(void *)GetProcAddress(wl, "CreateCoreWebView2EnvironmentWithOptions");
  WNDCLASSEXW fc = { sizeof fc };
  fc.style = CS_HREDRAW | CS_VREDRAW;
  fc.lpfnWndProc = frameProc;
  fc.hInstance = inst;
  fc.hCursor = LoadCursorW(NULL, IDC_ARROW);
  fc.hbrBackground = CreateSolidBrush(dark ? RGB(0x17, 0x12, 0x16) : RGB(0xf8, 0xf6, 0xf5));
  fc.hIcon = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), 0);
  fc.hIconSm = icons[ICON_BUSY];
  fc.lpszClassName = L"QiqiRenderStationWindow";
  RegisterClassExW(&fc);

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
