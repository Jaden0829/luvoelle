const MIN_TARGET_WIDTH = 80;
const MIN_TARGET_HEIGHT = 50;
const MIN_AUTOMATION_TARGET_WIDTH = 28;
const MIN_AUTOMATION_TARGET_HEIGHT = 16;
const MAX_TARGETS = 240;
const MAX_AUTOMATION_TARGETS = 420;

const EXCLUDED_CLASSES = new Set([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'CEF-OSC-WIDGET',
]);

let nativeApi;
let nativeApiError;
let macNativeApi;
let macNativeApiError;

const MAC_EXCLUDED_OWNERS = new Set([
  'Dock',
  'Window Server',
  'SystemUIServer',
  'Control Center',
  'Notification Center',
]);
const CF_STRING_ENCODING_UTF8 = 0x08000100;
const CF_NUMBER_DOUBLE_TYPE = 13;
const CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY = 1;
const CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS = 16;

function createNativeApi() {
  if (process.platform !== 'win32') return null;

  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  const HANDLE = koffi.pointer('LuvoelleWindowHandle', koffi.opaque());
  const HWND = koffi.alias('LuvoelleHWND', HANDLE);
  const RECT = koffi.struct('LuvoelleWindowRect', {
    left: 'long',
    top: 'long',
    right: 'long',
    bottom: 'long',
  });
  const EnumWindowsProc = koffi.proto('bool __stdcall LuvoelleEnumWindowsProc(LuvoelleHWND hwnd, intptr_t lParam)');

  return {
    koffi,
    RECT,
    EnumWindows: user32.func('bool __stdcall EnumWindows(LuvoelleEnumWindowsProc *callback, intptr_t lParam)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(LuvoelleHWND hwnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(LuvoelleHWND hwnd)'),
    GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(LuvoelleHWND hwnd)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(LuvoelleHWND hwnd, _Out_ uint16_t *text, int count)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(LuvoelleHWND hwnd, _Out_ uint16_t *className, int count)'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(LuvoelleHWND hwnd, _Out_ uint32_t *processId)'),
    GetWindowLongPtrW: user32.func(`${process.arch === 'ia32' ? 'long' : 'int64_t'} __stdcall GetWindowLongPtrW(LuvoelleHWND hwnd, int index)`),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(LuvoelleHWND hwnd, _Out_ LuvoelleWindowRect *rect)'),
    DwmGetWindowAttributeRect: dwmapi.func('DwmGetWindowAttribute', 'long', [HWND, 'uint32_t', koffi.out(koffi.pointer(RECT)), 'uint32_t']),
    DwmGetWindowAttributeUInt: dwmapi.func('DwmGetWindowAttribute', 'long', [HWND, 'uint32_t', koffi.out(koffi.pointer('uint32_t')), 'uint32_t']),
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

function createMacNativeApi() {
  if (process.platform !== 'darwin') return null;

  const koffi = require('koffi');
  const coreGraphics = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const coreFoundation = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const api = {
    CGWindowListCopyWindowInfo: coreGraphics.func('void * CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)'),
    CFArrayGetCount: coreFoundation.func('int64_t CFArrayGetCount(void *array)'),
    CFArrayGetValueAtIndex: coreFoundation.func('void * CFArrayGetValueAtIndex(void *array, int64_t index)'),
    CFDictionaryGetValue: coreFoundation.func('void * CFDictionaryGetValue(void *dictionary, void *key)'),
    CFStringCreateWithCString: coreFoundation.func('void * CFStringCreateWithCString(void *allocator, const char *value, uint32_t encoding)'),
    CFStringGetLength: coreFoundation.func('int64_t CFStringGetLength(void *value)'),
    CFStringGetMaximumSizeForEncoding: coreFoundation.func('int64_t CFStringGetMaximumSizeForEncoding(int64_t length, uint32_t encoding)'),
    CFStringGetCString: coreFoundation.func('bool CFStringGetCString(void *value, _Out_ char *buffer, int64_t size, uint32_t encoding)'),
    CFNumberGetValue: coreFoundation.func('bool CFNumberGetValue(void *number, int32_t type, _Out_ double *value)'),
    CFBooleanGetValue: coreFoundation.func('bool CFBooleanGetValue(void *value)'),
    CFRelease: coreFoundation.func('void CFRelease(void *value)'),
    keys: {},
  };
  [
    'kCGWindowBounds',
    'kCGWindowName',
    'kCGWindowOwnerName',
    'kCGWindowOwnerPID',
    'kCGWindowLayer',
    'kCGWindowAlpha',
    'kCGWindowIsOnscreen',
    'X',
    'Y',
    'Width',
    'Height',
  ].forEach((name) => {
    api.keys[name] = api.CFStringCreateWithCString(null, name, CF_STRING_ENCODING_UTF8);
  });
  return api;
}

function getMacNativeApi() {
  if (macNativeApi !== undefined) return macNativeApi;
  if (macNativeApiError) return null;
  try {
    macNativeApi = createMacNativeApi();
  } catch (error) {
    macNativeApiError = error;
    macNativeApi = null;
  }
  return macNativeApi;
}

function macDictionaryValue(api, dictionary, key) {
  if (!dictionary || !api.keys[key]) return null;
  try {
    return api.CFDictionaryGetValue(dictionary, api.keys[key]);
  } catch {
    return null;
  }
}

function macNumber(api, value, fallback = 0) {
  if (!value) return fallback;
  const result = [0];
  try {
    return api.CFNumberGetValue(value, CF_NUMBER_DOUBLE_TYPE, result) ? Number(result[0]) : fallback;
  } catch {
    return fallback;
  }
}

function macString(api, value) {
  if (!value) return '';
  try {
    const length = Number(api.CFStringGetLength(value));
    const maximum = Math.max(1, Number(api.CFStringGetMaximumSizeForEncoding(length, CF_STRING_ENCODING_UTF8)) + 1);
    const buffer = Buffer.alloc(Math.min(maximum, 8192));
    if (!api.CFStringGetCString(value, buffer, buffer.length, CF_STRING_ENCODING_UTF8)) return '';
    const end = buffer.indexOf(0);
    return buffer.toString('utf8', 0, end < 0 ? buffer.length : end).trim();
  } catch {
    return '';
  }
}

function enumerateMacVisibleWindows() {
  const api = getMacNativeApi();
  if (!api) return [];
  let windowInfo;
  try {
    windowInfo = api.CGWindowListCopyWindowInfo(
      CG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | CG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
      0,
    );
    if (!windowInfo) return [];
    const count = Math.min(MAX_TARGETS * 4, Number(api.CFArrayGetCount(windowInfo)) || 0);
    const windows = [];
    const seenRectangles = new Set();
    for (let index = 0; index < count && windows.length < MAX_TARGETS; index += 1) {
      const dictionary = api.CFArrayGetValueAtIndex(windowInfo, index);
      if (!dictionary) continue;
      const ownerPid = Math.round(macNumber(api, macDictionaryValue(api, dictionary, 'kCGWindowOwnerPID'), -1));
      if (ownerPid === process.pid) continue;
      const layer = Math.round(macNumber(api, macDictionaryValue(api, dictionary, 'kCGWindowLayer'), 0));
      if (layer !== 0) continue;
      const alpha = macNumber(api, macDictionaryValue(api, dictionary, 'kCGWindowAlpha'), 1);
      if (alpha <= 0.01) continue;
      const onscreen = macDictionaryValue(api, dictionary, 'kCGWindowIsOnscreen');
      if (onscreen && !api.CFBooleanGetValue(onscreen)) continue;

      const ownerName = macString(api, macDictionaryValue(api, dictionary, 'kCGWindowOwnerName'));
      if (MAC_EXCLUDED_OWNERS.has(ownerName)) continue;
      const bounds = macDictionaryValue(api, dictionary, 'kCGWindowBounds');
      const left = macNumber(api, macDictionaryValue(api, bounds, 'X'), NaN);
      const top = macNumber(api, macDictionaryValue(api, bounds, 'Y'), NaN);
      const width = macNumber(api, macDictionaryValue(api, bounds, 'Width'), NaN);
      const height = macNumber(api, macDictionaryValue(api, bounds, 'Height'), NaN);
      if (![left, top, width, height].every(Number.isFinite) || width < MIN_TARGET_WIDTH || height < MIN_TARGET_HEIGHT) continue;
      const rectangleKey = `${Math.round(left)},${Math.round(top)},${Math.round(width)},${Math.round(height)}`;
      if (seenRectangles.has(rectangleKey)) continue;
      seenRectangles.add(rectangleKey);
      const windowName = macString(api, macDictionaryValue(api, dictionary, 'kCGWindowName'));
      windows.push({
        left,
        top,
        right: left + width,
        bottom: top + height,
        title: windowName || ownerName || '窗口',
        className: ownerName,
        zIndex: windows.length,
      });
    }
    return windows;
  } catch {
    return [];
  } finally {
    if (windowInfo) {
      try { api.CFRelease(windowInfo); } catch { /* the process can continue without native window snapping */ }
    }
  }
}

function readUtf16(api, hwnd, length, reader) {
  const count = Math.max(1, Math.min(1024, length + 1));
  const buffer = Buffer.alloc(count * 2);
  const written = reader(hwnd, buffer, count);
  if (!written) return '';
  return buffer.toString('utf16le', 0, written * 2).replace(/\0/g, '').trim();
}

function getWindowTitle(api, hwnd) {
  const length = api.GetWindowTextLengthW(hwnd);
  if (length <= 0) return '';
  return readUtf16(api, hwnd, length, api.GetWindowTextW);
}

function getWindowClass(api, hwnd) {
  return readUtf16(api, hwnd, 255, api.GetClassNameW);
}

function getExtendedStyle(api, hwnd) {
  try {
    return BigInt.asUintN(64, BigInt(api.GetWindowLongPtrW(hwnd, -20)));
  } catch {
    return 0n;
  }
}

function getWindowRectangle(api, hwnd) {
  const rect = {};
  const extendedBoundsResult = api.DwmGetWindowAttributeRect(hwnd, 9, rect, api.koffi.sizeof(api.RECT));
  if (extendedBoundsResult !== 0 && !api.GetWindowRect(hwnd, rect)) return null;
  const left = Number(rect.left);
  const top = Number(rect.top);
  const right = Number(rect.right);
  const bottom = Number(rect.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) return null;
  if (right - left < MIN_TARGET_WIDTH || bottom - top < MIN_TARGET_HEIGHT) return null;
  return { left, top, right, bottom };
}

function isCloaked(api, hwnd) {
  try {
    const value = [0];
    return api.DwmGetWindowAttributeUInt(hwnd, 14, value, 4) === 0 && Number(value[0]) !== 0;
  } catch {
    return false;
  }
}

function enumerateVisibleWindows() {
  const api = getNativeApi();
  if (!api) return [];

  const windows = [];
  const seenRectangles = new Set();
  try {
    api.EnumWindows((hwnd) => {
      try {
        if (windows.length >= MAX_TARGETS) return false;
        if (!api.IsWindowVisible(hwnd) || api.IsIconic(hwnd) || isCloaked(api, hwnd)) return true;

        const processId = [0];
        api.GetWindowThreadProcessId(hwnd, processId);
        if (Number(processId[0]) === process.pid) return true;

        const title = getWindowTitle(api, hwnd);
        if (!title || title === 'Luvoelle 截图') return true;
        const className = getWindowClass(api, hwnd);
        if (EXCLUDED_CLASSES.has(className)) return true;

        const extendedStyle = getExtendedStyle(api, hwnd);
        const isToolWindow = (extendedStyle & 0x80n) !== 0n;
        const isAppWindow = (extendedStyle & 0x40000n) !== 0n;
        if (isToolWindow && !isAppWindow) return true;

        const rect = getWindowRectangle(api, hwnd);
        if (!rect) return true;
        const rectangleKey = `${rect.left},${rect.top},${rect.right},${rect.bottom}`;
        if (seenRectangles.has(rectangleKey)) return true;
        seenRectangles.add(rectangleKey);
        windows.push({
          ...rect,
          title,
          className,
          hwnd: api.koffi.address(hwnd).toString(),
          zIndex: windows.length,
        });
      } catch {
        // A single misbehaving native window must not interrupt capture.
      }
      return true;
    }, 0);
  } catch {
    return [];
  }
  return windows;
}

function intersectRect(a, b) {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

function mapWindowTargetsToDisplays(displays, windows, dipToScreenPoint) {
  const result = new Map(displays.map((display) => [String(display.id), []]));
  displays.forEach((display) => {
    const scaleFactor = Number(display.scaleFactor) || 1;
    const physicalOrigin = dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y });
    const physicalBounds = {
      left: physicalOrigin.x,
      top: physicalOrigin.y,
      right: physicalOrigin.x + Math.round(display.bounds.width * scaleFactor),
      bottom: physicalOrigin.y + Math.round(display.bounds.height * scaleFactor),
    };
    const targets = result.get(String(display.id));
    windows.forEach((window) => {
      const clipped = intersectRect(window, physicalBounds);
      if (!clipped) return;
      const target = {
        left: (clipped.left - physicalBounds.left) / scaleFactor,
        top: (clipped.top - physicalBounds.top) / scaleFactor,
        width: (clipped.right - clipped.left) / scaleFactor,
        height: (clipped.bottom - clipped.top) / scaleFactor,
        title: window.title,
        zIndex: window.zIndex,
      };
      if (window.hwnd) target.hwnd = String(window.hwnd);
      if (window.hwnd) {
        target.nativeBounds = {
          left: window.left,
          top: window.top,
          right: window.right,
          bottom: window.bottom,
        };
        target.displayPhysicalBounds = { ...physicalBounds };
        target.scaleFactor = scaleFactor;
      }
      if (window.className) target.className = window.className;
      if (window.source) target.source = window.source;
      if (window.controlType) target.controlType = window.controlType;
      if (target.width >= MIN_TARGET_WIDTH / scaleFactor && target.height >= MIN_TARGET_HEIGHT / scaleFactor) targets.push(target);
    });
  });
  return result;
}

