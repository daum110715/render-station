// 渲染站.exe, the render station's tray icon on the Windows machine that takes the server's heavy
// work, and what its owner double-clicks. It starts the station (station.mjs, with node) with no
// window at all, starts it again whenever it stops, and shows in its colour how it is doing (green
// waiting, purple at work, amber connecting, red stuck, grey paused); a click opens the station's window: a
// window of its own with no frame but the page's (station.html in WebView2, through
// WebView2Loader.dll beside it), or failing that Edge's app window. The page drags it, minimizes
// and closes it, and opens what a job made, by messages. It keeps what the settings ask for: starting with
// Windows (a value under HKCU\...\Run, so it shows in Task Manager's startup apps) and 渲染站 on
// the desktop and in the Start menu. The station and all it starts (ssh, the jobs and what they
// start) run in a job object, so quitting, or this ending any other way, ends them too. Only one
// runs: a second one opens the window and goes. It stays in the checkout beside station.mjs, but runs
// from a copy of itself in %LOCALAPPDATA%\render-station\ (it copies itself there, with the
// loader, and starts the copy), so the checkout's file is never held and an update can replace it;
// when the station has updated it, the copy starts the checkout's again (--after) and goes. In a
// copy the installer put in place (release.json beside it) it runs the Node.js that came with it
// (node\node.exe), and --uninstall removes that copy and all the station told Windows.
// It asks Windows' User Account Control at each start to run as administrator (unless the overview
// page's switch said not to: .tools\remote\no-elevate in the checkout), and runs as it is if the
// owner says no; the page can have it start again as administrator later.
// --try: a trial of a new build beside the station running here, as exe/build.mjs --try starts it on
// the device: its window on that station's page, with an icon of its own to open it again, and
// nothing else of a station's (no node, no settings kept, no User Account Control); its log and
// WebView2's data in %LOCALAPPDATA%\render-station\try. A trial started again has the one before go
// first; one whose window has been closed for five minutes goes by itself.
// Built with mingw-w64, on the device or on Linux: node exe/build.mjs
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
#include <commctrl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <dwmapi.h>
#include <wincodec.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include "WebView2.h"
#include "common.h"

#define UI_PORT 7799
#define WM_TRAY (WM_APP + 1)
#define TITLE L"渲染站"
// a trial's names, which no station looks for
#define TRY_CLASS L"RenderStationTry"
#define TRY_MUTEX L"Local\\render-station-try"
// the task in Task Scheduler that 0.5.0 made to start it as administrator, removed
#define ELEVATE_TASK L"RenderStation"
// where the window was, and whether maximized: it opens there again
#define PLACE_KEY L"Software\\render-station"
// a closed window is hidden, and let go five minutes on: opened again before, it shows at once
#define DISPOSE_MS (5 * 60 * 1000)
enum { CMD_OPEN = 1, CMD_TOGGLE, CMD_RECONNECT, CMD_BROWSER, CMD_LOG, CMD_QUIT };
// the window's timers (the last, to let a closed window go), and its word to itself to give up on WebView2
enum { TIMER_RETRY = 2, TIMER_WATCH, TIMER_DISPOSE };
#define WM_GIVE_UP (WM_APP + 2)
// the page's word to start again as administrator
#define WM_ELEVATE (WM_APP + 3)
// the icons, as station.rc numbers them less one
enum { ICON_BUSY, ICON_IDLE, ICON_WAIT, ICON_BAD, ICON_OFF, ICONS };

// wide formatting that always ends the string
#define FMT(buf, ...) (_snwprintf(buf, sizeof buf / sizeof *buf - 1, __VA_ARGS__), buf[sizeof buf / sizeof *buf - 1] = 0)

static HINSTANCE inst;
static HWND hwnd;
static UINT taskbarCreated;
static NOTIFYICONDATAW nid;
// by state: the tray's (small) and the window's (big), and the one shown
static HICON icons[ICONS], bigIcons[ICONS];
static int iconNow = ICON_OFF;
static wchar_t exePath[MAX_PATH], exeDir[MAX_PATH], repo[MAX_PATH], nodePath[MAX_PATH];
// the checkout's 渲染站.exe: what the shortcuts and starting with Windows start
static wchar_t launcher[MAX_PATH];
static void again(void);
static void leave(void);

static HANDLE job, node;
static ULONGLONG startedAt, shownAt;
static int fails, gaveUp, quitting, wantOpen, up, off, seen;
// a trial (--try), and its folder
static int trying;
static wchar_t tryDir[MAX_PATH + 32];
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
// the page loaded; the window closed and hidden; maximized, as the page was last told; to open maximized
static int loaded, hidden, toldZoom = -1, openZoomed;
// the page's look, as it last told (kept for the next window, so it opens in its colours): its ground,
// under it as it loads and is sized; its edge, Windows 11's border round it; whether it is dark; and
// its states' colours, the icons'
static struct {
  COLORREF ground, edge;
  DWORD dark, edged;
  COLORREF tone[ICONS];
  DWORD toned;
} look;
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
static wchar_t toggleText[32] = L"暂停接收任务", lastMode[16], lastKey[64];

