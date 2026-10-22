// The installer, render-station-setup-<version>.exe: this program with a release appended (a gzipped
// tar of all an installed copy holds: the station, its window's fonts, Node.js, the signed
// release.json), then the version, the tar's size and a mark. Once the owner agrees, it has a running
// station quit (the one from before the station left qiqi.help too), unpacks the tar into
// %LOCALAPPDATA%\Programs\render-station\ with Windows' own tar.exe, brings over the settings of a
// station set up before, adds the station to Windows' installed apps (渲染站.exe --uninstall removes
// it) and starts it. Per user: no administrator is needed, and the station updates itself there.
// Built by exe/build.mjs; release/build.mjs appends the release.
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>
#include "common.h"

#define FMT(buf, ...) (_snwprintf(buf, sizeof buf / sizeof *buf - 1, __VA_ARGS__), buf[sizeof buf / sizeof *buf - 1] = 0)
#define TITLE L"渲染站安装程序"
// the end of this file: the version (32 bytes, UTF-8, NUL-padded), the tar's size (8, little-endian), the mark
#define MARK "RSSETUP1"
#define TAIL 48

static HINSTANCE inst;
static wchar_t exePath[MAX_PATH], dir[MAX_PATH], version[40];
static ULONGLONG payloadAt, payloadSize;
// the work, on a thread of its own while the dialog shows it going
static volatile LONG finished;
static wchar_t failure[1024];

static int isFile(const wchar_t *path) {
  DWORD a = GetFileAttributesW(path);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}
static void fail(const wchar_t *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  _vsnwprintf(failure, 1023, fmt, ap);
  va_end(ap);
  failure[1023] = 0;
}

/** the release appended to this program: where it starts, its size, its version */
static int findPayload(void) {
  HANDLE f = CreateFileW(exePath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (f == INVALID_HANDLE_VALUE) return 0;
  LARGE_INTEGER size, at;
  char tail[TAIL];
  DWORD got = 0;
  int ok = GetFileSizeEx(f, &size) && size.QuadPart > TAIL;
  if (ok) {
    at.QuadPart = size.QuadPart - TAIL;
    ok = SetFilePointerEx(f, at, NULL, FILE_BEGIN) && ReadFile(f, tail, TAIL, &got, NULL) && got == TAIL && !memcmp(tail + 40, MARK, 8);
  }
  CloseHandle(f);
  if (!ok) return 0;
  memcpy(&payloadSize, tail + 32, 8);
  if (!payloadSize || payloadSize > (ULONGLONG)size.QuadPart - TAIL) return 0;
  payloadAt = (ULONGLONG)size.QuadPart - TAIL - payloadSize;
  char v[33] = { 0 };
  memcpy(v, tail, 32);
  MultiByteToWideChar(CP_UTF8, 0, v, -1, version, 40);
  return 1;
}

/** the release, copied out of this program to `to` */
static int writePayload(const wchar_t *to) {
  static char buf[1 << 20];
  HANDLE in = CreateFileW(exePath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_SEQUENTIAL_SCAN, NULL);
  if (in == INVALID_HANDLE_VALUE) return 0;
  HANDLE out = CreateFileW(to, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, NULL);
  if (out == INVALID_HANDLE_VALUE) {
    CloseHandle(in);
    return 0;
  }
  LARGE_INTEGER at;
  at.QuadPart = (LONGLONG)payloadAt;
  ULONGLONG left = payloadSize;
  if (SetFilePointerEx(in, at, NULL, FILE_BEGIN))
    while (left) {
      DWORD n = left > sizeof buf ? (DWORD)sizeof buf : (DWORD)left, got = 0, put = 0;
      if (!ReadFile(in, buf, n, &got, NULL) || got != n || !WriteFile(out, buf, n, &put, NULL) || put != n) break;
      left -= n;
    }
  CloseHandle(in);
  CloseHandle(out);
  return left == 0;
}

/** the release unpacked into the installed folder, by Windows' tar.exe (Windows 10 1803 and later);
 *  run there, so that it is given no path but names of its own */
static int unpack(void) {
  wchar_t tar[MAX_PATH + 16], cmd[MAX_PATH + 64];
  GetSystemDirectoryW(tar, MAX_PATH);
  wcsncat(tar, L"\\tar.exe", 15);
  if (!isFile(tar)) {
    fail(L"找不到系统的 tar.exe。本安装程序需要 Windows 10 1803 或更高版本。");
    return 0;
  }
  FMT(cmd, L"\"%ls\" -xf .setup.tar.gz", tar);
  STARTUPINFOW si = { sizeof si };
  PROCESS_INFORMATION pi;
  if (!CreateProcessW(tar, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, dir, &si, &pi)) {
    fail(L"无法运行 tar.exe（错误代码 %lu）。", GetLastError());
    return 0;
  }
  WaitForSingleObject(pi.hProcess, INFINITE);
  DWORD code = 1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  if (code) fail(L"解压安装数据失败（tar.exe 返回 %lu）。请确认渲染站已退出，然后重新运行安装程序。", code);
  return !code;
}

/** the settings of a station set up before, if this copy has none: those of the one from before the
 *  station left qiqi.help (its tray program in the checkout's promo\remote), or of one run from a
 *  checkout of its own; found by what starts it with Windows */
static void bringSettings(void) {
  wchar_t mine[MAX_PATH + 64], folder[MAX_PATH + 32];
  FMT(mine, L"%ls\\.tools\\remote\\config.json", dir);
  if (isFile(mine)) return;
  const wchar_t *names[] = { OLD_RUN_NAME, RUN_NAME };
  const int up[] = { 2, 0 };
  for (int i = 0; i < 2; i++) {
    wchar_t v[MAX_PATH * 2], theirs[MAX_PATH * 2 + 64];
    DWORD size = sizeof v;
    if (RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, names[i], RRF_RT_REG_SZ, NULL, v, &size) != ERROR_SUCCESS) continue;
    // "<folder>\渲染站.exe" /quiet: the folder, and as far up as the checkout
    wchar_t *p = v;
    if (*p == L'"') {
      p++;
      wchar_t *q = wcschr(p, L'"');
      if (q) *q = 0;
    }
    int levels = up[i] + 1;
    for (int n = 0; n < levels; n++) {
      wchar_t *cut = wcsrchr(p, L'\\');
      if (cut) *cut = 0;
    }
    if (!_wcsicmp(p, dir)) continue;
    FMT(theirs, L"%ls\\.tools\\remote\\config.json", p);
    if (!isFile(theirs)) continue;
    FMT(folder, L"%ls\\.tools\\remote", dir);
    SHCreateDirectoryExW(NULL, folder, NULL);
    if (CopyFileW(theirs, mine, TRUE)) return;
  }
}

