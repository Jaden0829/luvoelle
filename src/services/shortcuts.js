const SHORTCUT_DEFINITIONS = Object.freeze([
  { id: 'quickEdit', label: '菜单截图标注', defaultAccelerator: 'F1' },
  { id: 'translate', label: '截图翻译', defaultAccelerator: 'Alt+S' },
  { id: 'ocr', label: '截图取字', defaultAccelerator: 'Alt+O' },
  { id: 'prompt', label: '截图转提示词', defaultAccelerator: 'Alt+P' },
  { id: 'edit', label: '快速截图标注', defaultAccelerator: 'Alt+A' },
  { id: 'text', label: '文本翻译', defaultAccelerator: 'Alt+T' },
]);

const DEFAULT_SHORTCUTS = Object.freeze(Object.fromEntries(
  SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition.defaultAccelerator]),
));

const MODIFIER_ALIASES = new Map([
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['commandorcontrol', 'Ctrl'],
  ['cmdorctrl', 'Ctrl'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['command', 'Super'],
  ['cmd', 'Super'],
  ['shift', 'Shift'],
  ['super', 'Super'],
  ['meta', 'Super'],
  ['win', 'Super'],
  ['windows', 'Super'],
]);

const KEY_ALIASES = new Map([
  ['return', 'Enter'],
  ['enter', 'Enter'],
  ['esc', 'Escape'],
  ['escape', 'Escape'],
  ['arrowup', 'Up'],
  ['arrowdown', 'Down'],
  ['arrowleft', 'Left'],
  ['arrowright', 'Right'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['printscreen', 'PrintScreen'],
  ['spacebar', 'Space'],
  ['space', 'Space'],
  ['plus', 'Plus'],
]);

const NAMED_KEYS = new Set([
  'Space', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  'PrintScreen', 'Plus',
]);

function normalizeKey(value) {
  const token = String(value || '').trim();
  if (!token) throw new Error('快捷键缺少主按键。');
  const alias = KEY_ALIASES.get(token.toLowerCase());
  if (alias) return alias;
  if (/^[a-z]$/i.test(token)) return token.toUpperCase();
  if (/^[0-9]$/.test(token)) return token;
  const functionKey = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(token);
  if (functionKey) return `F${functionKey[1]}`;
  const named = Array.from(NAMED_KEYS).find((candidate) => candidate.toLowerCase() === token.toLowerCase());
  if (named) return named;
  throw new Error(`暂不支持按键“${token}”，请使用字母、数字、F1～F24 或常用导航键。`);
}

function normalizeAccelerator(value) {
  const tokens = String(value || '').split('+').map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) throw new Error('快捷键不能为空。');
  const modifiers = new Set();
  let key = '';
  tokens.forEach((token) => {
    const modifier = MODIFIER_ALIASES.get(token.toLowerCase());
    if (modifier) {
      modifiers.add(modifier);
      return;
    }
    if (key) throw new Error('一个快捷键只能包含一个主按键。');
    key = normalizeKey(token);
  });
  if (!key) throw new Error('快捷键缺少主按键。');
  if (!modifiers.size && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) && key !== 'PrintScreen') {
    throw new Error('单按键快捷键仅支持 F1～F24 或 PrintScreen，避免影响正常输入。');
  }
  const orderedModifiers = ['Ctrl', 'Alt', 'Shift', 'Super'].filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, key].join('+');
}

function normalizeShortcutMap(value = {}, fallback = DEFAULT_SHORTCUTS) {
  const normalized = {};
  SHORTCUT_DEFINITIONS.forEach(({ id }) => {
    normalized[id] = normalizeAccelerator(value[id] ?? fallback[id] ?? DEFAULT_SHORTCUTS[id]);
  });
  const used = new Map();
  SHORTCUT_DEFINITIONS.forEach(({ id, label }) => {
    const accelerator = normalized[id].toLowerCase();
    if (used.has(accelerator)) {
      const previous = SHORTCUT_DEFINITIONS.find((definition) => definition.id === used.get(accelerator));
      throw new Error(`“${previous?.label || used.get(accelerator)}”与“${label}”不能使用同一个快捷键。`);
    }
    used.set(accelerator, id);
  });
  return normalized;
}

module.exports = {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFINITIONS,
  normalizeAccelerator,
  normalizeShortcutMap,
};
