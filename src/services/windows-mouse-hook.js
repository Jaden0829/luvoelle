let hookState;
const WH_MOUSE_LL = 14;

function installWindowsMouseHook(onLeftButtonDown) {
  if (process.platform !== 'win32' || hookState) return Boolean(hookState);
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const POINT = koffi.struct('LuvoelleHookPoint', { x: 'int32_t', y: 'int32_t' });
  const MSLLHOOKSTRUCT = koffi.struct('LuvoelleMouseHookData', {
    pt: POINT,
    mouseData: 'uint32_t',
    flags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const HookCallback = koffi.proto('intptr_t __stdcall LuvoelleMouseHookCallback(int code, uintptr_t message, void *data)');
  const SetWindowsHookExW = user32.func('void * __stdcall SetWindowsHookExW(int idHook, LuvoelleMouseHookCallback *callback, void *module, uint32_t threadId)');
  const CallNextHookEx = user32.func('intptr_t __stdcall CallNextHookEx(void *hook, int code, uintptr_t message, void *data)');
  const UnhookWindowsHookEx = user32.func('bool __stdcall UnhookWindowsHookEx(void *hook)');
  const GetModuleHandleW = kernel32.func('void * __stdcall GetModuleHandleW(const uint16_t *moduleName)');
  const callback = koffi.register((code, message, data) => {
    if (code >= 0 && Number(message) === 0x0201) {
      const event = koffi.decode(data, MSLLHOOKSTRUCT);
      onLeftButtonDown({ x: event.pt.x, y: event.pt.y });
    }
    return CallNextHookEx(null, code, message, data);
  }, koffi.pointer(HookCallback));
  const hook = SetWindowsHookExW(WH_MOUSE_LL, callback, GetModuleHandleW(null), 0);
  if (!hook) {
    koffi.unregister(callback);
    return false;
  }
  hookState = { koffi, callback, hook, UnhookWindowsHookEx };
  return true;
}

function uninstallWindowsMouseHook() {
  if (!hookState) return;
  const state = hookState;
  hookState = null;
  try { state.UnhookWindowsHookEx(state.hook); } finally { state.koffi.unregister(state.callback); }
}

module.exports = { installWindowsMouseHook, uninstallWindowsMouseHook };