static void setString(HKEY k, const wchar_t *name, const wchar_t *value) {
  RegSetValueExW(k, name, 0, REG_SZ, (const BYTE *)value, (DWORD)((wcslen(value) + 1) * sizeof(wchar_t)));
}
static void setNumber(HKEY k, const wchar_t *name, DWORD value) {
  RegSetValueExW(k, name, 0, REG_DWORD, (const BYTE *)&value, sizeof value);
}
/** the station in Windows' installed apps, with its uninstaller */
static void registerApp(void) {
  HKEY k;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, UNINSTALL_KEY, 0, NULL, 0, KEY_SET_VALUE, NULL, &k, NULL) != ERROR_SUCCESS) return;
  wchar_t icon[MAX_PATH + 32], remove[MAX_PATH + 48], date[16];
  SYSTEMTIME t;
  GetLocalTime(&t);
  FMT(icon, L"%ls\\渲染站.exe,0", dir);
  FMT(remove, L"\"%ls\\渲染站.exe\" --uninstall", dir);
  FMT(date, L"%04u%02u%02u", t.wYear, t.wMonth, t.wDay);
  setString(k, L"DisplayName", L"渲染站");
  setString(k, L"DisplayVersion", version);
  setString(k, L"Publisher", L"daum110715");
  setString(k, L"DisplayIcon", icon);
  setString(k, L"InstallLocation", dir);
  setString(k, L"UninstallString", remove);
  setString(k, L"URLInfoAbout", L"https://github.com/daum110715/render-station");
  setString(k, L"InstallDate", date);
  setNumber(k, L"NoModify", 1);
  setNumber(k, L"NoRepair", 1);
  // unpacked, about three times the tar's size
  setNumber(k, L"EstimatedSize", (DWORD)(payloadSize * 3 / 1024));
  RegCloseKey(k);
}

