const bridge = window.luvoelle;
const $ = (selector) => document.querySelector(selector);
const languageLabels = { 'zh-CN': '中文', en: '英语', vi: '越南语', th: '泰语' };
const assistantState = {
  expanded: false,
  busy: false,
  activePane: 'left',
  imageJobs: { left: 0, right: 0 },
};
let toastTimer;
let feedbackTimer;
let petPointerDownAt = 0;

function playPetFeedback(type) {
  clearTimeout(feedbackTimer);
  document.body.classList.remove('is-success', 'is-error');
  // Restart short feedback animations even when two operations finish quickly.
  void document.body.offsetWidth;
  document.body.classList.add(type === 'error' ? 'is-error' : 'is-success');
  feedbackTimer = setTimeout(() => {
    document.body.classList.remove('is-success', 'is-error');
  }, type === 'error' ? 520 : 980);
}

function persistDraft() {
  localStorage.setItem('luvoelle-assistant-draft', JSON.stringify({
    leftLanguage: $('#left-language').value,
    rightLanguage: $('#right-language').value,
    leftText: $('#left-text').value,
    rightText: $('#right-text').value,
  }));
}

function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem('luvoelle-assistant-draft') || '{}');
    if (languageLabels[draft.leftLanguage]) $('#left-language').value = draft.leftLanguage;
    if (languageLabels[draft.rightLanguage]) $('#right-language').value = draft.rightLanguage;
    $('#left-text').value = String(draft.leftText || '').slice(0, 8000);
    $('#right-text').value = String(draft.rightText || '').slice(0, 8000);
  } catch { /* invalid drafts are ignored */ }
  updateLabels();
  updateCounts();
}

function updateLabels() {
  $('#left-label').textContent = languageLabels[$('#left-language').value];
  $('#right-label').textContent = languageLabels[$('#right-language').value];
}

function updateCounts() {
  $('#left-count').textContent = `${$('#left-text').value.length} / 8000`;
  $('#right-count').textContent = `${$('#right-text').value.length} / 8000`;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('is-visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('is-visible'), 1900);
}

function readableError(error, fallback) {
  const raw = String(error?.message || fallback || '操作失败');
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '');
}

function setBusy(busy, message = '') {
  assistantState.busy = busy;
  document.body.classList.toggle('is-busy', busy);
  $('#translate-forward').disabled = busy;
  $('#translate-backward').disabled = busy;
  if (message) $('#panel-status').textContent = message;
}

function applyWindowState(value = {}) {
  assistantState.expanded = Boolean(value.expanded);
  document.body.classList.toggle('is-expanded', assistantState.expanded);
  document.body.classList.toggle('is-hovered', Boolean(value.hovered) || assistantState.expanded);
  document.body.dataset.side = value.side === 'left' ? 'left' : 'right';
  if (value.platform) document.body.dataset.platform = value.platform;
  if (assistantState.expanded) setTimeout(() => $(`#${assistantState.activePane}-text`)?.focus(), 120);
}

async function translateDirection(from, to) {
  if (assistantState.busy) return;
  const source = $(`#${from}-text`).value.trim();
  if (!source) return toast(`请先在${from === 'left' ? '左' : '右'}侧输入文字`);
  const fromLanguage = $(`#${from}-language`).value;
  const targetLanguage = $(`#${to}-language`).value;
  if (fromLanguage === targetLanguage) return toast('两侧语言相同，请先切换一种语言');
  setBusy(true, `正在翻译为${languageLabels[targetLanguage]}…`);
  try {
    const translation = await bridge.assistantTranslate({ text: source, sourceLanguage: fromLanguage, targetLanguage });
    $(`#${to}-text`).value = translation.text.slice(0, 8000);
    updateCounts();
    persistDraft();
    $('#panel-status').textContent = `${translation.provider} · ${translation.latency} ms`;
    $('#service-status').textContent = `已翻译为${languageLabels[targetLanguage]}`;
    playPetFeedback('success');
    toast('翻译完成');
  } catch (error) {
    $('#panel-status').textContent = '翻译遇到问题';
    playPetFeedback('error');
    toast(readableError(error, '翻译失败'));
  } finally {
    setBusy(false);
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('无法读取图片'));
    reader.readAsDataURL(file);
  });
}

function removeImage(side) {
  assistantState.imageJobs[side] += 1;
  $(`#${side}-image-chip`).hidden = true;
  $(`#${side}-image`).removeAttribute('src');
}

async function recognizeImage(side, dataUrl, { translateAfter = true } = {}) {
  if (!dataUrl) return toast('剪贴板里没有图片');
  const job = ++assistantState.imageJobs[side];
  const other = side === 'left' ? 'right' : 'left';
  $(`#${side}-image-chip`).hidden = false;
  $(`#${side}-image`).src = dataUrl;
  $(`#${side}-image-status`).textContent = '正在识别图片文字…';
  setBusy(true, '萌宠正在看图识字…');
  try {
    const ocr = await bridge.assistantOcr({ dataUrl });
    if (job !== assistantState.imageJobs[side]) return;
    $(`#${side}-text`).value = ocr.text.slice(0, 8000);
    $(`#${side}-image-status`).textContent = `已识别 · ${Math.round(ocr.confidence || 0)}% · 可继续修改`;
    updateCounts();
    persistDraft();
    setBusy(false, '图片文字已识别');
    if (translateAfter) await translateDirection(side, other);
    else playPetFeedback('success');
  } catch (error) {
    if (job !== assistantState.imageJobs[side]) return;
    $(`#${side}-image-status`).textContent = '图片识别失败';
    setBusy(false, '没有看清这张图片');
    playPetFeedback('error');
    toast(error.message || '图片识别失败');
  }
}