function mapAutomationTargetsToWindowTarget(windowTarget, automationRoot, elements) {
  const nativeBounds = windowTarget?.nativeBounds;
  const displayBounds = windowTarget?.displayPhysicalBounds;
  const automationWidth = Number(automationRoot?.right) - Number(automationRoot?.left);
  const automationHeight = Number(automationRoot?.bottom) - Number(automationRoot?.top);
  const nativeWidth = Number(nativeBounds?.right) - Number(nativeBounds?.left);
  const nativeHeight = Number(nativeBounds?.bottom) - Number(nativeBounds?.top);
  if (![automationWidth, automationHeight, nativeWidth, nativeHeight].every((value) => Number.isFinite(value) && value > 0)
    || !displayBounds) return [];

  const calibrationX = nativeWidth / automationWidth;
  const calibrationY = nativeHeight / automationHeight;
  const displayScale = Number(windowTarget.scaleFactor) || 1;
  const seen = new Set();
  const targets = [];
  for (const element of elements || []) {
    if (targets.length >= MAX_AUTOMATION_TARGETS) break;
    const calibrated = {
      left: nativeBounds.left + (Number(element.left) - automationRoot.left) * calibrationX,
      top: nativeBounds.top + (Number(element.top) - automationRoot.top) * calibrationY,
      right: nativeBounds.left + (Number(element.right) - automationRoot.left) * calibrationX,
      bottom: nativeBounds.top + (Number(element.bottom) - automationRoot.top) * calibrationY,
    };
    if (!Object.values(calibrated).every(Number.isFinite)) continue;
    const insideWindow = intersectRect(calibrated, nativeBounds);
    const clipped = insideWindow && intersectRect(insideWindow, displayBounds);
    if (!clipped) continue;
    const target = {
      left: (clipped.left - displayBounds.left) / displayScale,
      top: (clipped.top - displayBounds.top) / displayScale,
      width: (clipped.right - clipped.left) / displayScale,
      height: (clipped.bottom - clipped.top) / displayScale,
      title: element.title || '智能区域',
      zIndex: Number(element.zIndex) || 0,
      source: 'uia',
      controlType: element.controlType || '',
    };
    if (target.width < MIN_AUTOMATION_TARGET_WIDTH || target.height < MIN_AUTOMATION_TARGET_HEIGHT) continue;
    const key = [target.left, target.top, target.width, target.height].map((value) => Math.round(value)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  targets.sort((left, right) => (left.width * left.height) - (right.width * right.height));
  return targets;
}

function mapAutomationTargetsToDisplays(displays, elements, dipToScreenPoint) {
  const result = new Map(displays.map((display) => [String(display.id), []]));
  displays.forEach((display) => {
    const scaleFactor = Number(display.scaleFactor) || 1;
    const physicalOrigin = dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y });
    const physicalBounds = {
      left: physicalOrigin.x,
      top: physicalOrigin.y,
      right: physicalOrigin.x + Math.round(display.bounds.width * scaleFactor),
      bottom: physicalOrigin.y + Math.round(display.bounds.height * scaleFactor),
    };
    const targets = result.get(String(display.id));
    const seen = new Set();
    elements.forEach((element) => {
      if (targets.length >= MAX_AUTOMATION_TARGETS) return;
      const clipped = intersectRect(element, physicalBounds);
      if (!clipped) return;
      const target = {
        left: (clipped.left - physicalBounds.left) / scaleFactor,
        top: (clipped.top - physicalBounds.top) / scaleFactor,
        width: (clipped.right - clipped.left) / scaleFactor,
        height: (clipped.bottom - clipped.top) / scaleFactor,
        title: element.title || '智能区域',
        zIndex: Number(element.zIndex) || 0,
        source: 'uia',
        controlType: element.controlType || '',
      };
      if (target.width < MIN_AUTOMATION_TARGET_WIDTH || target.height < MIN_AUTOMATION_TARGET_HEIGHT) return;
      const key = [target.left, target.top, target.width, target.height].map((value) => Math.round(value)).join(',');
      if (seen.has(key)) return;
      seen.add(key);
      targets.push(target);
    });
    targets.sort((left, right) => (left.width * left.height) - (right.width * right.height));
  });
  return result;
}