static DWORD WINAPI work(LPVOID unused) {
  (void)unused;
  wchar_t archive[MAX_PATH + 32];
  int made = SHCreateDirectoryExW(NULL, dir, NULL);
  FMT(archive, L"%ls\\.setup.tar.gz", dir);
  if (made != ERROR_SUCCESS && made != ERROR_ALREADY_EXISTS) fail(L"无法创建安装目录（错误代码 %d）：\n%ls", made, dir);
  else if (!writePayload(archive)) fail(L"无法写入安装数据（错误代码 %lu）。", GetLastError());
  else if (unpack()) {
    bringSettings();
    registerApp();
  }
  DeleteFileW(archive);
  InterlockedExchange(&finished, 1);
  return 0;
}
static HRESULT CALLBACK progress(HWND h, UINT msg, WPARAM wp, LPARAM lp, LONG_PTR ref) {
  (void)wp;
  (void)lp;
  (void)ref;
  if (msg == TDN_CREATED) {
    SendMessageW(h, TDM_SET_PROGRESS_BAR_MARQUEE, TRUE, 0);
    SendMessageW(h, TDM_ENABLE_BUTTON, IDCLOSE, FALSE);
    HANDLE t = CreateThread(NULL, 0, work, NULL, 0, NULL);
    if (t) CloseHandle(t);
    else {
      fail(L"无法开始安装（错误代码 %lu）。", GetLastError());
      InterlockedExchange(&finished, 1);
    }
  } else if (msg == TDN_TIMER && finished) {
    SendMessageW(h, TDM_ENABLE_BUTTON, IDCLOSE, TRUE);
    SendMessageW(h, TDM_CLICK_BUTTON, IDCLOSE, 0);
  } else if (msg == TDN_BUTTON_CLICKED && !finished)
    // not closed while at work
    return S_FALSE;
  return S_OK;
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE prev, PWSTR args, int how) {
  (void)prev;
  (void)args;
  (void)how;
  inst = hi;
  GetModuleFileNameW(NULL, exePath, MAX_PATH);
  wchar_t base[MAX_PATH];
  if (!GetEnvironmentVariableW(L"LOCALAPPDATA", base, MAX_PATH)) {
    MessageBoxW(NULL, L"无法确定当前用户的应用数据目录（LOCALAPPDATA）。", TITLE, MB_ICONERROR);
    return 1;
  }
  FMT(dir, L"%ls\\Programs\\render-station", base);
  if (!findPayload()) {
    MessageBoxW(NULL, L"安装程序不完整，找不到安装数据。请重新下载安装程序。", TITLE, MB_ICONERROR);
    return 1;
  }

  // ——— asked first ———
  wchar_t check[MAX_PATH + 32], heading[96], content[MAX_PATH + 256];
  FMT(check, L"%ls\\release.json", dir);
  int updating = isFile(check);
  int running = stationRunning();
  FMT(heading, updating ? L"将渲染站更新到 %ls" : L"安装渲染站 %ls", version);
  FMT(content, L"安装位置：%ls\n\n渲染站按当前用户安装，无需管理员权限。安装完成后将自动启动。%ls", dir, running ? L"\n\n正在运行的渲染站将被关闭。" : L"");
  TASKDIALOG_BUTTON go[] = { { IDOK, updating ? L"更新" : L"安装" } };
  TASKDIALOGCONFIG ask = { sizeof ask };
  ask.hInstance = inst;
  ask.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION;
  ask.dwCommonButtons = TDCBF_CANCEL_BUTTON;
  ask.pszWindowTitle = TITLE;
  ask.pszMainIcon = MAKEINTRESOURCEW(1);
  ask.pszMainInstruction = heading;
  ask.pszContent = content;
  ask.pButtons = go;
  ask.cButtons = 1;
  int pressed = 0;
  if (FAILED(TaskDialogIndirect(&ask, &pressed, NULL, NULL)) || pressed != IDOK) return 0;

  // ——— the station that runs, quit; then the work, shown going ———
  while (stationRunning() && !stopStation())
    if (MessageBoxW(NULL, L"无法关闭正在运行的渲染站。请从托盘菜单退出渲染站，然后单击「重试」。", TITLE, MB_RETRYCANCEL | MB_ICONWARNING) != IDRETRY) return 1;
  TASKDIALOGCONFIG doing = { sizeof doing };
  doing.hInstance = inst;
  doing.dwFlags = TDF_SHOW_MARQUEE_PROGRESS_BAR | TDF_CALLBACK_TIMER;
  doing.dwCommonButtons = TDCBF_CLOSE_BUTTON;
  doing.pszWindowTitle = TITLE;
  doing.pszMainIcon = MAKEINTRESOURCEW(1);
  doing.pszMainInstruction = updating ? L"正在更新渲染站…" : L"正在安装渲染站…";
  doing.pszContent = L"正在解压程序文件，请稍候。";
  doing.pfCallback = progress;
  TaskDialogIndirect(&doing, NULL, NULL, NULL);
  if (failure[0]) {
    MessageBoxW(NULL, failure, TITLE, MB_ICONERROR);
    return 1;
  }

  // ——— and started: its window opens ———
  wchar_t station[MAX_PATH + 32];
  FMT(station, L"%ls\\渲染站.exe", dir);
  if ((INT_PTR)ShellExecuteW(NULL, L"open", station, NULL, dir, SW_SHOWNORMAL) <= 32) {
    FMT(content, L"渲染站 %ls 已安装，但未能自动启动。请从开始菜单或以下位置启动：\n%ls", version, station);
    MessageBoxW(NULL, content, TITLE, MB_ICONWARNING);
  }
  return 0;
}
