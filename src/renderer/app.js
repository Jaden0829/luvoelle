const bridge = window.luvoelle;

const state = {
  settings: {},
  history: [],
  currentJob: null,
  currentImage: '',
  historyFilter: 'all',
  historyQuery: '',
  boxesVisible: false,
  sourceEditSnapshot: '',
  settingsBaseline: null,
  platform: 'win32',
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const DEFAULT_SHORTCUTS = {
  quickEdit: 'F1',
  translate: 'Alt+S',
  ocr: 'Alt+O',
  prompt: 'Alt+P',
  edit: 'Alt+A',
  text: 'Alt+T',
};

let activeShortcutRecorder = null;
let shortcutSaveError = '';
let manualImageSequence = 0;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function formatRelativeDate(value) {
  const date = new Date(value);
  const difference = Date.now() - date.getTime();
  if (difference < 60_000) return '刚刚';
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)} 分钟前`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function toast(message, kind = 'success') {
  const element = document.createElement('div');
  element.className = `toast ${kind === 'error' ? 'error' : ''}`;
  element.innerHTML = `<span>${escapeHtml(message)}</span>`;
  $('#toast-stack').appendChild(element);
  setTimeout(() => {
    element.classList.add('is-leaving');
    setTimeout(() => element.remove(), 220);
  }, 2600);
}

function shortcutText(accelerator) {
  return String(accelerator || '').split('+').map(shortcutPartLabel).join(' + ');
}

function shortcutMarkup(accelerator) {
  return String(accelerator || '').split('+')
    .map((part) => `<kbd>${escapeHtml(shortcutPartLabel(part))}</kbd>`)
    .join('<i>+</i>');
}

function shortcutPartLabel(part) {
  if (state.platform !== 'darwin') return part;
  return ({ Alt: '⌥', Super: '⌘', Ctrl: '⌃', Shift: '⇧' })[part] || part;
}

function readShortcutDraft() {
  return Object.fromEntries($$('[data-shortcut-input]').map((button) => [button.dataset.shortcutInput, button.dataset.shortcut || '']));
}

function renderShortcutDisplays() {
  const shortcuts = { ...DEFAULT_SHORTCUTS, ...(state.settings.shortcuts || {}) };
  $$('[data-shortcut-display]').forEach((element) => {
    const arrow = element.classList.contains('action-meta') ? '<span class="round-arrow">↗</span>' : '';
    element.innerHTML = `${shortcutMarkup(shortcuts[element.dataset.shortcutDisplay])}${arrow}`;
  });
  $('#quick-edit-action-note').textContent = `${shortcutText(shortcuts.edit)} 快速 · ${shortcutText(shortcuts.quickEdit)} 菜单保真`;
}

function renderShortcutButton(button) {
  button.textContent = shortcutText(button.dataset.shortcut);
}

function validateShortcutDraft() {
  const used = new Map();
  let conflict = '';
  $$('[data-shortcut-row]').forEach((row) => row.classList.remove('is-conflict'));
  Object.entries(readShortcutDraft()).forEach(([id, accelerator]) => {
    const normalized = accelerator.toLowerCase();
    if (!normalized || conflict) return;
    if (used.has(normalized)) {
      conflict = `“${shortcutText(accelerator)}”被重复使用，请为每项设置不同按键。`;
      $(`[data-shortcut-row="${id}"]`)?.classList.add('is-conflict');
      $(`[data-shortcut-row="${used.get(normalized)}"]`)?.classList.add('is-conflict');
    } else {
      used.set(normalized, id);
    }
  });
  const note = $('#shortcut-settings-note');
  note.classList.toggle('is-error', Boolean(conflict || shortcutSaveError));
  note.textContent = conflict || shortcutSaveError || '单按键仅支持 F1～F24 或 PrintScreen，避免影响正常输入。';
  return !conflict;
}

function renderShortcutSettings() {
  const shortcuts = { ...DEFAULT_SHORTCUTS, ...(state.settings.shortcuts || {}) };
  $$('[data-shortcut-input]').forEach((button) => {
    button.dataset.shortcut = shortcuts[button.dataset.shortcutInput];
    renderShortcutButton(button);
    const status = state.settings.shortcutStatus?.[button.dataset.shortcutInput];
    const row = button.closest('[data-shortcut-row]');
    row.classList.toggle('is-unavailable', status?.registered === false);
    $('.shortcut-status', row).textContent = status?.registered === false ? '未生效' : '已生效';
  });
  validateShortcutDraft();
  renderShortcutDisplays();
}

function acceleratorFromKeyboardEvent(event) {
  const modifierKeys = new Set(['Control', 'Alt', 'Shift', 'Meta', 'AltGraph']);
  if (modifierKeys.has(event.key)) return '';
  const aliases = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Esc: 'Escape',
    Return: 'Enter',
    '+': 'Plus',
  };
  let key = aliases[event.key] || event.key;
  if (/^[a-z]$/i.test(key)) key = key.toUpperCase();
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(key)) key = key.toUpperCase();
  const namedKeys = new Set(['Space', 'Tab', 'Enter', 'Backspace', 'Delete', 'Insert', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'PrintScreen', 'Plus']);
  if (!/^[A-Z0-9]$/.test(key) && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) && !namedKeys.has(key)) {
    throw new Error(`暂不支持按键“${key}”。`);
  }
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');
  if (!modifiers.length && !/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) && key !== 'PrintScreen') {
    throw new Error('单按键仅支持 F1～F24 或 PrintScreen。');
  }
  return [...modifiers, key].join('+');
}

async function stopShortcutRecording(button = activeShortcutRecorder) {
  if (!button || activeShortcutRecorder !== button) return;
  activeShortcutRecorder = null;
  button.classList.remove('is-recording');
  renderShortcutButton(button);
  try {
    const result = await bridge.stopShortcutRecording();
    state.settings.shortcutStatus = result.status;
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function startShortcutRecording(button) {
  if (activeShortcutRecorder && activeShortcutRecorder !== button) await stopShortcutRecording(activeShortcutRecorder);
  try {
    await bridge.startShortcutRecording();
    shortcutSaveError = '';
    activeShortcutRecorder = button;
    button.classList.add('is-recording');
    button.textContent = '请按新快捷键';
    $('#shortcut-settings-note').classList.remove('is-error');
    $('#shortcut-settings-note').textContent = '正在录入；按 Esc 取消。录入期间全局快捷键会暂时暂停。';
  } catch (error) {
    toast(error.message, 'error');
  }
}

function navigate(view) {
  const target = document.querySelector(`[data-view-panel="${view}"]`) ? view : 'workspace';
  $$('[data-view-panel]').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.viewPanel === target));
  $$('.nav-item[data-view]').forEach((item) => item.classList.toggle('is-active', item.dataset.view === target));
  $('.main-content').scrollTop = 0;
  if (target === 'history') renderHistory();
  if (target === 'settings') populateSettings();
}

function setProgress(value, label) {
  $('#progress-bar').style.width = `${Math.max(3, Math.min(100, value || 3))}%`;
  if (label) $('#result-meta').textContent = label;
}

function stageLabel(stage) {
  const labels = {
    'paddle-ocr': '正在提取文字',
    'paddle-refine': '正在增强较小和低置信文字',
    'tesseract-fallback': '正在切换兼容识别引擎',
    'loading tesseract core': '正在启动本地识别引擎',
    'initializing tesseract': '正在初始化本地 OCR',
    'loading language traineddata': '正在载入中英文识别模型',
    'initializing api': '正在准备文字识别',
    'recognizing text': '正在从画面中提取文字',
    'ai-ocr': '本地文字已提取，正在用 GPT 校正',
    translating: '文字已提取，正在翻译',
  };
  return labels[stage] || '正在理解画面';
}

function resetResult(job) {
  exitSourceEditMode();
  state.currentJob = job;
  state.currentImage = job.image || '';
  const panel = $('#result-panel');
  panel.hidden = false;
  panel.classList.remove('is-complete', 'is-failed');
  $('#result-title').textContent = job.mode === 'ocr' ? '正在提取文字' : '正在理解画面';
  $('#result-meta').textContent = '准备文字识别';
  setProgress(4);
  $('#source-text').className = 'text-content is-loading';
  $('#source-text').innerHTML = '<span class="skeleton"></span><span class="skeleton short"></span><span class="skeleton"></span>';
  $('#translation-text').className = 'text-content is-loading';
  $('#translation-text').innerHTML = '<span class="skeleton"></span><span class="skeleton"></span><span class="skeleton short"></span>';
  $('#translation-pane').hidden = job.mode === 'ocr' || Boolean(job.translationSkipped);
  $('#ocr-box-layer').replaceChildren();
  state.boxesVisible = false;
  $('#toggle-boxes').classList.remove('is-active');
  const preview = $('#capture-preview');
  const image = $('#result-image');
  if (job.image) {
    image.src = job.image;
    preview.classList.add('has-image');
  } else {
    image.removeAttribute('src');
    preview.classList.remove('has-image');
    $('.preview-placeholder p', preview).textContent = '截图未保存，仅保留文字结果';
    $('.spinner', preview).style.display = 'none';
  }
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function ocrProviderLabel(ocr) {
  return String(ocr?.provider || 'PP-OCRv6 small 本地 OCR');
}

function ocrDisplayMeta(ocr, { preview = false, chinese = false } = {}) {
  const parts = [];
  if (chinese) parts.push('中文内容');
  if (preview) parts.push('当前文字可先查看，AI 完成后自动更新');
  else {
    if (Number(ocr?.confidence || 0) > 0) parts.push(`${Math.round(ocr.confidence)}% 置信度`);
    if (Number(ocr?.blocks?.length || 0) > 0) parts.push(`${ocr.blocks.length} 行`);
  }
  if (ocr?.localRefined) parts.push('小字增强');
  if (ocr?.corrected) parts.push('已校正');
  return parts.join(' · ') || '识别完成';
}

function renderOcr(ocr, { enhancing = false } = {}) {
  state.currentJob = { ...(state.currentJob || {}), ocr };
  const source = $('#source-text');
  source.className = 'text-content';
  source.textContent = ocr.text;
  const translationSkipped = Boolean(state.currentJob.translationSkipped);
  $('#translation-pane').hidden = state.currentJob.mode === 'ocr' || translationSkipped;
  $('#result-title').textContent = enhancing ? '本地文字已提取，GPT 校正中' : state.currentJob.mode === 'ocr' ? '文字已提取' : translationSkipped ? '中文识别完成' : '文字已提取，正在翻译';
  $('#result-meta').textContent = ocrDisplayMeta(ocr, {
    preview: enhancing,
    chinese: translationSkipped,
  });
  setProgress(enhancing ? 84 : state.currentJob.mode === 'ocr' || translationSkipped ? 100 : 88);
  renderOcrBoxes();
}

function renderCompleted(job, autoCopied = false) {
  const retainedImage = job.image || (state.currentJob?.id === job.id ? state.currentJob.image : '') || state.currentImage;
  job = { ...job, image: retainedImage };
  state.currentJob = job;
  state.currentImage = job.image || state.currentImage;
  const panel = $('#result-panel');
  panel.hidden = false;
  panel.classList.add('is-complete');
  panel.classList.remove('is-failed');
  $('#result-title').textContent = job.mode === 'ocr' ? '文字已提取并复制' : job.translationSkipped ? '中文识别完成' : '翻译完成';
  $('#result-meta').textContent = job.translationSkipped
    ? ocrDisplayMeta(job.ocr, { chinese: true })
    : job.translation
      ? `${job.translation.provider} · ${job.translation.latency} ms · ${ocrDisplayMeta(job.ocr)}`
      : ocrDisplayMeta(job.ocr);
  $('#source-text').className = 'text-content';
  $('#source-text').textContent = job.ocr.text;
  $('#translation-pane').hidden = !job.translation;
  if (job.translation) {
    $('#translation-text').className = 'text-content';
    $('#translation-text').textContent = job.translation.text;
  }
  setProgress(100);
  renderOcrBoxes();
  addHistoryLocally(job);
  renderRecent();
  if (autoCopied) toast('识别文字已复制到剪贴板');
}

function renderFailure(message) {
  const panel = $('#result-panel');
  panel.classList.add('is-failed');
  panel.classList.remove('is-complete');
  $('#result-title').textContent = '这次没有完成';
  $('#result-meta').textContent = message;
  $('#progress-bar').style.width = '100%';
  $('#progress-bar').style.background = '#e14848';
  const translation = $('#translation-text');
  translation.className = 'text-content';
  translation.textContent = message;
  toast(message, 'error');
}

function handleJobEvent(event) {
  if (!event) return;
  if (event.type === 'started') resetResult(event.job);
  if (event.type === 'progress') setProgress(event.progress, stageLabel(event.stage));
  if (event.type === 'ocr-preview') {
    state.currentJob = { ...event.job, ocrEnhancing: true };
    renderOcr(event.job.ocr, { enhancing: true });
  }
  if (event.type === 'ocr-complete') {
    state.currentJob = { ...event.job, ocrEnhancing: false };
    renderOcr(event.job.ocr);
  }
  if (event.type === 'completed') renderCompleted(event.job, event.autoCopied);
  if (event.type === 'correction-started' && state.currentJob?.id === event.jobId) {
    $('#result-title').textContent = event.mode === 'ocr' || event.translationSkipped ? '正在保存修正' : '正在按修正原文重新翻译';
    setProgress(event.mode === 'ocr' || event.translationSkipped ? 95 : 90, event.mode === 'ocr' ? '正在更新历史与剪贴板' : event.translationSkipped ? '检测到中文，将跳过翻译' : '已保存校正，正在请求翻译服务');
  }
  if (event.type === 'corrected') {
    const isCurrent = state.currentJob?.id === event.job.id;
    const merged = isCurrent ? { ...event.job, image: state.currentJob.image || state.currentImage } : event.job;
    exitSourceEditMode();
    renderCompleted(merged, false);
    toast(event.job.mode === 'ocr' ? '修正已保存并重新复制' : event.job.translationSkipped ? '中文原文已保存，已跳过翻译' : '已按修正原文重新翻译');
  }
  if (event.type === 'failed') renderFailure(event.message);
}

function addHistoryLocally(job) {
  const nextItem = {
    id: job.id,
    mode: job.mode,
    createdAt: job.createdAt,
    sourceText: job.ocr.text,
    translation: job.translation?.text || '',
    sourceLanguage: job.ocr.detectedLanguage,
    targetLanguage: job.translation?.targetLanguage || '',
    confidence: job.ocr.confidence,
    provider: job.translation?.provider || ocrProviderLabel(job.ocr),
    ocrProvider: ocrProviderLabel(job.ocr),
    ocrEnhanced: Boolean(job.ocr.enhanced),
    corrected: Boolean(job.ocr.corrected),
    translationSkipped: Boolean(job.translationSkipped),
  };
  const existingIndex = state.history.findIndex((item) => item.id === job.id);
  if (existingIndex >= 0) state.history.splice(existingIndex, 1, { ...state.history[existingIndex], ...nextItem });
  else state.history.unshift(nextItem);
  state.history = state.history.slice(0, 120);
  updateHistoryCount();
}

function exitSourceEditMode() {
  const source = $('#source-text');
  if (!source) return;
  source.contentEditable = 'false';
  source.classList.remove('is-editing');
  const editButton = $('#edit-source-text');
  const cancelButton = $('#cancel-source-edit');
  if (editButton) {
    editButton.disabled = false;
    editButton.textContent = '保存并重译';
    editButton.hidden = true;
  }
  if (cancelButton) cancelButton.hidden = true;
  state.sourceEditSnapshot = '';
}

function placeCaretAtPointer(element, event) {
  let range = null;
  if (event && document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(event.clientX, event.clientY);
    if (position && element.contains(position.offsetNode)) {
      range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
    }
  } else if (event && document.caretRangeFromPoint) {
    const candidate = document.caretRangeFromPoint(event.clientX, event.clientY);
    if (candidate && element.contains(candidate.startContainer)) range = candidate;
  }
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
  } else {
    range.collapse(true);
  }
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function beginSourceEdit(event) {
  const source = $('#source-text');
  if (!state.currentJob?.ocr || source.classList.contains('is-loading') || source.classList.contains('is-editing')) return;
  if (state.currentJob.ocrEnhancing) return toast('GPT 校正完成后即可修改原文');
  state.sourceEditSnapshot = source.textContent;
  source.contentEditable = 'true';
  source.spellcheck = true;
  source.classList.add('is-editing');
  $('#cancel-source-edit').hidden = false;
  $('#edit-source-text').hidden = false;
  $('#edit-source-text').textContent = state.currentJob.mode === 'ocr' || state.currentJob.translationSkipped ? '保存修改' : '保存并重译';
  source.focus();
  placeCaretAtPointer(source, event);
}

function cancelSourceEdit() {
  const source = $('#source-text');
  if (state.sourceEditSnapshot) source.textContent = state.sourceEditSnapshot;
  exitSourceEditMode();
}

async function saveSourceCorrection() {
  const source = $('#source-text');
  const button = $('#edit-source-text');
  const text = source.innerText.replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return toast('修正后的原文不能为空', 'error');
  if (text === state.sourceEditSnapshot.trim()) {
    exitSourceEditMode();
    return toast('原文没有发生变化');
  }
  source.contentEditable = 'false';
  source.classList.remove('is-editing');
  button.disabled = true;
  button.textContent = state.currentJob.mode === 'ocr' || state.currentJob.translationSkipped ? '保存中…' : '重译中…';
  try {
    await bridge.applyCorrection({
      id: state.currentJob.id,
      text,
      mode: state.currentJob.mode,
      origin: state.currentJob.origin,
      createdAt: state.currentJob.createdAt,
      confidence: state.currentJob.ocr.confidence,
      ocrProvider: ocrProviderLabel(state.currentJob.ocr),
      ocrEnhanced: Boolean(state.currentJob.ocr.enhanced),
      detectedLanguage: state.currentJob.ocr.detectedLanguage,
      targetLanguage: state.currentJob.translation?.targetLanguage || state.settings.targetLanguage,
    });
  } catch (error) {
    button.disabled = false;
    button.textContent = state.currentJob.mode === 'ocr' || state.currentJob.translationSkipped ? '保存修改' : '保存并重译';
    source.contentEditable = 'true';
    source.classList.add('is-editing');
    source.focus();
    toast(error.message, 'error');
  }
}

function updateHistoryCount() {
  $('#history-count').textContent = state.history.length > 99 ? '99+' : state.history.length;
}

function renderRecent() {
  const container = $('#recent-grid');
  const recent = state.history.slice(0, 3);
  if (!recent.length) {
    container.innerHTML = '<div class="empty-card">第一次截图后，识别结果会安静地出现在这里。</div>';
    return;
  }
  container.innerHTML = recent.map((item) => `
    <article class="recent-card" data-history-id="${escapeHtml(item.id)}" tabindex="0">
      <div class="recent-card-header"><span class="type-badge ${item.mode === 'prompt' ? 'prompt' : item.mode === 'ocr' || item.translationSkipped ? 'ocr' : ''}">${item.mode === 'prompt' ? '视觉拆解' : item.mode === 'ocr' ? 'OCR' : item.translationSkipped ? '中文取字' : '翻译'}${item.corrected ? ' · 已校正' : ''}</span><time>${formatRelativeDate(item.createdAt)}</time></div>
      <p>${escapeHtml(item.translation || item.sourceText)}</p>
    </article>
  `).join('');
}

function historyItemToJob(item) {
  return {
    id: item.id,
    mode: item.mode,
    translationSkipped: Boolean(item.translationSkipped),
    createdAt: item.createdAt,
    image: '',
    ocr: {
      text: item.sourceText,
      confidence: item.confidence,
      detectedLanguage: item.sourceLanguage,
      provider: item.ocrProvider || (!item.translation ? item.provider : 'PP-OCRv6 small 本地 OCR'),
      enhanced: Boolean(item.ocrEnhanced),
      blocks: [],
    },
    translation: item.translation ? {
      text: item.translation,
      provider: item.provider,
      targetLanguage: item.targetLanguage,
      latency: 0,
    } : null,
  };
}

async function openHistoryItem(id) {
  const item = state.history.find((candidate) => candidate.id === id);
  if (!item) return;
  if (item.mode === 'prompt') {
    try {
      await bridge.openPromptHistory(id);
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  navigate('workspace');
  const job = historyItemToJob(item);
  resetResult(job);
  renderCompleted(job);
}

function renderHistory() {
  const container = $('#history-list');
  const query = state.historyQuery.toLocaleLowerCase();
  const items = state.history.filter((item) => {
    const modeMatches = state.historyFilter === 'all' || item.mode === state.historyFilter;
    const queryMatches = !query || `${item.sourceText} ${item.translation}`.toLocaleLowerCase().includes(query);
    return modeMatches && queryMatches;
  });
  if (!items.length) {
    container.innerHTML = `
      <div class="history-empty"><div>
        <svg viewBox="0 0 48 48"><path d="M8 24a16 16 0 1 0 4.7-11.3L8 17m0-9v9h9M24 14v10l7 4"/></svg>
        <strong>${state.history.length ? '没有匹配的结果' : '还没有历史记录'}</strong>
        <span>${state.history.length ? '换一个关键词试试看' : `使用 ${shortcutText(state.settings.shortcuts?.translate || DEFAULT_SHORTCUTS.translate)} 开始第一次截图翻译`}</span>
      </div></div>`;
    return;
  }
  container.innerHTML = items.map((item) => `
    <article class="history-item" data-history-id="${escapeHtml(item.id)}">
      <div class="history-item-meta"><span class="type-badge ${item.mode === 'prompt' ? 'prompt' : item.mode === 'ocr' || item.translationSkipped ? 'ocr' : ''}">${item.mode === 'prompt' ? '视觉拆解' : item.mode === 'ocr' ? 'OCR 取字' : item.translationSkipped ? '中文取字' : item.mode === 'text' ? '文本翻译' : '截图翻译'}</span><time>${formatRelativeDate(item.createdAt)}</time></div>
      <div class="history-column"><span>${item.mode === 'prompt' ? '视觉摘要' : `原文${item.corrected ? ' · 已校正' : ''}`}</span><p>${escapeHtml(item.sourceText)}</p></div>
      <div class="history-column"><span>${item.mode === 'prompt' ? '通用提示词' : item.translation ? '译文' : '识别结果'}</span><p>${escapeHtml(item.translation || item.sourceText)}</p></div>
      <button class="icon-button history-delete" data-delete-history="${escapeHtml(item.id)}" aria-label="删除"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/></svg></button>
    </article>
  `).join('');
}

function getRenderedImageRect() {
  const preview = $('#capture-preview');
  const image = $('#result-image');
  if (!image.naturalWidth || !image.naturalHeight) return null;
  const previewRect = preview.getBoundingClientRect();
  const scale = Math.min(preview.clientWidth / image.naturalWidth, preview.clientHeight / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  return { x: (preview.clientWidth - width) / 2, y: (preview.clientHeight - height) / 2, width, height, previewRect };
}

function renderOcrBoxes() {
  const layer = $('#ocr-box-layer');
  layer.replaceChildren();
  const blocks = state.currentJob?.ocr?.blocks || [];
  const image = $('#result-image');
  const rect = getRenderedImageRect();
  if (!rect || !blocks.length) return;
  blocks.forEach((block) => {
    const box = document.createElement('span');
    box.className = 'ocr-box';
    box.title = `${block.confidence}% · ${block.text}`;
    box.style.left = `${rect.x + (block.rect.x / image.naturalWidth) * rect.width}px`;
    box.style.top = `${rect.y + (block.rect.y / image.naturalHeight) * rect.height}px`;
    box.style.width = `${(block.rect.width / image.naturalWidth) * rect.width}px`;
    box.style.height = `${(block.rect.height / image.naturalHeight) * rect.height}px`;
    layer.appendChild(box);
  });
}

async function beginCapture(mode) {
  try {
    const result = await bridge.startCapture(mode);
    if (result && !result.ok && !result.canceled) toast(result.message || '无法开始截图', 'error');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function processDataUrl(dataUrl, mode = 'translate') {
  if (!dataUrl) return;
  if (mode === 'prompt') {
    try {
      await bridge.processImage({ dataUrl, mode });
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  navigate('workspace');
  resetResult({ id: `pending-${Date.now()}`, mode, origin: 'import', createdAt: new Date().toISOString(), image: dataUrl });
  try {
    await bridge.processImage({ dataUrl, mode });
  } catch (error) {
    renderFailure(error.message);
  }
}

async function chooseImage(mode = 'translate') {
  try {
    const dataUrl = await bridge.selectImage();
    if (dataUrl) await processDataUrl(dataUrl, mode);
  } catch (error) {
    toast(error.message, 'error');
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) return reject(new Error('请拖入 PNG、JPG 或 WebP 图片。'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('无法读取这张图片。'));
    reader.readAsDataURL(file);
  });
}

async function copyElementText(id) {
  const element = document.getElementById(id);
  const text = element?.textContent?.trim();
  if (!text || text === '译文会出现在这里。') return;
  await bridge.copyText(text);
  toast('已复制到剪贴板');
}

function renderVisionServiceStatus({ phase = 'saved', model, endpoint, models = [], error = '' } = {}) {
  const block = $('#vision-service-status-block');
  const configured = $('#vision-configured-model');
  const status = $('#vision-service-status');
  const detected = $('#vision-detected-models');
  const detectedSummary = $('#vision-detected-models-summary');
  const detectedList = $('#vision-detected-models-list');
  const currentModel = String(model || '').trim();
  const returnedModels = Array.isArray(models) ? models.map((item) => String(item || '').trim()).filter(Boolean) : [];
  const normalizedCurrent = currentModel.toLowerCase();
  const modelWasListed = Boolean(normalizedCurrent && returnedModels.some((item) => item.toLowerCase() === normalizedCurrent));
  detectedVisionModels = returnedModels;
  renderVisionModelOptions();

  block.classList.remove('is-connected', 'is-warning', 'is-error');
  detected.hidden = returnedModels.length === 0;
  detected.open = false;
  detectedSummary.textContent = `查看服务返回的模型（${returnedModels.length}）`;
  detectedList.textContent = returnedModels.join('、');

  if (phase === 'checking') {
    configured.textContent = currentModel ? `待保存模型 · ${currentModel}` : '尚未填写视觉模型';
    status.textContent = '正在连接服务并读取模型目录…';
    return;
  }
  if (phase === 'error') {
    block.classList.add('is-error');
    configured.textContent = currentModel ? `未保存本次更改 · ${currentModel}` : '视觉服务连接失败';
    status.textContent = error || '请检查接口地址、模型名称和服务状态';
    return;
  }
  if (phase === 'connected') {
    configured.textContent = `已保存模型 · ${currentModel}`;
    if (returnedModels.length === 0) {
      block.classList.add('is-warning');
      status.textContent = '接口连接成功，但服务没有返回模型目录；实际识图时会按当前名称调用';
    } else if (modelWasListed) {
      block.classList.add('is-connected');
      status.textContent = '接口连接成功 · 模型目录中已找到当前名称';
    } else {
      block.classList.add('is-warning');
      status.textContent = '接口连接成功，但模型目录未列出当前名称；配置仍已按你的填写保存';
    }
    return;
  }
  if (phase === 'models') {
    block.classList.add('is-connected');
    configured.textContent = '服务已连接 · 请选择视觉模型';
    status.textContent = returnedModels.length
      ? '模型目录已载入；在上方模型框中选择或输入视觉模型，然后再次点击“检测并保存”'
      : '服务连接成功，但没有返回模型目录；请手动填写视觉模型名称';
    return;
  }

  configured.textContent = currentModel ? `已保存模型 · ${currentModel}` : '尚未保存视觉模型';
  status.textContent = endpoint ? '配置已保存 · 点击“检测并保存”可重新确认服务' : '支持 llama.cpp、vLLM、LM Studio 与 Cockpit Tools';
}

const CUN_API_ENDPOINT = 'https://www.cun.ai/v1';
const DEEPSEEK_API_ENDPOINT = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const CUN_MODEL_PRESETS = Object.freeze([
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol · 旗舰能力' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · 能力与成本平衡' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · 高吞吐低成本' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini · 快速轻量' },
]);
let detectedVisionModels = [];

function mergedModelOptions(returnedModels = []) {
  const candidates = [
    ...CUN_MODEL_PRESETS,
    ...returnedModels.map((id) => ({ id, label: id })),
  ];
  const seen = new Set();
  return candidates.filter(({ id }) => {
    const normalized = String(id || '').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function replaceModelOptions(element, models) {
  element.replaceChildren(...models.map(({ id, label }) => {
    const option = document.createElement('option');
    option.value = id;
    option.label = label;
    return option;
  }));
}

function renderTranslationModelOptions() {
  const provider = $('#setting-provider').value;
  const models = provider === 'cun'
    ? CUN_MODEL_PRESETS
    : provider === 'deepseek' ? [{ id: DEEPSEEK_MODEL, label: 'DeepSeek V4 Flash' }] : [];
  replaceModelOptions($('#translation-model-options'), models);
}

function renderVisionModelOptions() {
  const models = $('#setting-vision-provider').value === 'cun'
    ? mergedModelOptions(detectedVisionModels)
    : detectedVisionModels.map((id) => ({ id, label: id }));
  replaceModelOptions($('#vision-model-options'), models);
}

function translationProviderLabel(settings = state.settings) {
  if (settings.provider === 'cun') return `CUN.AI · ${settings.model || '兼容模型'}`;
  if (settings.provider === 'deepseek') return `DeepSeek · ${settings.model || DEEPSEEK_MODEL}`;
  if (settings.provider === 'openai') return settings.model || 'GPT / 兼容模型';
  if (settings.provider === 'auto') return `自动选择 · Google / ${settings.model || 'GPT'}`;
  return 'Google Translate';
}

function populateSettings() {
  $('#setting-provider').value = state.settings.provider || 'google';
  $('#setting-endpoint').value = state.settings.endpoint || '';
  $('#setting-model').value = state.settings.model || '';
  $('#setting-target').value = state.settings.targetLanguage || 'zh-CN';
  $('#setting-ocr-mode').value = state.settings.ocrMode || 'local';
  $('#setting-login').checked = Boolean(state.settings.launchAtLogin);
  $('#setting-screenshots').checked = false;
  $('#setting-assistant-enabled').checked = state.settings.assistantEnabled !== false;
  $('#setting-assistant-side').value = state.settings.assistantSide === 'left' ? 'left' : 'right';
  updateTranslationKeyStatus();
  $('#setting-api-key').value = '';
  $('#setting-vision-provider').value = state.settings.visionProvider || 'local';
  $('#setting-vision-endpoint').value = state.settings.visionEndpoint || '';
  $('#setting-vision-model').value = state.settings.visionModel || '';
  $('#setting-vision-api-key').value = '';
  $('#vision-key-status').textContent = state.settings.hasVisionApiKey ? '· 已安全保存' : '';
  $('#setting-generation-endpoint').value = state.settings.generationEndpoint || '';
  $('#setting-generation-model').value = state.settings.generationModel || '';
  $('#setting-generation-api-key').value = '';
  $('#generation-key-status').textContent = state.settings.hasGenerationApiKey ? '· 已安全保存' : '';
  renderVisionServiceStatus({
    phase: 'saved',
    model: state.settings.visionModel,
    endpoint: state.settings.visionEndpoint,
  });
  toggleProviderFields();
  toggleVisionProviderFields();
  updateOcrModeUi();
  renderAssistantSettingsStatus();
  renderShortcutSettings();
  state.settingsBaseline = readSettingsDraft();
  refreshSettingsDirtyState();
}

function toggleProviderFields({ applyPreset = false } = {}) {
  const provider = $('#setting-provider').value;
  $('#provider-fields').hidden = provider === 'google';
  if (provider === 'cun' && applyPreset) $('#setting-endpoint').value = CUN_API_ENDPOINT;
  if (provider === 'deepseek' && applyPreset) {
    $('#setting-endpoint').value = DEEPSEEK_API_ENDPOINT;
    $('#setting-model').value = DEEPSEEK_MODEL;
  }
  $('#setting-endpoint').placeholder = provider === 'cun'
    ? CUN_API_ENDPOINT
    : provider === 'deepseek' ? DEEPSEEK_API_ENDPOINT : 'https://api.openai.com/v1';
  $('#setting-api-key').placeholder = provider === 'cun'
    ? '输入 CUN.AI 控制台 API Key（系统加密保存）'
    : provider === 'deepseek' ? '输入 DeepSeek API Key（系统加密保存）' : '输入新密钥（系统加密保存）';
  $('#translation-cun-models').hidden = provider !== 'cun';
  $('#deepseek-translation-help').hidden = provider !== 'deepseek';
  updateTranslationKeyStatus();
  renderTranslationModelOptions();
  $('#translation-provider-note').textContent = provider === 'google'
    ? 'Google 适合即时短句，速度优先'
    : provider === 'cun'
      ? '通过 CUN.AI 的 OpenAI Compatible 接口翻译'
    : provider === 'deepseek'
      ? '国内直连 DeepSeek V4 Flash，关闭思考以提升翻译速度'
    : provider === 'openai'
      ? '所有翻译均使用配置的 GPT / OpenAI 兼容模型'
      : '普通短句走 Google；110 字以上、60 字且至少两句、4 行以上及列表/表格使用 GPT';
}

function updateTranslationKeyStatus() {
  const provider = $('#setting-provider').value;
  const saved = provider === 'deepseek' ? state.settings.hasDeepSeekApiKey : state.settings.hasApiKey;
  $('#key-status').textContent = saved ? '· 已安全保存' : (provider === 'deepseek' ? '· 尚未配置' : '');
}

function toggleVisionProviderFields({ applyPreset = false } = {}) {
  const provider = $('#setting-vision-provider').value;
  const isCun = provider === 'cun';
  const isLocal = provider === 'local';
  if (isCun && applyPreset) $('#setting-vision-endpoint').value = CUN_API_ENDPOINT;
  $('#setting-vision-endpoint').placeholder = isCun ? CUN_API_ENDPOINT : isLocal ? 'http://127.0.0.1:8080/v1' : 'https://api.example.com/v1';
  $('#setting-vision-api-key').placeholder = isCun ? '输入 CUN.AI 控制台 API Key（系统加密保存）' : isLocal ? '本地服务通常无需填写' : '输入云端服务 API Key（系统加密保存）';
  $('#vision-provider-note').textContent = isCun
    ? '官方 OpenAI Compatible 网关，自动填入 Base URL'
    : isLocal ? '默认连接本机 OpenAI-compatible 服务' : '连接自定义 OpenAI-compatible 云端服务';
  $('#cun-vision-help').hidden = !isCun;
  $('#local-vision-help').hidden = !isLocal;
  $('#vision-cun-models').hidden = !isCun;
  renderVisionModelOptions();
  $('#reuse-vision-translation').textContent = isCun ? '复用并切换到 CUN.AI' : '复用并切换到 GPT';
}

function updateOcrModeUi() {
  const mode = $('#setting-ocr-mode').value;
  const descriptions = {
    local: '高精本地：离线识别，小字和低置信文字自动增强',
    auto: '自动增强：先在本地识别，低于 82% 时再用视觉模型校正',
    ai: 'GPT 精确识别：本地结果立即可看，随后由视觉模型逐字校正',
  };
  $('#ocr-mode-note').textContent = descriptions[mode] || descriptions.local;
  $('#ocr-ready-label').textContent = mode === 'local' ? '本地识别已就绪' : mode === 'auto' ? '混合识别已就绪' : 'GPT 精确识别已就绪';
  $('#ocr-ready-note').textContent = mode === 'local' ? '图片默认不留存' : '需要增强时才发送到视觉服务';
}

function renderAssistantSettingsStatus() {
  const enabled = $('#setting-assistant-enabled').checked;
  const sideLabel = $('#setting-assistant-side').value === 'left' ? '左侧' : '右侧';
  $('#assistant-settings-status').textContent = enabled
    ? `萌宠正在屏幕${sideLabel}待命`
    : '萌宠当前已隐藏，可随时恢复';
  $('#restore-assistant').textContent = enabled ? '立即恢复萌宠' : '显示萌宠';
}

function readSettingsDraft() {
  return {
    provider: $('#setting-provider').value,
    endpoint: $('#setting-endpoint').value.trim(),
    model: $('#setting-model').value.trim(),
    apiKey: $('#setting-api-key').value,
    targetLanguage: $('#setting-target').value,
    ocrMode: $('#setting-ocr-mode').value,
    launchAtLogin: $('#setting-login').checked,
    assistantEnabled: $('#setting-assistant-enabled').checked,
    assistantSide: $('#setting-assistant-side').value,
    visionProvider: $('#setting-vision-provider').value,
    visionEndpoint: $('#setting-vision-endpoint').value.trim(),
    visionModel: $('#setting-vision-model').value.trim(),
    visionApiKey: $('#setting-vision-api-key').value,
    generationEndpoint: $('#setting-generation-endpoint').value.trim(),
    generationModel: $('#setting-generation-model').value.trim(),
    generationApiKey: $('#setting-generation-api-key').value,
    shortcuts: readShortcutDraft(),
  };
}

function refreshSettingsDirtyState() {
  if (!state.settingsBaseline) return;
  const dirty = JSON.stringify(readSettingsDraft()) !== JSON.stringify(state.settingsBaseline);
  const shortcutsValid = validateShortcutDraft();
  $('#settings-save-bar').classList.toggle('is-dirty', dirty);
  $('#settings-note').textContent = shortcutsValid ? (dirty ? '有未保存的更改' : '所有设置已保存') : '快捷键存在冲突';
  $('#settings-save-bar button[type="submit"]').disabled = !dirty || !shortcutsValid || Boolean(activeShortcutRecorder);
}

async function testVisionService() {
  const button = $('#test-vision-service');
  button.disabled = true;
  button.textContent = '检测中…';
  const draft = readSettingsDraft();
  renderVisionServiceStatus({ phase: 'checking', model: draft.visionModel, endpoint: draft.visionEndpoint });
  try {
    const result = await bridge.checkVisionService({
      endpoint: draft.visionEndpoint,
      apiKey: draft.visionApiKey,
    });
    if (!draft.visionModel) {
      renderVisionServiceStatus({
        phase: 'models',
        endpoint: draft.visionEndpoint,
        models: result.models,
      });
      toast(result.models?.length ? '服务已连接，请选择视觉模型' : '服务已连接，请填写视觉模型名称');
      return;
    }
    state.settings = await bridge.saveSettings({
      visionProvider: draft.visionProvider,
      visionEndpoint: draft.visionEndpoint,
      visionModel: draft.visionModel,
      visionApiKey: draft.visionApiKey,
    });
    $('#setting-vision-api-key').value = '';
    $('#vision-key-status').textContent = state.settings.hasVisionApiKey ? '· 已安全保存' : '';
    state.settingsBaseline = state.settingsBaseline || readSettingsDraft();
    state.settingsBaseline.visionProvider = draft.visionProvider;
    state.settingsBaseline.visionEndpoint = draft.visionEndpoint;
    state.settingsBaseline.visionModel = draft.visionModel;
    state.settingsBaseline.visionApiKey = '';
    renderVisionServiceStatus({
      phase: 'connected',
      model: draft.visionModel,
      endpoint: draft.visionEndpoint,
      models: result.models,
    });
    refreshSettingsDirtyState();
    toast('视觉服务已连接并保存');
  } catch (error) {
    renderVisionServiceStatus({
      phase: 'error',
      model: draft.visionModel,
      endpoint: draft.visionEndpoint,
      error: `连接失败 · ${error.message}`,
    });
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '检测并保存';
  }
}

async function reuseVisionForTranslation() {
  const button = $('#reuse-vision-translation');
  button.disabled = true;
  button.textContent = '正在复用…';
  try {
    const draft = readSettingsDraft();
    if (!draft.visionEndpoint || !draft.visionModel) throw new Error('请先配置视觉模型接口和模型名称。');
    state.settings = await bridge.saveSettings({
      ...draft,
      provider: draft.visionProvider === 'cun' ? 'cun' : 'openai',
      endpoint: draft.visionEndpoint,
      model: draft.visionModel,
      reuseVisionApiKey: true,
    });
    populateSettings();
    $('#manual-provider').textContent = translationProviderLabel();
    toast(`翻译已切换为 ${state.settings.model}`);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    toggleVisionProviderFields();
  }
}

async function saveSettings(event) {
  event.preventDefault();
  await stopShortcutRecording();
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  try {
    shortcutSaveError = '';
    state.settings = await bridge.saveSettings({
      provider: $('#setting-provider').value,
      endpoint: $('#setting-endpoint').value.trim(),
      model: $('#setting-model').value.trim(),
      targetLanguage: $('#setting-target').value,
      ocrMode: $('#setting-ocr-mode').value,
      launchAtLogin: $('#setting-login').checked,
      assistantEnabled: $('#setting-assistant-enabled').checked,
      assistantSide: $('#setting-assistant-side').value,
      apiKey: $('#setting-api-key').value,
      visionProvider: $('#setting-vision-provider').value,
      visionEndpoint: $('#setting-vision-endpoint').value.trim(),
      visionModel: $('#setting-vision-model').value.trim(),
      visionApiKey: $('#setting-vision-api-key').value,
      generationEndpoint: $('#setting-generation-endpoint').value.trim(),
      generationModel: $('#setting-generation-model').value.trim(),
      generationApiKey: $('#setting-generation-api-key').value,
      shortcuts: readShortcutDraft(),
    });
    $('#manual-target').value = state.settings.targetLanguage || 'zh-CN';
    $('#manual-provider').textContent = translationProviderLabel();
    populateSettings();
    $('#settings-note').textContent = '刚刚已保存';
    toast('设置已保存');
  } catch (error) {
    shortcutSaveError = error.message;
    validateShortcutDraft();
    toast(error.message, 'error');
  } finally {
    submit.disabled = false;
    refreshSettingsDirtyState();
  }
}

async function restoreAssistant() {
  const button = $('#restore-assistant');
  button.disabled = true;
  try {
    const previousSide = state.settings.assistantSide === 'left' ? 'left' : 'right';
    const nextSide = $('#setting-assistant-side').value;
    state.settings = await bridge.assistantShow({ side: $('#setting-assistant-side').value });
    $('#setting-assistant-enabled').checked = true;
    $('#setting-assistant-side').value = state.settings.assistantSide === 'left' ? 'left' : 'right';
    if (state.settingsBaseline) {
      state.settingsBaseline.assistantEnabled = true;
      state.settingsBaseline.assistantSide = $('#setting-assistant-side').value;
    }
    renderAssistantSettingsStatus();
    refreshSettingsDirtyState();
    toast('萌宠已恢复并缩回屏幕侧边');
    if (previousSide !== nextSide) setTimeout(() => window.focus(), 260);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function translateManual() {
  const text = $('#manual-source').value.trim();
  if (!text) {
    toast('先输入要翻译的文字', 'error');
    $('#manual-source').focus();
    return;
  }
  const button = $('#translate-manual');
  const result = $('#manual-result');
  button.disabled = true;
  button.textContent = '翻译中…';
  result.classList.add('is-loading');
  result.textContent = '正在连接翻译服务…';
  try {
    const job = await bridge.translateText({ text, targetLanguage: $('#manual-target').value || state.settings.targetLanguage });
    result.classList.remove('is-loading');
    result.textContent = job.translation.text;
    $('#manual-provider').textContent = `${job.translation.provider} · ${job.translation.latency} ms`;
    addHistoryLocally(job);
    renderRecent();
  } catch (error) {
    result.classList.remove('is-loading');
    result.textContent = `翻译失败：${error.message}`;
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = '翻译 <span>→</span>';
  }
}

function resetManualImage({ clearResult = false } = {}) {
  manualImageSequence += 1;
  $('#manual-image-preview').hidden = true;
  $('#manual-image-thumbnail').removeAttribute('src');
  $('#manual-image-status').textContent = '正在识别图片文字…';
  $('#manual-source').readOnly = false;
  $('#manual-paste-image').disabled = false;
  if (clearResult) $('#manual-result').innerHTML = '<span>译文会出现在这里。</span>';
}

async function translateManualImage(dataUrl) {
  if (!dataUrl) return toast('剪贴板里没有图片', 'error');
  const sequence = ++manualImageSequence;
  const source = $('#manual-source');
  const result = $('#manual-result');
  const pasteButton = $('#manual-paste-image');
  $('#manual-image-preview').hidden = false;
  $('#manual-image-thumbnail').src = dataUrl;
  $('#manual-image-status').textContent = '正在识别并翻译图片…';
  source.value = '';
  source.readOnly = true;
  $('#source-char-count').textContent = '0 / 8000';
  pasteButton.disabled = true;
  result.classList.add('is-loading');
  result.textContent = '正在识别图片中的文字…';
  try {
    const job = await bridge.translateImage({
      dataUrl,
      targetLanguage: $('#manual-target').value || state.settings.targetLanguage,
    });
    if (sequence !== manualImageSequence) return;
    source.value = job.ocr.text.slice(0, 8000);
    $('#source-char-count').textContent = `${source.value.length} / 8000`;
    result.classList.remove('is-loading');
    result.textContent = job.translation.text;
    $('#manual-image-status').textContent = `图片文字已识别 · ${Math.round(job.ocr.confidence || 0)}%`;
    $('#manual-provider').textContent = `${job.translation.provider} · ${job.translation.latency} ms`;
    addHistoryLocally(job);
    renderRecent();
    toast('图片文字已识别并翻译');
  } catch (error) {
    if (sequence !== manualImageSequence) return;
    result.classList.remove('is-loading');
    result.textContent = `图片翻译失败：${error.message}`;
    $('#manual-image-status').textContent = '图片识别失败';
    toast(error.message, 'error');
  } finally {
    if (sequence === manualImageSequence) {
      source.readOnly = false;
      pasteButton.disabled = false;
    }
  }
}

async function pasteManualImageFromClipboard() {
  try {
    await translateManualImage(await bridge.getClipboardImage());
  } catch (error) {
    toast(error.message, 'error');
  }
}

function bindEvents() {
  $$('[data-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
  $$('[data-window-action]').forEach((button) => button.addEventListener('click', () => bridge.windowControl(button.dataset.windowAction)));
  $$('[data-capture]').forEach((button) => button.addEventListener('click', () => beginCapture(button.dataset.capture)));
  $('#choose-image').addEventListener('click', () => chooseImage('translate'));
  $('#choose-image-ocr').addEventListener('click', () => chooseImage('ocr'));
  $('#choose-image-prompt').addEventListener('click', () => chooseImage('prompt'));
  $('#paste-image').addEventListener('click', async () => {
    const image = await bridge.getClipboardImage();
    if (!image) return toast('剪贴板里没有图片', 'error');
    processDataUrl(image, 'translate');
  });
  $('#close-result').addEventListener('click', () => { $('#result-panel').hidden = true; });
  $('#source-text').addEventListener('click', beginSourceEdit);
  $('#edit-source-text').addEventListener('click', saveSourceCorrection);
  $('#cancel-source-edit').addEventListener('click', cancelSourceEdit);
  $('#source-text').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('#source-text').classList.contains('is-editing')) {
      event.preventDefault();
      cancelSourceEdit();
    }
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && $('#source-text').classList.contains('is-editing')) {
      event.preventDefault();
      saveSourceCorrection();
    }
  });
  $('#toggle-boxes').addEventListener('click', () => {
    state.boxesVisible = !state.boxesVisible;
    $('#ocr-box-layer').classList.toggle('is-visible', state.boxesVisible);
    $('#toggle-boxes').classList.toggle('is-active', state.boxesVisible);
  });
  $('#copy-all').addEventListener('click', () => {
    const job = state.currentJob;
    if (!job?.ocr) return;
    bridge.copyText(job.translation?.text || job.ocr.text);
    toast('结果已复制');
  });
  $$('.text-copy[data-copy-target]').forEach((button) => button.addEventListener('click', () => copyElementText(button.dataset.copyTarget)));
  $('#result-image').addEventListener('load', renderOcrBoxes);
  window.addEventListener('resize', renderOcrBoxes);

  $('#recent-grid').addEventListener('click', (event) => {
    const card = event.target.closest('[data-history-id]');
    if (card) openHistoryItem(card.dataset.historyId);
  });
  $('#history-list').addEventListener('click', async (event) => {
    const deleteButton = event.target.closest('[data-delete-history]');
    if (deleteButton) {
      event.stopPropagation();
      state.history = await bridge.deleteHistory(deleteButton.dataset.deleteHistory);
      updateHistoryCount();
      renderHistory();
      renderRecent();
      toast('记录已删除');
      return;
    }
    const item = event.target.closest('[data-history-id]');
    if (item) openHistoryItem(item.dataset.historyId);
  });
  $('#history-search').addEventListener('input', (event) => {
    state.historyQuery = event.target.value;
    renderHistory();
  });
  $('#history-filter').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.historyFilter = button.dataset.filter;
    $$('#history-filter button').forEach((candidate) => candidate.classList.toggle('is-active', candidate === button));
    renderHistory();
  });
  $('#clear-history').addEventListener('click', async () => {
    if (!state.history.length || !confirm('清空所有文字历史记录？这个操作无法撤销。')) return;
    state.history = await bridge.clearHistory();
    updateHistoryCount();
    renderHistory();
    renderRecent();
    toast('历史记录已清空');
  });

  $('#manual-source').addEventListener('input', (event) => { $('#source-char-count').textContent = `${event.target.value.length} / 8000`; });
  $('#manual-paste-image').addEventListener('click', pasteManualImageFromClipboard);
  $('#remove-manual-image').addEventListener('click', () => resetManualImage());
  $('#manual-target').addEventListener('change', () => {
    if ($('#manual-source').value.trim()) $('#manual-result').innerHTML = '<span>目标语言已切换，点击“翻译”更新译文。</span>';
  });
  $('#clear-manual').addEventListener('click', () => {
    resetManualImage();
    $('#manual-source').value = '';
    $('#source-char-count').textContent = '0 / 8000';
    $('#manual-result').innerHTML = '<span>译文会出现在这里。</span>';
  });
  $('#translate-manual').addEventListener('click', translateManual);
  $('#manual-source').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') translateManual();
  });

  $('#setting-provider').addEventListener('change', () => toggleProviderFields({ applyPreset: true }));
  $('#setting-vision-provider').addEventListener('change', () => toggleVisionProviderFields({ applyPreset: true }));
  $$('[data-cun-model-target]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.cunModelTarget);
      input.value = button.dataset.cunModel;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    });
  });
  $('#setting-ocr-mode').addEventListener('change', updateOcrModeUi);
  $('#setting-assistant-enabled').addEventListener('change', renderAssistantSettingsStatus);
  $('#setting-assistant-side').addEventListener('change', renderAssistantSettingsStatus);
  $('#restore-assistant').addEventListener('click', restoreAssistant);
  $('#reuse-vision-translation').addEventListener('click', reuseVisionForTranslation);
  $('#test-vision-service').addEventListener('click', testVisionService);
  $$('[data-shortcut-input]').forEach((button) => {
    button.addEventListener('click', () => {
      if (activeShortcutRecorder !== button) startShortcutRecording(button);
    });
    button.addEventListener('keydown', async (event) => {
      if (activeShortcutRecorder !== button) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        await stopShortcutRecording(button);
        validateShortcutDraft();
        refreshSettingsDirtyState();
        return;
      }
      try {
        const accelerator = acceleratorFromKeyboardEvent(event);
        if (!accelerator) return;
        shortcutSaveError = '';
        button.dataset.shortcut = accelerator;
        await stopShortcutRecording(button);
        const row = button.closest('[data-shortcut-row]');
        row.classList.remove('is-unavailable');
        $('.shortcut-status', row).textContent = '待保存';
        validateShortcutDraft();
        refreshSettingsDirtyState();
      } catch (error) {
        shortcutSaveError = error.message;
        validateShortcutDraft();
      }
    });
    button.addEventListener('blur', () => {
      if (activeShortcutRecorder === button) setTimeout(() => stopShortcutRecording(button), 0);
    });
  });
  $('#reset-shortcuts').addEventListener('click', async () => {
    await stopShortcutRecording();
    shortcutSaveError = '';
    $$('[data-shortcut-input]').forEach((button) => {
      button.dataset.shortcut = DEFAULT_SHORTCUTS[button.dataset.shortcutInput];
      renderShortcutButton(button);
      const row = button.closest('[data-shortcut-row]');
      row.classList.remove('is-unavailable');
      $('.shortcut-status', row).textContent = '待保存';
    });
    validateShortcutDraft();
    refreshSettingsDirtyState();
  });
  $('#settings-form').addEventListener('input', refreshSettingsDirtyState);
  $('#settings-form').addEventListener('change', refreshSettingsDirtyState);
  $('#settings-form').addEventListener('submit', saveSettings);
  window.addEventListener('blur', () => stopShortcutRecording());

  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    $('#drop-overlay').classList.add('is-visible');
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('dragleave', (event) => {
    event.preventDefault();
    dragDepth -= 1;
    if (dragDepth <= 0) $('#drop-overlay').classList.remove('is-visible');
  });
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').classList.remove('is-visible');
    try {
      const dataUrl = await readFileAsDataUrl(event.dataTransfer.files[0]);
      if ($('#view-text').classList.contains('is-active')) await translateManualImage(dataUrl);
      else processDataUrl(dataUrl, 'translate');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  window.addEventListener('paste', async (event) => {
    const item = Array.from(event.clipboardData?.items || []).find((candidate) => candidate.type.startsWith('image/'));
    if (!item) return;
    if ($('#view-text').classList.contains('is-active')) {
      event.preventDefault();
      await translateManualImage(await readFileAsDataUrl(item.getAsFile()));
      return;
    }
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const dataUrl = await readFileAsDataUrl(item.getAsFile());
    processDataUrl(dataUrl, 'translate');
  });
}

async function initialize() {
  if (!bridge) {
  document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">请从 Electron 启动 Luvoelle。</div>';
    return;
  }
  const bootstrap = await bridge.bootstrap();
  state.platform = bootstrap.platform || 'win32';
  document.documentElement.dataset.platform = state.platform;
  state.settings = bootstrap.settings;
  state.history = bootstrap.history;
  updateHistoryCount();
  renderRecent();
  renderHistory();
  populateSettings();
  $('#manual-target').value = state.settings.targetLanguage || 'zh-CN';
  $('#manual-provider').textContent = translationProviderLabel();
  bindEvents();
  bridge.onJobEvent(handleJobEvent);
  bridge.onNavigate(navigate);
  bridge.onHistoryUpdated((history) => {
    state.history = history;
    updateHistoryCount();
    renderRecent();
    if ($('#view-history').classList.contains('is-active')) renderHistory();
  });
}

initialize().catch((error) => toast(`启动失败：${error.message}`, 'error'));