function mapLogicalWindowTargetsToDisplays(displays, windows) {
  const result = new Map(displays.map((display) => [String(display.id), []]));
  displays.forEach((display) => {
    const displayBounds = {
      left: display.bounds.x,
      top: display.bounds.y,
      right: display.bounds.x + display.bounds.width,
      bottom: display.bounds.y + display.bounds.height,
    };
    const targets = result.get(String(display.id));
    windows.forEach((window) => {
      const clipped = intersectRect(window, displayBounds);
      if (!clipped) return;
      const target = {
        left: clipped.left - displayBounds.left,
        top: clipped.top - displayBounds.top,
        width: clipped.right - clipped.left,
        height: clipped.bottom - clipped.top,
        title: window.title,
        zIndex: window.zIndex,
      };
      if (target.width >= MIN_TARGET_WIDTH && target.height >= MIN_TARGET_HEIGHT) targets.push(target);
    });
  });
  return result;
}

function getCaptureWindowTargets(displays, dipToScreenPoint) {
  if (process.platform === 'win32' && typeof dipToScreenPoint === 'function') {
    return mapWindowTargetsToDisplays(displays, enumerateVisibleWindows(), dipToScreenPoint);
  }
  if (process.platform === 'darwin') {
    return mapLogicalWindowTargetsToDisplays(displays, enumerateMacVisibleWindows());
  }
  return new Map(displays.map((display) => [String(display.id), []]));
}

function warmWindowTargetDetection() {
  if (process.platform === 'win32') getNativeApi();
  if (process.platform === 'darwin') getMacNativeApi();
}

function isMacWindowTargetBackendAvailable() {
  return process.platform === 'darwin' && Boolean(getMacNativeApi());
}

module.exports = {
  enumerateMacVisibleWindows,
  enumerateVisibleWindows,
  getCaptureWindowTargets,
  isMacWindowTargetBackendAvailable,
  mapAutomationTargetsToDisplays,
  mapAutomationTargetsToWindowTarget,
  mapLogicalWindowTargetsToDisplays,
  mapWindowTargetsToDisplays,
  warmWindowTargetDetection,
};