async function pasteImage(side) {
  try { await recognizeImage(side, await bridge.getClipboardImage()); }
  catch (error) { toast(error.message || '读取剪贴板失败'); }
}

function swapLanguagesAndText() {
  const leftLanguage = $('#left-language').value;
  const leftText = $('#left-text').value;
  $('#left-language').value = $('#right-language').value;
  $('#right-language').value = leftLanguage;
  $('#left-text').value = $('#right-text').value;
  $('#right-text').value = leftText;
  removeImage('left');
  removeImage('right');
  updateLabels();
  updateCounts();
  persistDraft();
  toast('两侧已交换');
}

function bindPaneDrop(side) {
  const pane = document.querySelector(`[data-pane="${side}"]`);
  pane.addEventListener('dragover', (event) => { event.preventDefault(); pane.classList.add('is-dragging'); });
  pane.addEventListener('dragleave', () => pane.classList.remove('is-dragging'));
  pane.addEventListener('drop', async (event) => {
    event.preventDefault();
    pane.classList.remove('is-dragging');
    const file = Array.from(event.dataTransfer.files || []).find((item) => item.type.startsWith('image/'));
    if (file) await recognizeImage(side, await fileToDataUrl(file));
  });
}

function bindEvents() {
  $('#pet-view').addEventListener('mouseenter', () => bridge.assistantHover(true));
  $('#pet-view').addEventListener('mouseleave', () => bridge.assistantHover(false));
  const openPetPanel = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    // `assistantOpen` is intentionally idempotent. pointerdown gives immediate
    // feedback; click is a second native-event path for Windows devices that
    // suppress a pointer event after the cursor first enters the edge region.
    const now = performance.now();
    if (event.type === 'click' && now - petPointerDownAt < 250) return;
    if (event.type === 'pointerdown') petPointerDownAt = now;
    bridge.assistantOpen();
  };
  $('#pet-button').addEventListener('pointerdown', openPetPanel);
  $('#pet-button').addEventListener('click', openPetPanel);
  $('#collapse-panel').addEventListener('click', () => bridge.assistantCollapse());
  $('#close-panel').addEventListener('click', () => bridge.assistantCollapse());
  $('#open-main').addEventListener('click', () => bridge.openMain());
  $('#swap-languages').addEventListener('click', swapLanguagesAndText);
  $('#translate-forward').addEventListener('click', () => translateDirection('left', 'right'));
  $('#translate-backward').addEventListener('click', () => translateDirection('right', 'left'));
  ['left', 'right'].forEach((side) => {
    const text = $(`#${side}-text`);
    text.addEventListener('focus', () => { assistantState.activePane = side; });
    text.addEventListener('input', () => { updateCounts(); persistDraft(); });
    $(`#${side}-language`).addEventListener('change', () => { updateLabels(); persistDraft(); });
    document.querySelector(`[data-remove-image="${side}"]`).addEventListener('click', () => removeImage(side));
    document.querySelector(`.paste-image[data-side="${side}"]`).addEventListener('click', () => pasteImage(side));
    document.querySelector(`.copy-pane[data-side="${side}"]`).addEventListener('click', async () => {
      const value = text.value.trim();
      if (!value) return toast('这里还没有文字');
      await bridge.copyText(value);
      toast(`${side === 'left' ? '左' : '右'}侧文字已复制`);
    });
    bindPaneDrop(side);
  });
  window.addEventListener('paste', async (event) => {
    const imageItem = Array.from(event.clipboardData?.items || []).find((item) => item.type.startsWith('image/'));
    if (!imageItem || !assistantState.expanded) return;
    event.preventDefault();
    await recognizeImage(assistantState.activePane, await fileToDataUrl(imageItem.getAsFile()));
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && assistantState.expanded) {
      event.preventDefault();
      bridge.assistantCollapse();
    }
    if (event.key === 'Enter' && event.ctrlKey && assistantState.expanded) {
      event.preventDefault();
      translateDirection(assistantState.activePane, assistantState.activePane === 'left' ? 'right' : 'left');
    }
  });
}

async function initialize() {
  const initial = await bridge.assistantBootstrap();
  applyWindowState(initial);
  if (initial.settings?.provider === 'deepseek') {
    $('#service-status').textContent = initial.settings.hasDeepSeekApiKey
      ? 'DeepSeek V4 Flash · 非思考翻译'
      : 'DeepSeek V4 Flash · 请先在工作台设置 API Key';
  }
  restoreDraft();
  bindEvents();
  bridge.onAssistantState(applyWindowState);
}

initialize().catch((error) => { $('#panel-status').textContent = error.message || '萌宠启动失败'; });