static int isFile(const wchar_t *p) {
  DWORD a = GetFileAttributesW(p);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

// ——— talking to the station: HTTP/1.0 on 127.0.0.1, with a body of `type` if there is one, the
// reply's body in buf ———
static int sendAll(SOCKET s, const char *data, int len) {
  for (int r; len > 0; data += r, len -= r)
    if ((r = send(s, data, len, 0)) <= 0) return -1;
  return 0;
}
static int request(const char *method, const char *path, const char *type, const char *data, int len, char *buf, int cap) {
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
  char req[384];
  int n = snprintf(req, sizeof req, "%s %s HTTP/1.0\r\nHost: 127.0.0.1:%d\r\nx-station: 1\r\n%s%s%sContent-Length: %d\r\n\r\n", method, path, UI_PORT, type ? "Content-Type: " : "", type ? type : "", type ? "\r\n" : "", len);
  if (sendAll(s, req, n) || (len && sendAll(s, data, len))) {
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
static int call(const char *method, const char *path, char *buf, int cap) {
  return request(method, path, NULL, NULL, 0, buf, cap);
}
static void post(const char *path) {
  char buf[512];
  call("POST", path, buf, sizeof buf);
}

// ——— the clipboard, in step with the server's while the settings say so (/tray): what is copied here
// goes to the station (/clip: text, or a picture as PNG), which sends it on to the server; what the
// server sends, the station puts on it with this program (--clip-set), marked so it does not go back.
// What a password manager marks as not to be kept or shared is passed by ———
#define CLIP_MAX (20 * 1024 * 1024)
#define CLIP_MARK L"RenderStation.Clip"
static int clipOn;
static int clipHas(const wchar_t *name) {
  return IsClipboardFormatAvailable(RegisterClipboardFormatW(name));
}
/** a format there that, as a number, says 0 (CanIncludeInClipboardHistory and its kind) */
static int clipSaysNo(const wchar_t *name) {
  UINT f = RegisterClipboardFormatW(name);
  HANDLE h = IsClipboardFormatAvailable(f) ? GetClipboardData(f) : NULL;
  DWORD *v = h ? GlobalLock(h) : NULL;
  int no = v && GlobalSize(h) >= sizeof(DWORD) && *v == 0;
  if (v) GlobalUnlock(h);
  return no;
}
/** the clipboard opened, as soon as whoever has it open lets go */
static int clipOpen(HWND owner) {
  for (int i = 0; i < 20; i++) {
    if (OpenClipboard(owner)) return 1;
    Sleep(25);
  }
  return 0;
}
static IWICImagingFactory *wic(void) {
  static IWICImagingFactory *f;
  if (!f) CoCreateInstance(&CLSID_WICImagingFactory, NULL, CLSCTX_INPROC_SERVER, &IID_IWICImagingFactory, (void **)&f);
  return f;
}
/** a picture as PNG, in global memory (its size in `size`), or NULL */
static HGLOBAL toPng(IWICBitmapSource *src, DWORD *size) {
  IWICImagingFactory *f = wic();
  IStream *st = NULL;
  IWICBitmapEncoder *enc = NULL;
  IWICBitmapFrameEncode *frame = NULL;
  IWICFormatConverter *conv = NULL;
  HGLOBAL out = NULL;
  UINT w = 0, h = 0;
  WICPixelFormatGUID fmt = GUID_WICPixelFormat24bppBGR;
  // the frame says which of its formats is nearest: the picture converted to that one
  int ok = f && SUCCEEDED(CreateStreamOnHGlobal(NULL, FALSE, &st)) && SUCCEEDED(IWICImagingFactory_CreateEncoder(f, &GUID_ContainerFormatPng, NULL, &enc)) &&
           SUCCEEDED(IWICBitmapEncoder_Initialize(enc, st, WICBitmapEncoderNoCache)) && SUCCEEDED(IWICBitmapEncoder_CreateNewFrame(enc, &frame, NULL)) &&
           SUCCEEDED(IWICBitmapFrameEncode_Initialize(frame, NULL)) && SUCCEEDED(IWICBitmapSource_GetSize(src, &w, &h)) && SUCCEEDED(IWICBitmapFrameEncode_SetSize(frame, w, h)) &&
           SUCCEEDED(IWICBitmapFrameEncode_SetPixelFormat(frame, &fmt)) && SUCCEEDED(IWICImagingFactory_CreateFormatConverter(f, &conv)) &&
           SUCCEEDED(IWICFormatConverter_Initialize(conv, src, &fmt, WICBitmapDitherTypeNone, NULL, 0.0, WICBitmapPaletteTypeCustom)) &&
           SUCCEEDED(IWICBitmapFrameEncode_WriteSource(frame, (IWICBitmapSource *)conv, NULL)) && SUCCEEDED(IWICBitmapFrameEncode_Commit(frame)) && SUCCEEDED(IWICBitmapEncoder_Commit(enc));
  STATSTG stat;
  if (st && SUCCEEDED(GetHGlobalFromStream(st, &out)) && !(ok && SUCCEEDED(IStream_Stat(st, &stat, STATFLAG_NONAME)) && (*size = (DWORD)stat.cbSize.QuadPart))) {
    GlobalFree(out);
    out = NULL;
  }
  if (conv) IWICFormatConverter_Release(conv);
  if (frame) IWICBitmapFrameEncode_Release(frame);
  if (enc) IWICBitmapEncoder_Release(enc);
  if (st) IStream_Release(st);
  return out;
}
/** a picture's bytes (whatever WIC reads: PNG, JPEG, BMP, GIF…) as a DIB, 32 bits a pixel and bottom
 *  up, what is transparent laid on white (for what takes no transparency), or NULL */
static HGLOBAL toDib(const char *bytes, DWORD len) {
  IWICImagingFactory *f = wic();
  IWICStream *st = NULL;
  IWICBitmapDecoder *dec = NULL;
  IWICBitmapFrameDecode *frame = NULL;
  IWICFormatConverter *conv = NULL;
  HGLOBAL out = NULL;
  BYTE *rows = NULL;
  UINT w = 0, h = 0;
  if (f && SUCCEEDED(IWICImagingFactory_CreateStream(f, &st)) && SUCCEEDED(IWICStream_InitializeFromMemory(st, (BYTE *)bytes, len)) &&
      SUCCEEDED(IWICImagingFactory_CreateDecoderFromStream(f, (IStream *)st, NULL, WICDecodeMetadataCacheOnDemand, &dec)) && SUCCEEDED(IWICBitmapDecoder_GetFrame(dec, 0, &frame)) &&
      SUCCEEDED(IWICImagingFactory_CreateFormatConverter(f, &conv)) &&
      SUCCEEDED(IWICFormatConverter_Initialize(conv, (IWICBitmapSource *)frame, &GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, NULL, 0.0, WICBitmapPaletteTypeCustom)) &&
      SUCCEEDED(IWICBitmapSource_GetSize((IWICBitmapSource *)conv, &w, &h)) && w && h && (ULONGLONG)w * h * 4 <= 256ULL * 1024 * 1024) {
    UINT stride = w * 4;
    SIZE_T px = (SIZE_T)stride * h;
    rows = malloc(px);
    out = rows ? GlobalAlloc(GMEM_MOVEABLE, sizeof(BITMAPINFOHEADER) + px) : NULL;
    BYTE *p = out ? GlobalLock(out) : NULL;
    if (p && SUCCEEDED(IWICBitmapSource_CopyPixels((IWICBitmapSource *)conv, NULL, stride, (UINT)px, rows))) {
      BITMAPINFOHEADER *bi = (BITMAPINFOHEADER *)p;
      ZeroMemory(bi, sizeof *bi);
      bi->biSize = sizeof *bi;
      bi->biWidth = (LONG)w;
      bi->biHeight = (LONG)h;
      bi->biPlanes = 1;
      bi->biBitCount = 32;
      bi->biCompression = BI_RGB;
      bi->biSizeImage = (DWORD)px;
      // WIC's rows from the top, a DIB's from the bottom
      for (UINT y = 0; y < h; y++) memcpy(p + sizeof *bi + (SIZE_T)(h - 1 - y) * stride, rows + (SIZE_T)y * stride, stride);
      for (BYTE *c = p + sizeof *bi, *end = c + px; c < end; c += 4) {
        if (c[3] == 255) continue;
        for (int k = 0; k < 3; k++) c[k] = (BYTE)((c[k] * c[3] + 255 * (255 - c[3])) / 255);
        c[3] = 255;
      }
      GlobalUnlock(out);
    } else if (out) {
      if (p) GlobalUnlock(out);
      GlobalFree(out);
      out = NULL;
    }
  }
  free(rows);
  if (conv) IWICFormatConverter_Release(conv);
  if (frame) IWICBitmapFrameDecode_Release(frame);
  if (dec) IWICBitmapDecoder_Release(dec);
  if (st) IWICStream_Release(st);
  return out;
}
/** copied here: the text (UTF-8), else the picture (PNG: as it is if the copier gave one, else
 *  made from the bitmap), to the station; what the server wrote, or what is not to be kept, not */
static void clipChanged(void) {
  if (!clipOn || trying || quitting || !clipOpen(hwnd)) return;
  if (clipHas(CLIP_MARK) || clipHas(L"ExcludeClipboardContentFromMonitorProcessing") || clipHas(L"Clipboard Viewer Ignore") || clipSaysNo(L"CanIncludeInClipboardHistory") ||
      clipSaysNo(L"CanUploadToCloudClipboard")) {
    CloseClipboard();
    return;
  }
  char *data = NULL;
  DWORD size = 0;
  const char *type = "image/png";
  IWICBitmap *bmp = NULL;
  UINT png = RegisterClipboardFormatW(L"PNG");
  HANDLE h;
  if (IsClipboardFormatAvailable(CF_UNICODETEXT) && (h = GetClipboardData(CF_UNICODETEXT))) {
    const wchar_t *text = GlobalLock(h);
    if (text) {
      int chars = (int)wcsnlen(text, GlobalSize(h) / sizeof(wchar_t));
      int n = chars ? WideCharToMultiByte(CP_UTF8, 0, text, chars, NULL, 0, NULL, NULL) : 0;
      if (n > 0 && n <= CLIP_MAX && (data = malloc(n))) size = (DWORD)WideCharToMultiByte(CP_UTF8, 0, text, chars, data, n, NULL, NULL);
      GlobalUnlock(h);
    }
    type = "text/plain; charset=utf-8";
  } else if (IsClipboardFormatAvailable(png) && (h = GetClipboardData(png))) {
    const char *bytes = GlobalLock(h);
    SIZE_T n = GlobalSize(h);
    if (bytes && n && n <= CLIP_MAX && (data = malloc(n))) {
      memcpy(data, bytes, n);
      size = (DWORD)n;
    }
    if (bytes) GlobalUnlock(h);
  } else if (IsClipboardFormatAvailable(CF_BITMAP) && (h = GetClipboardData(CF_BITMAP)) && wic())
    IWICImagingFactory_CreateBitmapFromHBITMAP(wic(), (HBITMAP)h, NULL, WICBitmapIgnoreAlpha, &bmp);
  CloseClipboard();
  if (bmp) {
    HGLOBAL made = toPng((IWICBitmapSource *)bmp, &size);
    IWICBitmap_Release(bmp);
    const char *bytes = made ? GlobalLock(made) : NULL;
    if (bytes && size <= CLIP_MAX && (data = malloc(size))) memcpy(data, bytes, size);
    if (bytes) GlobalUnlock(made);
    if (made) GlobalFree(made);
  }
  char reply[256];
  if (data && size) request("POST", "/clip", type, data, (int)size, reply, sizeof reply);
  free(data);
}
/** --clip-set <file> text|image: the file's text (UTF-8), or picture, put on the clipboard as the
 *  server's: 0; 2 if the clipboard would not open, 3 if the picture could not be read, 1 else */
static int clipSet(const wchar_t *file, int image) {
  HANDLE fh = CreateFileW(file, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (fh == INVALID_HANDLE_VALUE) return 1;
  DWORD len = GetFileSize(fh, NULL), got = 0;
  char *bytes = len <= CLIP_MAX ? malloc(len + 1) : NULL;
  int read = bytes && ReadFile(fh, bytes, len, &got, NULL) && got == len;
  CloseHandle(fh);
  if (!read) {
    free(bytes);
    return 1;
  }
  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
  HGLOBAL first = NULL, asPng = NULL;
  if (!image) {
    int n = len ? MultiByteToWideChar(CP_UTF8, 0, bytes, (int)len, NULL, 0) : 0;
    first = GlobalAlloc(GMEM_MOVEABLE, ((SIZE_T)n + 1) * sizeof(wchar_t));
    wchar_t *w = first ? GlobalLock(first) : NULL;
    if (w) {
      if (n) MultiByteToWideChar(CP_UTF8, 0, bytes, (int)len, w, n);
      w[n] = 0;
      GlobalUnlock(first);
    }
  } else {
    first = toDib(bytes, len);
    // a PNG as it is too, transparency and all, for what takes one
    if (first && len > 8 && !memcmp(bytes, "\x89PNG", 4) && (asPng = GlobalAlloc(GMEM_MOVEABLE, len))) {
      void *p = GlobalLock(asPng);
      memcpy(p, bytes, len);
      GlobalUnlock(asPng);
    }
  }
  free(bytes);
  if (!first) return image ? 3 : 1;
  HWND owner = CreateWindowExW(0, L"STATIC", NULL, 0, 0, 0, 0, 0, HWND_MESSAGE, NULL, inst, NULL);
  if (!clipOpen(owner)) return 2;
  EmptyClipboard();
  SetClipboardData(image ? CF_DIB : CF_UNICODETEXT, first);
  if (asPng) SetClipboardData(RegisterClipboardFormatW(L"PNG"), asPng);
  HGLOBAL mark = GlobalAlloc(GMEM_MOVEABLE, 1);
  if (mark) SetClipboardData(RegisterClipboardFormatW(CLIP_MARK), mark);
  CloseClipboard();
  return 0;
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
// the window's icon, the tray's: the state's
static void windowIcon(void) {
  if (!frame) return;
  SendMessageW(frame, WM_SETICON, ICON_SMALL, (LPARAM)icons[iconNow]);
  SendMessageW(frame, WM_SETICON, ICON_BIG, (LPARAM)bigIcons[iconNow]);
}
static void show(int icon, const wchar_t *tip) {
  if (iconNow == icon && nid.hIcon == icons[icon] && !wcscmp(nid.szTip, tip)) return;
  iconNow = icon;
  nid.hIcon = icons[icon];
  lstrcpynW(nid.szTip, tip, 128);
  nid.uFlags = NIF_ICON | NIF_TIP | NIF_SHOWTIP;
  Shell_NotifyIconW(NIM_MODIFY, &nid);
  windowIcon();
}
// a dot in a colour with the play mark in white, as exe/build.mjs draws station.rc's: on a 32-unit
// square, the circle (16, 16, r 15) and the mark, 8×8 samples a pixel
static int inMark(double x, double y) {
  static const double m[3][2] = { { 12.5, 9 }, { 23.5, 16 }, { 12.5, 23 } };
  double d[3];
  for (int k = 0; k < 3; k++) {
    const double *a = m[k], *b = m[(k + 1) % 3];
    d[k] = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  }
  return (d[0] >= 0 && d[1] >= 0 && d[2] >= 0) || (d[0] <= 0 && d[1] <= 0 && d[2] <= 0);
}
static HICON drawDot(COLORREF c, int size) {
  BITMAPINFO bi = { { sizeof bi.bmiHeader, size, -size, 1, 32, BI_RGB, 0, 0, 0, 0, 0 }, { { 0 } } };
  void *bits;
  HBITMAP color = CreateDIBSection(NULL, &bi, DIB_RGB_COLORS, &bits, NULL, 0);
  if (!color) return NULL;
  BYTE *px = bits;
  memset(px, 0, (size_t)size * size * 4);
  int r = GetRValue(c), g = GetGValue(c), b = GetBValue(c);
  for (int y = 0; y < size; y++)
    for (int x = 0; x < size; x++) {
      int disc = 0, mark = 0;
      for (int j = 0; j < 8; j++)
        for (int i = 0; i < 8; i++) {
          double u = (x + (i + 0.5) / 8) * 32 / size, v = (y + (j + 0.5) / 8) * 32 / size;
          if ((u - 16) * (u - 16) + (v - 16) * (v - 16) > 15 * 15) continue;
          disc++;
          mark += inMark(u, v);
        }
      BYTE *o = px + (y * size + x) * 4;
      if (!disc) continue;
      double white = (double)mark / disc;
      o[0] = (BYTE)(b + (255 - b) * white + 0.5);
      o[1] = (BYTE)(g + (255 - g) * white + 0.5);
      o[2] = (BYTE)(r + (255 - r) * white + 0.5);
      o[3] = (BYTE)(disc * 255 / 64.0 + 0.5);
    }
  // the mask, all clear: the colours' own alpha says what shows
  static const BYTE clear[32 * 256];
  HBITMAP mask = CreateBitmap(size, size, 1, 1, clear);
  ICONINFO ii = { TRUE, 0, 0, mask, color };
  HICON icon = CreateIconIndirect(&ii);
  DeleteObject(mask);
  DeleteObject(color);
  return icon;
}
// the icons in the page's colours, as it last told; the tray's and the window's put back in them
static void paintIcons(void) {
  if (!look.toned) return;
  int small = GetSystemMetrics(SM_CXSMICON), big = GetSystemMetrics(SM_CXICON);
  HICON was[2][ICONS];
  memcpy(was[0], icons, sizeof icons);
  memcpy(was[1], bigIcons, sizeof bigIcons);
  for (int i = 0; i < ICONS; i++) {
    HICON s = drawDot(look.tone[i], small), l = drawDot(look.tone[i], big);
    if (s && l) {
      icons[i] = s;
      bigIcons[i] = l;
    } else {
      if (s) DestroyIcon(s);
      if (l) DestroyIcon(l);
      was[0][i] = was[1][i] = NULL;
    }
  }
  if (nid.hIcon) {
    nid.hIcon = icons[iconNow];
    nid.uFlags = NIF_ICON;
    Shell_NotifyIconW(NIM_MODIFY, &nid);
  }
  windowIcon();
  for (int i = 0; i < ICONS; i++) {
    if (was[0][i]) DestroyIcon(was[0][i]);
    if (was[1][i]) DestroyIcon(was[1][i]);
  }
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
  wchar_t log[MAX_PATH + 96];
  FMT(log, L"\"%ls\"", logPath);
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
// where it is, kept for the next: its place unmaximized, and whether maximized
static void savePlace(void) {
  WINDOWPLACEMENT wp = { sizeof wp };
  if (!frame || hidden || !GetWindowPlacement(frame, &wp)) return;
  int zoomed = wp.showCmd == SW_SHOWMAXIMIZED || (wp.showCmd == SW_SHOWMINIMIZED && (wp.flags & WPF_RESTORETOMAXIMIZED));
  wp.showCmd = zoomed ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL;
  wp.flags = 0;
  RegSetKeyValueW(HKEY_CURRENT_USER, PLACE_KEY, trying ? L"window-try" : L"window", REG_BINARY, &wp, sizeof wp);
}
// …and put back, if a screen still shows it (hidden yet: the page shows it once loaded)
static void restorePlace(void) {
  WINDOWPLACEMENT wp;
  DWORD size = sizeof wp;
  openZoomed = 0;
  if (RegGetValueW(HKEY_CURRENT_USER, PLACE_KEY, trying ? L"window-try" : L"window", RRF_RT_REG_BINARY, NULL, &wp, &size) != ERROR_SUCCESS || size != sizeof wp || wp.length != sizeof wp) return;
  if (!MonitorFromRect(&wp.rcNormalPosition, MONITOR_DEFAULTTONULL)) return;
  openZoomed = wp.showCmd == SW_SHOWMAXIMIZED;
  wp.showCmd = SW_HIDE;
  wp.flags = 0;
  SetWindowPlacement(frame, &wp);
}
static void closeFrame(void) {
  savePlace();
  hidden = 0;
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
// closed: hidden while it may be opened again soon, the page still running behind it; one not yet
// showing its page, let go at once
static void hideFrame(void) {
  if (!frame) return;
  if (!ctl || !loaded) return closeFrame();
  savePlace();
  hidden = 1;
  ShowWindow(frame, SW_HIDE);
  ICoreWebView2Controller_put_IsVisible(ctl, FALSE);
  SetTimer(frame, TIMER_DISPOSE, DISPOSE_MS, NULL);
}
// the page told whether the window is maximized, for its button
static void tellZoom(int always) {
  int z = frame && IsZoomed(frame);
  if (!wv || (!always && z == toldZoom)) return;
  toldZoom = z;
  ICoreWebView2_PostWebMessageAsString(wv, z ? L"window\tmax" : L"window\tnormal");
}
// the window in the page's colours: its ground, WebView2's under the page, the edge's darkness and colour
static void applyLook(void) {
  if (!frame) return;
  BOOL on = look.dark;
  DwmSetWindowAttribute(frame, 20, &on, sizeof on);
  if (look.edged) DwmSetWindowAttribute(frame, 34, &look.edge, sizeof look.edge);
  InvalidateRect(frame, NULL, TRUE);
  ICoreWebView2Controller2 *c2;
  if (ctl && SUCCEEDED(ICoreWebView2Controller_QueryInterface(ctl, &IID_ICoreWebView2Controller2, (void **)&c2))) {
    COREWEBVIEW2_COLOR bg = { 255, GetRValue(look.ground), GetGValue(look.ground), GetBValue(look.ground) };
    ICoreWebView2Controller2_put_DefaultBackgroundColor(c2, bg);
    ICoreWebView2Controller2_Release(c2);
  }
}
// it could not be made, or shows nothing: a browser's, as before (a trial, which is to show the
// window, says so instead)
static void fallBack(void) {
  closeFrame();
  if (trying) {
    say(L"试运行：窗口无法显示");
    return balloon(L"试运行：窗口无法显示", L"原因见试运行的日志（右键单击此图标）。", NIIF_ERROR);
  }
  say(L"窗口：改用浏览器打开");
  openEdge();
}
// what a job made, kept under .tools\remote\out: opened, or shown in its folder
static void reveal(const wchar_t *path, int folder) {
  wchar_t root[MAX_PATH + 32], full[MAX_PATH * 2];
  FMT(root, L"%ls\\.tools\\remote\\out\\", repo);
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
// the page's word: drag, size and an edge, min, max, close, or open/show and a path
static HRESULT STDMETHODCALLTYPE onMessage(ICoreWebView2WebMessageReceivedEventHandler *self, ICoreWebView2 *sender, ICoreWebView2WebMessageReceivedEventArgs *args) {
  (void)self;
  (void)sender;
  static ULONGLONG dragAt;
  static POINT dragPt;
  LPWSTR s = NULL;
  if (FAILED(ICoreWebView2WebMessageReceivedEventArgs_TryGetWebMessageAsString(args, &s)) || !s) return S_OK;
  if (frame && !wcscmp(s, L"drag")) {
    // as if its title bar had been pressed: moved, snapped to the screen's sides; pressed twice, as
    // a double click, maximized or restored
    POINT pt;
    GetCursorPos(&pt);
    ULONGLONG now = GetTickCount64();
    if (now - dragAt <= GetDoubleClickTime() && labs(pt.x - dragPt.x) <= GetSystemMetrics(SM_CXDOUBLECLK) && labs(pt.y - dragPt.y) <= GetSystemMetrics(SM_CYDOUBLECLK)) {
      dragAt = 0;
      ShowWindow(frame, IsZoomed(frame) ? SW_RESTORE : SW_MAXIMIZE);
    } else {
      dragAt = now;
      dragPt = pt;
      ReleaseCapture();
      PostMessageW(frame, WM_NCLBUTTONDOWN, HTCAPTION, MAKELPARAM(pt.x, pt.y));
    }
  } else if (frame && !wcscmp(s, L"min"))
    ShowWindow(frame, SW_MINIMIZE);
  else if (frame && !wcscmp(s, L"max"))
    ShowWindow(frame, IsZoomed(frame) ? SW_RESTORE : SW_MAXIMIZE);
  else if (frame && !wcsncmp(s, L"size\t", 5)) {
    // its top edge or a top corner pressed: sized from there, as by a frame's
    const wchar_t *edge = s + 5;
    WPARAM hit = !wcscmp(edge, L"topleft") ? HTTOPLEFT : !wcscmp(edge, L"topright") ? HTTOPRIGHT : HTTOP;
    POINT pt;
    GetCursorPos(&pt);
    ReleaseCapture();
    PostMessageW(frame, WM_NCLBUTTONDOWN, hit, MAKELPARAM(pt.x, pt.y));
  }
  else if (!wcscmp(s, L"ready"))
    tellZoom(1);
  else if (!wcsncmp(s, L"look\t", 5)) {
    // look\t<ground>\t<edge>\t<dark>\t<busy>\t<idle>\t<wait>\t<bad>\t<off>: colours as rrggbb, the
    // states' (as the icons are numbered) from 0.7.17 on
    unsigned g, e, d, t[ICONS];
    int n = swscanf(s + 5, L"%6x\t%6x\t%u\t%6x\t%6x\t%6x\t%6x\t%6x", &g, &e, &d, &t[0], &t[1], &t[2], &t[3], &t[4]);
    if (n >= 3) {
      look.ground = RGB(g >> 16, (g >> 8) & 255, g & 255);
      look.edge = RGB(e >> 16, (e >> 8) & 255, e & 255);
      look.dark = d != 0;
      look.edged = 1;
      int toned = 0;
      if (n == 3 + ICONS)
        for (int i = 0; i < ICONS; i++) {
          COLORREF c = RGB(t[i] >> 16, (t[i] >> 8) & 255, t[i] & 255);
          if (!look.toned || look.tone[i] != c) toned = 1;
          look.tone[i] = c;
        }
      if (toned) look.toned = 1;
      RegSetKeyValueW(HKEY_CURRENT_USER, PLACE_KEY, L"look", REG_BINARY, &look, sizeof look);
      applyLook();
      if (toned) paintIcons();
    }
  }
  else if (!wcscmp(s, L"log"))
    openLog();
  else if (frame && !wcscmp(s, L"close"))
    PostMessageW(frame, WM_CLOSE, 0, 0);
  else if (!wcsncmp(s, L"open\t", 5))
    reveal(s + 5, 0);
  else if (!wcsncmp(s, L"show\t", 5))
    reveal(s + 5, 1);
  else if (!wcscmp(s, L"browser"))
    ShellExecuteW(NULL, L"open", L"http://127.0.0.1:7799/", NULL, NULL, SW_SHOWNORMAL);
  else if (!wcscmp(s, L"elevate"))
    // once this has returned: it waits for User Account Control, and closes the window
    PostMessageW(hwnd, WM_ELEVATE, 0, 0);
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
    loaded = 1;
    say(L"窗口：页面已加载");
    return S_OK;
  }
  say(L"窗口：页面加载失败（WebErrorStatus %d），第 %d 次", (int)status, navTries + 1);
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
  say(L"窗口：WebView2 进程异常（ProcessFailedKind %d）", (int)kind);
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
    say(L"窗口：WebView2 创建失败（0x%08lx）", (unsigned long)result);
    if (frame) PostMessageW(frame, WM_GIVE_UP, 0, 0);
    else openEdge();
    return S_OK;
  }
  ctl = made;
  ICoreWebView2Controller_AddRef(ctl);
  ICoreWebView2Controller_get_CoreWebView2(ctl, &wv);
  // the page's own ground behind it while it loads
  applyLook();
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
  ShowWindow(frame, openZoomed ? SW_SHOWMAXIMIZED : SW_SHOWNORMAL);
  SetForegroundWindow(frame);
  RECT rc;
  GetClientRect(frame, &rc);
  ICoreWebView2Controller_put_Bounds(ctl, rc);
  ICoreWebView2Controller_put_IsVisible(ctl, TRUE);
  say(L"窗口：WebView2 已创建（%ldx%ld），正在加载页面", rc.right - rc.left, rc.bottom - rc.top);
  navTries = 0;
  crashes = 0;
  loaded = 0;
  toldZoom = -1;
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
    say(L"窗口：WebView2 无法启动（0x%08lx / 0x%08lx）", (unsigned long)result, (unsigned long)made);
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
    tellZoom(0);
    return 0;
  case WM_ACTIVATE:
    if (ctl && LOWORD(wp) != WA_INACTIVE) ICoreWebView2Controller_MoveFocus(ctl, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
    // the title bar's buttons dimmed while another window is in front, as a frame's are
    if (wv) ICoreWebView2_PostWebMessageAsString(wv, LOWORD(wp) == WA_INACTIVE ? L"active\t0" : L"active\t1");
    break;
  case WM_ERASEBKGND: {
    // what WebView2 has not drawn yet, sized larger: the page's ground
    RECT rc;
    GetClientRect(h, &rc);
    HBRUSH b = CreateSolidBrush(look.ground);
    FillRect((HDC)wp, &rc, b);
    DeleteObject(b);
    return 1;
  }
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
      say(L"窗口：页面 12 秒内未加载完成");
      fallBack();
    }
    if (wp == TIMER_DISPOSE && hidden) {
      closeFrame();
      // a trial no one has looked at for a while: over
      if (trying) leave();
    }
    return 0;
  case WM_GIVE_UP:
    // closed already: nothing to show it in instead
    if (hidden) closeFrame();
    else fallBack();
    return 0;
  case WM_CLOSE:
    hideFrame();
    return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}
static int makeFrame(void) {
  RECT work;
  SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  int w = DIP(840), h = DIP(940);
  if (h > work.bottom - work.top - DIP(32)) h = work.bottom - work.top - DIP(32);
  frame = CreateWindowExW(0, L"RenderStationWindow", trying ? L"渲染站（试运行）" : TITLE, WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_CLIPCHILDREN,
                          work.left + (work.right - work.left - w) / 2, work.top + (work.bottom - work.top - h) / 2, w, h, NULL, NULL, inst, NULL);
  if (!frame) return 0;
  restorePlace();
  // the edge in the page's colours, the corners round (Windows 11); the state's icon
  applyLook();
  windowIcon();
  int round = 2;
  DwmSetWindowAttribute(frame, 33, &round, sizeof round);
  SetWindowPos(frame, NULL, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  return 1;
}
static void openWindow(void) {
  if (frame) {
    // still being made: it shows itself
    if (!ctl) return;
    if (hidden) {
      hidden = 0;
      KillTimer(frame, TIMER_DISPOSE);
      ICoreWebView2Controller_put_IsVisible(ctl, TRUE);
    }
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
    if (trying) FMT(data, L"%ls\\webview2", tryDir);
    else FMT(data, L"%ls\\.tools\\remote\\webview2", repo);
    HRESULT hr = createEnv(NULL, data, NULL, &environmentHandler);
    if (SUCCEEDED(hr)) return;
    say(L"窗口：WebView2 无法启动（0x%08lx）", (unsigned long)hr);
  } else
    say(createEnv ? L"窗口：无法创建窗口" : L"窗口：缺少 WebView2Loader.dll");
  fallBack();
}

// ——— with Windows, and as an app: what the window's settings ask for ———
static void runKey(int on) {
  HKEY k;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, RUN_KEY, 0, KEY_SET_VALUE, &k) != ERROR_SUCCESS) return;
  // the value it had while the station was part of qiqi.help, taken away
  RegDeleteValueW(k, OLD_RUN_NAME);
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
  IShellLinkW_SetDescription(sl, L"渲染站：为服务器运行高负载任务");
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

// ——— as administrator: asked for at each start; the task 0.5.0 made instead, and its mark, removed ———
static int elevated(void) {
  HANDLE t;
  TOKEN_ELEVATION e = { 0 };
  DWORD n = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &t)) return 0;
  GetTokenInformation(t, TokenElevation, &e, sizeof e, &n);
  CloseHandle(t);
  return e.TokenIsElevated != 0;
}
static int elevateMarked(const wchar_t *dir) {
  wchar_t mark[MAX_PATH + 48];
  FMT(mark, L"%ls\\.tools\\remote\\elevate", dir);
  return isFile(mark);
}
/** whether the overview page's switch said not to ask for administrator rights at each start */
static int noElevate(const wchar_t *dir) {
  wchar_t mark[MAX_PATH + 48];
  FMT(mark, L"%ls\\.tools\\remote\\no-elevate", dir);
  return isFile(mark);
}
static void schtasksPath(wchar_t *file) {
  wchar_t sys[MAX_PATH];
  GetSystemDirectoryW(sys, MAX_PATH);
  _snwprintf(file, MAX_PATH + 31, L"%ls\\schtasks.exe", sys);
  file[MAX_PATH + 31] = 0;
}
/** schtasks with these arguments, with no window: its exit code, or -1 */
static int schtasks(const wchar_t *args) {
  wchar_t file[MAX_PATH + 32], cmd[MAX_PATH * 3];
  schtasksPath(file);
  FMT(cmd, L"\"%ls\" %ls", file, args);
  STARTUPINFOW si = { sizeof si };
  PROCESS_INFORMATION pi;
  if (!CreateProcessW(file, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) return -1;
  CloseHandle(pi.hThread);
  WaitForSingleObject(pi.hProcess, 15000);
  DWORD code = (DWORD)-1;
  GetExitCodeProcess(pi.hProcess, &code);
  CloseHandle(pi.hProcess);
  return (int)code;
}
/** the same as administrator: at once if this is one, else once User Account Control has asked
 *  (over the window); 1223 if the owner said no */
static int schtasksAdmin(const wchar_t *args) {
  if (elevated()) return schtasks(args);
  wchar_t file[MAX_PATH + 32];
  schtasksPath(file);
  SHELLEXECUTEINFOW se = { sizeof se };
  se.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
  se.hwnd = frame ? frame : hwnd;
  se.lpVerb = L"runas";
  se.lpFile = file;
  se.lpParameters = args;
  se.nShow = SW_HIDE;
  if (!ShellExecuteExW(&se)) return GetLastError() == ERROR_CANCELLED ? 1223 : -1;
  DWORD code = (DWORD)-1;
  if (se.hProcess) {
    WaitForSingleObject(se.hProcess, 15000);
    GetExitCodeProcess(se.hProcess, &code);
    CloseHandle(se.hProcess);
  }
  return (int)code;
}
static void toPage(const wchar_t *text) {
  if (wv) ICoreWebView2_PostWebMessageAsString(wv, text);
}
/** `file` started as administrator, once User Account Control has asked (over `parent`, if any): 0,
 *  or ERROR_CANCELLED (1223) if the owner said no, or another error */
static int askAdmin(const wchar_t *file, const wchar_t *params, HWND parent) {
  SHELLEXECUTEINFOW se = { sizeof se };
  se.fMask = SEE_MASK_NOASYNC;
  se.hwnd = parent;
  se.lpVerb = L"runas";
  se.lpFile = file;
  se.lpParameters = params;
  se.nShow = SW_SHOWNORMAL;
  return ShellExecuteExW(&se) ? 0 : (int)GetLastError();
}
static void leave(void);
/** the page's 以管理员身份重新启动: this station started again as administrator, once User Account
 *  Control has asked over the window (the new one waits for this to go); the page told if not
 *  (elevate busy, cancelled, error <code>) */
static void restartAsAdmin(void) {
  if (trying) return toPage(L"elevate\ttry");
  if (!wcscmp(lastMode, L"busy")) return toPage(L"elevate\tbusy");
  wchar_t params[64], reply[64];
  FMT(params, L"--asked --after %lu", GetCurrentProcessId());
  int code = askAdmin(launcher, params, frame ? frame : hwnd);
  if (!code) return leave();
  if (code == ERROR_CANCELLED) return toPage(L"elevate\tcancelled");
  FMT(reply, L"elevate\terror\t%d", code);
  toPage(reply);
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
  FMT(cmd, L"\"%ls\" \"%ls\\station.mjs\"", nodePath, repo);
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
      balloon(L"渲染站无法启动", L"渲染站连续多次启动后立即退出，原因请查看日志（单击此处打开）。", NIIF_ERROR);
    }
    return show(ICON_BAD, L"渲染站 · 无法启动，请右键查看日志");
  }
  startStation();
  show(ICON_OFF, L"渲染站 · 正在启动");
}
// every two seconds: how the station is (/tray: mode, tip, the pause item, the newest job and
// what to say of it, the two settings, whether it was updated, whether the clipboard goes to the
// server, a line each)
static void tick(void) {
  if (quitting) return;
  static char buf[8192];
  static wchar_t w[8192];
  if (call("GET", "/tray", buf, sizeof buf)) return down();
  MultiByteToWideChar(CP_UTF8, 0, buf, -1, w, 8192);
  wchar_t *f[10] = { 0 };
  int n = 0;
  f[n++] = w;
  for (wchar_t *p = w; *p && n < 10; p++)
    if (*p == L'\n') {
      *p = 0;
      f[n++] = p + 1;
    }
  if (n < 8) return;
  up = 1;
  fails = 0;
  gaveUp = 0;
  const wchar_t *mode = f[0];
  if (!wcscmp(mode, L"auth") && wcscmp(lastMode, L"auth")) balloon(L"无法登录服务器", L"自动连接须使用无需密码的密钥登录。单击此处打开渲染站查看详情。", NIIF_ERROR);
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
    balloon(f[4], f[5], wcscmp(f[4], L"任务已完成") ? NIIF_WARNING : NIIF_INFO);
  }
  keep(f[6][0] == L'1', f[7][0] == L'1');
  clipOn = n > 9 && f[9][0] == L'1';
  if (n > 8 && f[8][0] == L'1') return again();
  if (wantOpen) {
    wantOpen = 0;
    openWindow();
  }
}

/** this gone, and the station with all it started (a trial: it alone, the station not its own) */
static void leave(void) {
  quitting = 1;
  KillTimer(hwnd, 1);
  if (!trying) {
    post("/quit");
    if (node) WaitForSingleObject(node, 2000);
    if (job) TerminateJobObject(job, 0);
  }
  closeFrame();
  Shell_NotifyIconW(NIM_DELETE, &nid);
  DestroyWindow(hwnd);
}
// updated: the checkout's 渲染站.exe, the new one, starts once this has gone, and the station with it
// (with the rights this has: User Account Control is not asked again)
static void again(void) {
  quitting = 1;
  wchar_t cmd[MAX_PATH * 2 + 64];
  FMT(cmd, L"\"%ls\" --asked --after %lu%ls", launcher, GetCurrentProcessId(), frame ? L"" : L" /quiet");
  STARTUPINFOW si = { sizeof si };
  PROCESS_INFORMATION pi;
  if (CreateProcessW(launcher, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
  leave();
}

static void quit(void) {
  if (!wcscmp(lastMode, L"busy") && MessageBoxW(hwnd, L"有任务正在运行。现在退出将中止该任务。", TITLE, MB_OKCANCEL | MB_ICONWARNING) != IDOK) return;
  leave();
}

static void menu(int x, int y) {
  HMENU m = CreatePopupMenu();
  if (trying) {
    AppendMenuW(m, MF_STRING, CMD_OPEN, L"打开试运行窗口");
    AppendMenuW(m, MF_STRING, CMD_LOG, L"查看试运行日志");
    AppendMenuW(m, MF_STRING, CMD_QUIT, L"结束试运行");
  } else {
    AppendMenuW(m, MF_STRING, CMD_OPEN, L"打开渲染站");
    AppendMenuW(m, MF_STRING | (up ? 0 : MF_GRAYED), CMD_TOGGLE, toggleText);
    AppendMenuW(m, MF_STRING | (up && !off ? 0 : MF_GRAYED), CMD_RECONNECT, L"重新连接");
    AppendMenuW(m, MF_SEPARATOR, 0, NULL);
    AppendMenuW(m, MF_STRING | (up ? 0 : MF_GRAYED), CMD_BROWSER, L"在浏览器中打开");
    AppendMenuW(m, MF_STRING, CMD_LOG, L"查看日志");
    AppendMenuW(m, MF_STRING, CMD_QUIT, L"退出渲染站");
  }
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
  case WM_CLIPBOARDUPDATE:
    clipChanged();
    return 0;
  case WM_ELEVATE:
    restartAsAdmin();
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
  // an installed copy's own
  FMT(nodePath, L"%ls\\node\\node.exe", repo);
  if (isFile(nodePath)) return 1;
  if (SearchPathW(NULL, L"node.exe", NULL, MAX_PATH, nodePath, NULL)) return 1;
  // where the installer puts it, should this have started without the PATH that names it
  wchar_t root[MAX_PATH];
  if (GetEnvironmentVariableW(L"ProgramFiles", root, MAX_PATH)) {
    FMT(nodePath, L"%ls\\nodejs\\node.exe", root);
    if (isFile(nodePath)) return 1;
  }
  return 0;
}

// ——— uninstalling a copy the installer put in place: what the station told Windows (starting with
// it, the shortcuts, the installed apps' entry), the copy it ran from, and then, from a copy of this
// in the temporary folder once this has gone, the installed folder: all of it, or all but the
// settings and what the jobs made (.tools) ———
static int uninstall(void) {
  wchar_t check[MAX_PATH + 32], content[MAX_PATH + 160];
  FMT(check, L"%ls\\release.json", exeDir);
  if (!isFile(check)) {
    MessageBoxW(NULL, L"此渲染站不是由安装程序安装的，无法卸载。", L"卸载渲染站", MB_ICONERROR);
    return 1;
  }
  FMT(content, L"将删除 %ls 中的程序文件，以及桌面和开始菜单中的快捷方式和开机自启项。", exeDir);
  TASKDIALOG_BUTTON buttons[] = { { 100, L"卸载，并删除设置和任务输出" }, { 101, L"卸载，但保留设置和任务输出\n保留在安装位置的 .tools 文件夹中" } };
  TASKDIALOGCONFIG tc = { sizeof tc };
  tc.hInstance = inst;
  tc.dwFlags = TDF_USE_COMMAND_LINKS | TDF_ALLOW_DIALOG_CANCELLATION;
  tc.dwCommonButtons = TDCBF_CANCEL_BUTTON;
  tc.pszWindowTitle = L"卸载渲染站";
  tc.pszMainIcon = MAKEINTRESOURCEW(1);
  tc.pszMainInstruction = L"要卸载渲染站吗？";
  tc.pszContent = content;
  tc.pButtons = buttons;
  tc.cButtons = 2;
  int pressed = 0;
  if (FAILED(TaskDialogIndirect(&tc, &pressed, NULL, NULL)) || (pressed != 100 && pressed != 101)) return 0;
  while (stationRunning() && !stopStation())
    if (MessageBoxW(NULL, L"无法关闭正在运行的渲染站。请从托盘菜单退出渲染站，然后单击「重试」。", L"卸载渲染站", MB_RETRYCANCEL | MB_ICONWARNING) != IDRETRY) return 1;
  HKEY k;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, RUN_KEY, 0, KEY_SET_VALUE, &k) == ERROR_SUCCESS) {
    RegDeleteValueW(k, RUN_NAME);
    RegDeleteValueW(k, OLD_RUN_NAME);
    RegCloseKey(k);
  }
  link(CSIDL_DESKTOPDIRECTORY, 0);
  link(CSIDL_PROGRAMS, 0);
  RegDeleteTreeW(HKEY_CURRENT_USER, UNINSTALL_KEY);
  RegDeleteTreeW(HKEY_CURRENT_USER, PLACE_KEY);
  // the task that started it as administrator (removing it may need User Account Control too)
  if (elevateMarked(exeDir)) {
    wchar_t args[64];
    FMT(args, L"/delete /tn %ls /f", ELEVATE_TASK);
    if (schtasks(args)) schtasksAdmin(args);
  }
  wchar_t home[MAX_PATH + 32];
  if (GetEnvironmentVariableW(L"LOCALAPPDATA", home, MAX_PATH)) {
    wcsncat(home, L"\\render-station", MAX_PATH - wcslen(home) - 1);
    removeTree(home);
  }
  wchar_t temp[MAX_PATH], copy[MAX_PATH + 64], cmd[MAX_PATH * 3];
  GetTempPathW(MAX_PATH, temp);
  FMT(copy, L"%lsrender-station-uninstall-%lu.exe", temp, GetCurrentProcessId());
  FMT(cmd, L"\"%ls\" --uninstall-finish \"%ls\" %d %lu", copy, exeDir, pressed == 101, GetCurrentProcessId());
  STARTUPINFOW si = { sizeof si };
  PROCESS_INFORMATION pi;
  if (!CopyFileW(exePath, copy, FALSE) || !CreateProcessW(copy, cmd, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) {
    FMT(content, L"渲染站已从系统中移除，但未能删除程序文件，请手动删除：\n%ls", exeDir);
    MessageBoxW(NULL, content, L"卸载渲染站", MB_ICONWARNING);
    return 1;
  }
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);
  return 0;
}
static int uninstallFinish(const wchar_t *dir, int keepData, DWORD after) {
  HANDLE old = OpenProcess(SYNCHRONIZE, FALSE, after);
  if (old) {
    WaitForSingleObject(old, 10000);
    CloseHandle(old);
  }
  int ok = 1;
  if (!keepData) ok = removeTree(dir);
  else {
    wchar_t pattern[MAX_PATH + 4], path[MAX_PATH * 2];
    FMT(pattern, L"%ls\\*", dir);
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(pattern, &fd);
    if (h != INVALID_HANDLE_VALUE) {
      do {
        if (!wcscmp(fd.cFileName, L".") || !wcscmp(fd.cFileName, L"..") || !_wcsicmp(fd.cFileName, L".tools")) continue;
        FMT(path, L"%ls\\%ls", dir, fd.cFileName);
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ok &= removeTree(path);
        else ok &= DeleteFileW(path) != 0;
      } while (FindNextFileW(h, &fd));
      FindClose(h);
    }
  }
  wchar_t msg[MAX_PATH * 2 + 128];
  if (!ok) FMT(msg, L"渲染站已卸载，但部分文件未能删除，请手动删除：\n%ls", dir);
  else if (keepData) FMT(msg, L"渲染站已卸载。设置和任务输出保留在：\n%ls\\.tools", dir);
  else FMT(msg, L"渲染站已卸载。");
  MessageBoxW(NULL, msg, L"卸载渲染站", ok ? MB_ICONINFORMATION : MB_ICONWARNING);
  // and this copy, once it has gone
  wchar_t comspec[MAX_PATH], cmd[MAX_PATH * 3];
  if (!GetEnvironmentVariableW(L"ComSpec", comspec, MAX_PATH)) lstrcpynW(comspec, L"cmd.exe", MAX_PATH);
  FMT(cmd, L"\"%ls\" /c ping -n 3 127.0.0.1 >nul & del /f /q \"%ls\"", comspec, exePath);
  STARTUPINFOW si = { sizeof si };
  PROCESS_INFORMATION pi;
  if (CreateProcessW(NULL, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
  }
  return ok ? 0 : 1;
}

/** before the station starts here: the one before gone (an update's), the rights asked for, the run
 *  moved to the copy, this alone, the checkout and node found; -1 to go on, else the exit code */
static int startHere(int quiet, int asked, DWORD after, const wchar_t *from) {
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
    wcsncat(home, L"\\render-station", MAX_PATH - wcslen(home) - 1);
  }
  int isCopy = home[0] && !_wcsicmp(exeDir, home);
  lstrcpynW(launcher, isCopy && from ? from : exePath, MAX_PATH);
  HANDLE running = OpenMutexW(SYNCHRONIZE, FALSE, TRAY_MUTEX);
  // one running as administrator lets this see it is there, but no more
  int there = running || GetLastError() == ERROR_ACCESS_DENIED;
  // as administrator, unless the settings say not to: User Account Control asks, and this goes for
  // the one it starts; said no, this runs as it is
  if (!isCopy && !there && !asked && !elevated() && !noElevate(exeDir)) {
    wchar_t params[32];
    FMT(params, L"--asked%ls", quiet ? L" /quiet" : L"");
    if (!askAdmin(exePath, params, NULL)) return 0;
  }
  if (!isCopy && home[0] && !there) {
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
  if (!CreateMutexW(NULL, TRUE, TRAY_MUTEX) || GetLastError() == ERROR_ALREADY_EXISTS) {
    // the one running opens its window, and may bring it to the front
    HWND other = FindWindowW(TRAY_CLASS, NULL);
    if (other && !quiet) {
      DWORD pid = 0;
      GetWindowThreadProcessId(other, &pid);
      AllowSetForegroundWindow(pid);
      PostMessageW(other, WM_COMMAND, CMD_OPEN, 0);
    }
    return 0;
  }

  // the checkout: the folder that holds 渲染站.exe
  wchar_t launcherDir[MAX_PATH], check[MAX_PATH + 64];
  lstrcpynW(launcherDir, launcher, MAX_PATH);
  wchar_t *slash = wcsrchr(launcherDir, L'\\');
  if (slash) *slash = 0;
  GetFullPathNameW(launcherDir, MAX_PATH, repo, NULL);
  FMT(check, L"%ls\\station.mjs", repo);
  if (!isFile(check)) {
    MessageBoxW(NULL, L"渲染站.exe 必须与 station.mjs 位于同一文件夹（渲染站仓库的根目录）。\n\n桌面上的「渲染站」是它的快捷方式，以后可从快捷方式启动。", TITLE, MB_ICONERROR);
    return 1;
  }
  FMT(logPath, L"%ls\\.tools\\remote\\station.log", repo);
  // the task 0.5.0 made to start it as administrator, and its mark: asked at each start instead now
  if (elevateMarked(repo) && elevated()) {
    wchar_t args[64], mark[MAX_PATH + 48];
    FMT(args, L"/delete /tn %ls /f", ELEVATE_TASK);
    schtasks(args);
    FMT(mark, L"%ls\\.tools\\remote\\elevate", repo);
    DeleteFileW(mark);
  }
  if (!findNode()) {
    MessageBoxW(NULL, L"未找到 Node.js。请先安装 Node.js（nodejs.org，LTS 版本），再启动渲染站。", TITLE, MB_ICONERROR);
    return 1;
  }
  return -1;
}
/** before a trial starts: the one before gone, and its folder made; 0 if it cannot be */
static int startTrial(void) {
  HWND before = FindWindowW(TRY_CLASS, NULL);
  if (before) {
    DWORD pid = 0;
    GetWindowThreadProcessId(before, &pid);
    HANDLE old = OpenProcess(SYNCHRONIZE, FALSE, pid);
    PostMessageW(before, WM_COMMAND, CMD_QUIT, 0);
    if (old) {
      WaitForSingleObject(old, 5000);
      CloseHandle(old);
    }
  }
  if (!CreateMutexW(NULL, TRUE, TRY_MUTEX) || GetLastError() == ERROR_ALREADY_EXISTS) return 0;
  if (!GetEnvironmentVariableW(L"LOCALAPPDATA", tryDir, MAX_PATH)) return 0;
  wcsncat(tryDir, L"\\render-station", MAX_PATH - wcslen(tryDir) - 1);
  CreateDirectoryW(tryDir, NULL);
  wcsncat(tryDir, L"\\try", MAX_PATH - wcslen(tryDir) - 1);
  CreateDirectoryW(tryDir, NULL);
  FMT(logPath, L"%ls\\try.log", tryDir);
  say(L"试运行：%ls", exePath);
  return 1;
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE prev, PWSTR args, int how) {
  (void)prev;
  (void)how;
  inst = hi;
  (void)args;
  int argc = 0, quiet = 0, removing = 0, keepData = 0, asked = 0, clipImage = 0;
  DWORD after = 0, finishAfter = 0;
  const wchar_t *from = NULL, *finishing = NULL, *clipFile = NULL;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; argv && i < argc; i++) {
    if (!wcscmp(argv[i], L"/quiet")) quiet = 1;
    else if (!wcscmp(argv[i], L"--after") && i + 1 < argc) after = wcstoul(argv[++i], NULL, 10);
    else if (!wcscmp(argv[i], L"--from") && i + 1 < argc) from = argv[++i];
    else if (!wcscmp(argv[i], L"--uninstall")) removing = 1;
    else if (!wcscmp(argv[i], L"--try")) trying = 1;
    // the station's: what the server sent, onto the clipboard
    else if (!wcscmp(argv[i], L"--clip-set") && i + 2 < argc) {
      clipFile = argv[++i];
      clipImage = !wcscmp(argv[++i], L"image");
    }
    // User Account Control asked already (or not to be: started again after an update)
    else if (!wcscmp(argv[i], L"--asked")) asked = 1;
    else if (!wcscmp(argv[i], L"--uninstall-finish") && i + 3 < argc) {
      finishing = argv[++i];
      keepData = argv[++i][0] == L'1';
      finishAfter = wcstoul(argv[++i], NULL, 10);
    }
  }
  wantOpen = !quiet;
  GetModuleFileNameW(NULL, exePath, MAX_PATH);
  lstrcpynW(exeDir, exePath, MAX_PATH);
  wchar_t *slash = wcsrchr(exeDir, L'\\');
  if (slash) *slash = 0;
  if (clipFile) return clipSet(clipFile, clipImage);
  if (removing) return uninstall();
  if (finishing) return uninstallFinish(finishing, keepData, finishAfter);

  if (trying) {
    if (!startTrial()) return 0;
  } else {
    int code = startHere(quiet, asked, after, from);
    if (code >= 0) return code;
  }

  WSADATA wsa;
  WSAStartup(MAKEWORD(2, 2), &wsa);
  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
  darkMenus();
  int cx = GetSystemMetrics(SM_CXSMICON), cy = GetSystemMetrics(SM_CYSMICON);
  for (int i = 0; i < ICONS; i++) {
    icons[i] = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(i + 1), IMAGE_ICON, cx, cy, 0);
    bigIcons[i] = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(i + 1), IMAGE_ICON, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), 0);
  }
  HDC screen = GetDC(NULL);
  dpi = GetDeviceCaps(screen, LOGPIXELSY);
  ReleaseDC(NULL, screen);
  DWORD light = 1, size = sizeof light;
  RegGetValueW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize", L"AppsUseLightTheme", RRF_RT_REG_DWORD, NULL, &light, &size);
  dark = light == 0;
  // the page's look as it last told; till it has, 梅紫's, light or dark as Windows is
  size = sizeof look;
  if (RegGetValueW(HKEY_CURRENT_USER, PLACE_KEY, L"look", RRF_RT_REG_BINARY, NULL, &look, &size) != ERROR_SUCCESS || size != sizeof look) {
    memset(&look, 0, sizeof look);
    look.ground = dark ? RGB(0x17, 0x12, 0x16) : RGB(0xf9, 0xf6, 0xf3);
    look.dark = dark;
  }
  // the icons in its colours, from the first: station.rc's are 梅紫's
  paintIcons();
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
  fc.hbrBackground = NULL;
  fc.hIcon = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), 0);
  fc.hIconSm = icons[ICON_BUSY];
  fc.lpszClassName = L"RenderStationWindow";
  RegisterClassExW(&fc);

  WNDCLASSW wc = { 0 };
  wc.lpfnWndProc = proc;
  wc.hInstance = inst;
  wc.lpszClassName = trying ? TRY_CLASS : TRAY_CLASS;
  RegisterClassW(&wc);
  hwnd = CreateWindowExW(0, wc.lpszClassName, TITLE, WS_OVERLAPPED, 0, 0, 0, 0, NULL, NULL, inst, NULL);
  taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
  // as administrator, the words of those without its rights still taken: a second start's 打开渲染站,
  // the installer's 退出, Explorer's
  ChangeWindowMessageFilterEx(hwnd, WM_COMMAND, MSGFLT_ALLOW, NULL);
  ChangeWindowMessageFilterEx(hwnd, WM_TRAY, MSGFLT_ALLOW, NULL);
  ChangeWindowMessageFilterEx(hwnd, taskbarCreated, MSGFLT_ALLOW, NULL);
  ChangeWindowMessageFilterEx(hwnd, WM_CLIPBOARDUPDATE, MSGFLT_ALLOW, NULL);
  if (trying) {
    // its window at once, on the station running here; an icon to open it again, and to end it
    iconNow = ICON_BUSY;
    nid.hIcon = icons[ICON_BUSY];
    lstrcpynW(nid.szTip, L"渲染站 · 试运行", 128);
    addIcon();
    openWindow();
  } else {
    addIcon();
    AddClipboardFormatListener(hwnd);
    SetTimer(hwnd, 1, 2000, NULL);
    tick();
  }

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  if (job) CloseHandle(job);
  return 0;
}
