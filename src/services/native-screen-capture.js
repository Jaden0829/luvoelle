let nativeApi;
let nativeApiError;

const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;
const DIB_RGB_COLORS = 0;

function createNativeApi() {
  if (process.platform !== 'win32') return null;

  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const HANDLE = koffi.pointer('LuvoelleScreenCaptureHandle', koffi.opaque());
  const HWND = koffi.alias('LuvoelleScreenCaptureHWND', HANDLE);
  const HDC = koffi.alias('LuvoelleScreenCaptureHDC', HANDLE);
  const HBITMAP = koffi.alias('LuvoelleScreenCaptureHBITMAP', HANDLE);
  const HGDIOBJ = koffi.alias('LuvoelleScreenCaptureHGDIOBJ', HANDLE);

  return {
    GetDC: user32.func('LuvoelleScreenCaptureHDC __stdcall GetDC(LuvoelleScreenCaptureHWND hwnd)'),
    ReleaseDC: user32.func('int __stdcall ReleaseDC(LuvoelleScreenCaptureHWND hwnd, LuvoelleScreenCaptureHDC hdc)'),
    CreateCompatibleDC: gdi32.func('LuvoelleScreenCaptureHDC __stdcall CreateCompatibleDC(LuvoelleScreenCaptureHDC hdc)'),
    DeleteDC: gdi32.func('bool __stdcall DeleteDC(LuvoelleScreenCaptureHDC hdc)'),
    CreateCompatibleBitmap: gdi32.func('LuvoelleScreenCaptureHBITMAP __stdcall CreateCompatibleBitmap(LuvoelleScreenCaptureHDC hdc, int width, int height)'),
    SelectObject: gdi32.func('LuvoelleScreenCaptureHGDIOBJ __stdcall SelectObject(LuvoelleScreenCaptureHDC hdc, LuvoelleScreenCaptureHGDIOBJ object)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(LuvoelleScreenCaptureHGDIOBJ object)'),
    BitBlt: gdi32.func('bool __stdcall BitBlt(LuvoelleScreenCaptureHDC target, int x, int y, int width, int height, LuvoelleScreenCaptureHDC source, int sourceX, int sourceY, uint32_t operation)'),
    GetDIBits: gdi32.func('int __stdcall GetDIBits(LuvoelleScreenCaptureHDC hdc, LuvoelleScreenCaptureHBITMAP bitmap, uint32_t start, uint32_t lines, _Out_ uint8_t *bits, _Inout_ uint8_t *info, uint32_t usage)'),
    DwmFlush: dwmapi.func('long __stdcall DwmFlush()'),
  };
}

function getNativeApi() {
  if (nativeApi !== undefined) return nativeApi;
  if (nativeApiError) return null;
  try {
    nativeApi = createNativeApi();
  } catch (error) {
    nativeApiError = error;
    nativeApi = null;
  }
  return nativeApi;
}

function bitmapInfo(width, height) {
  const info = Buffer.alloc(40);
  info.writeUInt32LE(40, 0);
  info.writeInt32LE(width, 4);
  // A negative height asks GDI for a top-down bitmap, matching NativeImage.
  info.writeInt32LE(-height, 8);
  info.writeUInt16LE(1, 12);
  info.writeUInt16LE(32, 14);
  info.writeUInt32LE(0, 16);
  info.writeUInt32LE(width * height * 4, 20);
  return info;
}

function makeOpaque(pixels) {
  const words = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4);
  for (let index = 0; index < words.length; index += 1) words[index] |= 0xff000000;
}

function capturePhysicalRectangle(rect, nativeImage) {
  const api = getNativeApi();
  if (!api || !nativeImage) return null;
  const x = Math.round(Number(rect?.x));
  const y = Math.round(Number(rect?.y));
  const width = Math.round(Number(rect?.width));
  const height = Math.round(Number(rect?.height));
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;

  let screenDc;
  let memoryDc;
  let bitmap;
  let previousObject;
  try {
    screenDc = api.GetDC(null);
    if (!screenDc) throw new Error('GetDC failed');
    memoryDc = api.CreateCompatibleDC(screenDc);
    if (!memoryDc) throw new Error('CreateCompatibleDC failed');
    bitmap = api.CreateCompatibleBitmap(screenDc, width, height);
    if (!bitmap) throw new Error('CreateCompatibleBitmap failed');
    previousObject = api.SelectObject(memoryDc, bitmap);
    if (!previousObject) throw new Error('SelectObject failed');
    if (!api.BitBlt(memoryDc, 0, 0, width, height, screenDc, x, y, (SRCCOPY | CAPTUREBLT) >>> 0)) {
      throw new Error('BitBlt failed');
    }

    // GetDIBits requires the bitmap not to be selected into a device context.
    api.SelectObject(memoryDc, previousObject);
    previousObject = null;
    const pixels = Buffer.allocUnsafe(width * height * 4);
    const lines = api.GetDIBits(memoryDc, bitmap, 0, height, pixels, bitmapInfo(width, height), DIB_RGB_COLORS);
    if (lines !== height) throw new Error(`GetDIBits returned ${lines}/${height} lines`);
    makeOpaque(pixels);
    const image = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 });
    if (image.isEmpty()) throw new Error('NativeImage rejected the GDI bitmap');
    return { image, width, height, backend: 'win32-gdi' };
  } finally {
    if (memoryDc && previousObject) api.SelectObject(memoryDc, previousObject);
    if (bitmap) api.DeleteObject(bitmap);
    if (memoryDc) api.DeleteDC(memoryDc);
    if (screenDc) api.ReleaseDC(null, screenDc);
  }
}

function captureDisplays(displays, dipToScreenPoint, nativeImage) {
  if (process.platform !== 'win32' || typeof dipToScreenPoint !== 'function') return null;
  const frames = new Map();
  for (const display of displays) {
    const origin = dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y });
    const scaleFactor = Number(display.scaleFactor) || 1;
    const frame = capturePhysicalRectangle({
      x: origin.x,
      y: origin.y,
      width: Math.round(display.bounds.width * scaleFactor),
      height: Math.round(display.bounds.height * scaleFactor),
    }, nativeImage);
    if (!frame) return null;
    frames.set(String(display.id), {
      ...frame,
      imageWidth: frame.width,
      imageHeight: frame.height,
      displayWidth: display.bounds.width,
      displayHeight: display.bounds.height,
    });
  }
  return frames;
}

function captureDisplay(display, dipToScreenPoint, nativeImage) {
  const frames = captureDisplays([display], dipToScreenPoint, nativeImage);
  return frames?.get(String(display.id)) || null;
}

function warmNativeScreenCapture() {
  getNativeApi();
}

function flushDesktopComposition() {
  const api = getNativeApi();
  if (!api?.DwmFlush) return false;
  try {
    return api.DwmFlush() === 0;
  } catch {
    return false;
  }
}

module.exports = {
  captureDisplay,
  captureDisplays,
  capturePhysicalRectangle,
  flushDesktopComposition,
  warmNativeScreenCapture,
};
