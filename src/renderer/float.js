let currentJob;
let pinState = true;
let floatSizeMode = 'normal';
let editSnapshot = '';
const shell = document.querySelector('.float-shell');
const sourcePane = document.querySelector('.source-pane');
const translationPane = document.getElementById('float-translation-pane');

function updateCollapseButton(pane, button, label) {
  const expanded = !pane.classList.contains('is-collapsed');
  button.setAttribute('aria-expanded', String(expanded));
  button.title = `${expanded ? '折叠' : '展开'}${label}`;
  button.setAttribute('aria-label', button.title);
}

function resetPaneCollapse() {
  sourcePane.classList.remove('is-collapsed');
  translationPane.classList.remove('is-collapsed');
  updateCollapseButton(sourcePane, document.getElementById('collapse-source'), '原文');
  updateCollapseButton(translationPane, document.getElementById('collapse-translation'), '译文');
}

function togglePaneCollapse(targetPane, otherPane, button, label) {
  if (shell.classList.contains('compact-result')) return;
  const willCollapse = !targetPane.classList.contains('is-collapsed');
  if (willCollapse) {
    if (targetPane === sourcePane && document.getElementById('float-source').classList.contains('is-editing')) cancelEditMode();
    otherPane.classList.remove('is-collapsed');
  }
  targetPane.classList.toggle('is-collapsed', willCollapse);
  updateCollapseButton(targetPane, button, label);
  const otherButton = otherPane === sourcePane ? document.getElementById('collapse-source') : document.getElementById('collapse-translation');
  updateCollapseButton(otherPane, otherButton, otherPane === sourcePane ? '原文' : '译文');
}

function statusLabel(stage) {
  return ({
    'paddle-ocr': '正在提取文字',
    'paddle-refine': '正在增强小字与符号',
    'tesseract-fallback': '正在切换兼容识别引擎',
    'loading tesseract core': '正在启动本地引擎',
    'initializing tesseract': '正在初始化 OCR',
    'loading language traineddata': '正在载入识别模型',
    'initializing api': '正在准备识别',
    'recognizing text': '正在提取文字',
    'ai-ocr': '本地文字已提取，正在用 GPT 校正',
    translating: '正在翻译',
  })[stage] || '正在理解画面';
}

function ocrProviderLabel(ocr) {
  return String(ocr?.provider || 'PP-OCRv6 small 本地 OCR');
}

function ocrMetaLabel(ocr, { preview = false, chinese = false, corrected = false } = {}) {
  const parts = [];
  if (chinese) parts.push('中文内容');
  if (preview) parts.push('当前识别结果可先查看');
  else if (Number(ocr?.confidence || 0) > 0) parts.push(`识别置信度 ${Math.round(ocr.confidence)}%`);
  if (ocr?.localRefined) parts.push('小字增强');
  if (corrected || ocr?.corrected) parts.push('已校正');
  return parts.join(' · ') || '识别完成';
}

function updateFloatSizeButton(mode) {
  floatSizeMode = mode || 'normal';
  const button = document.getElementById('resize-float');
  const maximized = floatSizeMode === 'maximized';
  const label = maximized ? '恢复适度大小' : floatSizeMode === 'moderate' ? '最大化窗口' : '适度放大';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.classList.toggle('is-active', floatSizeMode !== 'normal');
  document.body.classList.toggle('window-maximized', maximized);
  document.getElementById('resize-float-icon').setAttribute('d', maximized
    ? 'M9 9H4V4m11 5h5V4M9 15H4v5m11-5h5v5'
    : 'M9 4H4v5m11-5h5v5M9 20H4v-5m11 5h5v-5');
}

function setTranslationModel(translation, pendingLabel = '') {
  const badge = document.getElementById('translation-model');
  const provider = String(translation?.provider || '').trim();
  const model = provider.split(' · ')[0] || pendingLabel;
  badge.hidden = !model;
  badge.classList.toggle('is-pending', !provider && Boolean(model));
  badge.textContent = model;
  badge.title = provider ? `翻译模型：${provider}` : model;
}

function applyJobMode(job) {
  const isOcr = job.mode === 'ocr';
  const compactTextMode = isOcr || Boolean(job.translationSkipped);
  shell.classList.toggle('compact-result', compactTextMode);
  document.getElementById('mode-label').textContent = isOcr ? '截图取字' : job.translationSkipped ? '中文取字' : '截图翻译';
  document.getElementById('float-translation-pane').hidden = compactTextMode;
  if (compactTextMode) resetPaneCollapse();
}

function setTranslationAction(mode) {
  const copyButton = document.getElementById('copy-translation');
  const retryButton = document.getElementById('retry-translation');
  copyButton.hidden = mode !== 'copy';
  retryButton.hidden = mode !== 'retry';
  copyButton.disabled = false;
  retryButton.disabled = false;
}

function setClipboardStatus(status) {
  document.querySelector('#clipboard-status > span').textContent = status;
}

function updateImageEditorButton(job, visible = true) {
  document.getElementById('edit-image').hidden = !visible || !job?.image;
  document.getElementById('copy-image-footer').hidden = !job?.image;
}

function setLoading(job) {
  exitEditMode();
  resetPaneCollapse();
  currentJob = job;
  shell.classList.remove('complete', 'failed');
  applyJobMode(job);
  setClipboardStatus(job.imageCopied ? '截图已复制' : '截图未复制');
  updateImageEditorButton(job, false);
  setTranslationAction('hidden');
  setTranslationModel(null);
  updateFloatSizeButton('normal');
  document.getElementById('float-status').textContent = '正在理解画面';
  document.getElementById('float-progress-bar').style.width = '4%';
  document.getElementById('float-progress-bar').style.background = '';
  document.getElementById('float-source').className = 'float-text loading';
  document.getElementById('float-source').innerHTML = '<i></i><i></i><i class="short"></i>';
  document.getElementById('float-translation').className = 'float-text loading translated';
  document.getElementById('float-translation').innerHTML = '<i></i><i class="short"></i><i></i>';
}

function showToast(message) {
  const toast = document.getElementById('float-toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  setTimeout(() => toast.classList.remove('is-visible'), 1300);
}

function exitEditMode() {
  const source = document.getElementById('float-source');
  if (!source) return;
  source.contentEditable = 'false';
  source.classList.remove('is-editing');
  const editButton = document.getElementById('float-edit-source');
  const cancelButton = document.getElementById('float-cancel-edit');
  if (editButton) {
    editButton.disabled = false;
    editButton.textContent = '保存并重译';
    editButton.hidden = true;
  }
  if (cancelButton) cancelButton.hidden = true;
  editSnapshot = '';
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

function beginEditMode(event) {
  const source = document.getElementById('float-source');
  if (!currentJob?.ocr || source.classList.contains('loading') || source.classList.contains('is-editing')) return;
  if (currentJob.ocrEnhancing) return showToast('GPT 校正完成后即可修改原文');
  editSnapshot = source.textContent;
  source.contentEditable = 'true';
  source.spellcheck = true;
  source.classList.add('is-editing');
  document.getElementById('float-cancel-edit').hidden = false;
  document.getElementById('float-edit-source').hidden = false;
  document.getElementById('float-edit-source').textContent = currentJob.mode === 'ocr' || currentJob.translationSkipped ? '保存修改' : '保存并重译';
  source.focus();
  placeCaretAtPointer(source, event);
}

function cancelEditMode() {
  if (editSnapshot) document.getElementById('float-source').textContent = editSnapshot;
  exitEditMode();
}

async function saveCorrection() {
  const source = document.getElementById('float-source');
  const button = document.getElementById('float-edit-source');
  const text = source.innerText.replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return showToast('原文不能为空');
  if (text === editSnapshot.trim()) {
    exitEditMode();
    return showToast('原文没有变化');
  }
  source.contentEditable = 'false';
  source.classList.remove('is-editing');
  button.disabled = true;
  button.textContent = currentJob.mode === 'ocr' || currentJob.translationSkipped ? '保存中…' : '重译中…';
  try {
  await window.luvoelle.applyCorrection({
      id: currentJob.id,
      text,
      mode: currentJob.mode,
      origin: currentJob.origin,
      createdAt: currentJob.createdAt,
      confidence: currentJob.ocr.confidence,
      ocrProvider: ocrProviderLabel(currentJob.ocr),
      ocrEnhanced: Boolean(currentJob.ocr.enhanced),
      detectedLanguage: currentJob.ocr.detectedLanguage,
      targetLanguage: currentJob.translation?.targetLanguage,
    });
  } catch (error) {
    button.disabled = false;
    button.textContent = currentJob.mode === 'ocr' || currentJob.translationSkipped ? '保存修改' : '保存并重译';
    source.contentEditable = 'true';
    source.classList.add('is-editing');
    source.focus();
    showToast(error.message);
  }
}

window.luvoelle.onJobEvent((event) => {
  if (event.type === 'started') setLoading(event.job);
  if (event.type === 'progress') {
    document.getElementById('float-progress-bar').style.width = `${Math.max(4, event.progress)}%`;
    document.getElementById('float-status').textContent = statusLabel(event.stage);
  }
  if (event.type === 'ocr-preview' || event.type === 'ocr-complete') {
    currentJob = { ...event.job, ocrEnhancing: event.type === 'ocr-preview' };
    applyJobMode(currentJob);
    const source = document.getElementById('float-source');
    source.className = 'float-text';
    source.textContent = event.job.ocr.text;
    setTranslationModel(null, event.job.mode === 'translate' && !event.job.translationSkipped ? '翻译中…' : '');
    document.getElementById('float-meta').textContent = ocrMetaLabel(event.job.ocr, {
      preview: event.type === 'ocr-preview',
      chinese: Boolean(event.job.translationSkipped),
    });
    document.getElementById('float-status').textContent = event.type === 'ocr-preview' ? '本地文字已提取，GPT 校正中' : event.job.mode === 'ocr' ? '文字已提取' : event.job.translationSkipped ? '中文识别完成' : '文字已提取，正在翻译';
    updateImageEditorButton(currentJob);
  }
  if (event.type === 'completed') {
    currentJob = event.job;
    applyJobMode(event.job);
    updateImageEditorButton(currentJob);
    shell.classList.add('complete');
    shell.classList.remove('failed');
    document.getElementById('float-progress-bar').style.background = '';
    document.getElementById('float-progress-bar').style.width = '100%';
    document.getElementById('float-status').textContent = event.job.mode === 'ocr' ? '已提取并复制' : event.job.translationSkipped ? '中文识别完成' : '翻译完成';
    document.getElementById('float-meta').textContent = ocrMetaLabel(event.job.ocr, {
      chinese: Boolean(event.job.translationSkipped),
    });
    setTranslationModel(event.job.translation);
    const source = document.getElementById('float-source');
    source.className = 'float-text';
    source.textContent = event.job.ocr.text;
    if (event.job.translation) {
      const translated = document.getElementById('float-translation');
      translated.className = 'float-text translated';
      translated.textContent = event.job.translation.text;
      setTranslationAction('copy');
    }
    if (event.autoCopied) {
      setClipboardStatus('原文已复制');
      showToast('原文已自动复制');
    }
  }
  if (event.type === 'correction-started' && currentJob?.id === event.jobId) {
    document.getElementById('float-status').textContent = event.mode === 'ocr' || event.translationSkipped ? '正在保存修正' : '正在按修正原文重新翻译';
    document.getElementById('float-progress-bar').style.width = '92%';
  }
  if (event.type === 'corrected') {
    currentJob = { ...event.job, image: currentJob?.image || '', imageCopied: Boolean(currentJob?.imageCopied) };
    applyJobMode(currentJob);
    updateImageEditorButton(currentJob);
    exitEditMode();
    shell.classList.add('complete');
    shell.classList.remove('failed');
    document.getElementById('float-progress-bar').style.width = '100%';
    document.getElementById('float-status').textContent = currentJob.mode === 'ocr' ? '修正已保存并复制' : currentJob.translationSkipped ? '中文原文已保存' : '已按修正原文重新翻译';
    document.getElementById('float-meta').textContent = ocrMetaLabel(currentJob.ocr, {
      chinese: Boolean(currentJob.translationSkipped),
      corrected: true,
    });
    setTranslationModel(currentJob.translation);
    const source = document.getElementById('float-source');
    source.className = 'float-text';
    source.textContent = currentJob.ocr.text;
    if (currentJob.translation) {
      const translated = document.getElementById('float-translation');
      translated.className = 'float-text translated';
      translated.textContent = currentJob.translation.text;
      setTranslationAction('copy');
    }
    if (event.autoCopied) setClipboardStatus('原文已复制');
    showToast(currentJob.mode === 'ocr' ? '修正已保存并重新复制' : currentJob.translationSkipped ? '中文原文已保存' : '已重新翻译');
  }
  if (event.type === 'failed') {
    shell.classList.add('failed');
    document.getElementById('float-progress-bar').style.width = '100%';
    document.getElementById('float-progress-bar').style.background = '#e14848';
    document.getElementById('float-status').textContent = '这次没有完成';
    const target = document.getElementById('float-translation-pane').hidden ? document.getElementById('float-source') : document.getElementById('float-translation');
    target.className = target.id === 'float-translation' ? 'float-text translated' : 'float-text';
    target.textContent = event.message;
    if (!document.getElementById('float-translation-pane').hidden && currentJob?.ocr?.text) setTranslationAction('retry');
    updateImageEditorButton(currentJob);
  }
});

async function copyText(text, status) {
  if (!text) return;
  await window.luvoelle.copyText(text);
  setClipboardStatus(status);
  showToast(status);
}

document.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', () => {
  const text = document.getElementById(button.dataset.copy).textContent.trim();
  copyText(text, button.dataset.copyStatus);
}));
document.getElementById('copy-image-footer').addEventListener('click', async () => {
  if (!currentJob?.image) return;
  const copied = await window.luvoelle.copyImage(currentJob.image);
  if (copied) {
    setClipboardStatus('截图已复制');
    showToast('截图已复制');
  } else showToast('剪贴板被占用，请重试');
});
document.getElementById('retry-translation').addEventListener('click', async (event) => {
  if (!currentJob?.ocr?.text) return;
  const button = event.currentTarget;
  button.disabled = true;
  shell.classList.remove('failed');
  document.getElementById('float-status').textContent = '正在重试翻译';
  document.getElementById('float-progress-bar').style.width = '38%';
  document.getElementById('float-progress-bar').style.background = '';
  try {
  await window.luvoelle.retryTranslation(currentJob);
  } catch (error) {
    button.disabled = false;
    document.getElementById('float-status').textContent = '翻译仍未完成';
    showToast(error.message || '重试失败，请检查网络');
  }
});
document.getElementById('edit-image').addEventListener('click', async () => {
  if (!currentJob?.image) return;
  const button = document.getElementById('edit-image');
  button.disabled = true;
  try {
  await window.luvoelle.openImageEditor({ dataUrl: currentJob.image, id: currentJob.id });
  } catch (error) {
    showToast(error.message || '无法打开图片编辑器');
  } finally {
    button.disabled = false;
  }
});
document.getElementById('float-source').addEventListener('click', beginEditMode);
document.getElementById('float-edit-source').addEventListener('click', saveCorrection);
document.getElementById('float-cancel-edit').addEventListener('click', cancelEditMode);
document.getElementById('collapse-source').addEventListener('click', (event) => {
  event.stopPropagation();
  togglePaneCollapse(sourcePane, translationPane, event.currentTarget, '原文');
});
document.getElementById('collapse-translation').addEventListener('click', (event) => {
  event.stopPropagation();
  togglePaneCollapse(translationPane, sourcePane, event.currentTarget, '译文');
});
[sourcePane, translationPane].forEach((pane) => {
  pane.querySelector(':scope > header').addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    const isSource = pane === sourcePane;
    togglePaneCollapse(
      pane,
      isSource ? translationPane : sourcePane,
      document.getElementById(isSource ? 'collapse-source' : 'collapse-translation'),
      isSource ? '原文' : '译文',
    );
  });
});
document.getElementById('float-source').addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && event.currentTarget.classList.contains('is-editing')) {
    event.preventDefault();
    event.stopPropagation();
    cancelEditMode();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && event.currentTarget.classList.contains('is-editing')) {
    event.preventDefault();
    saveCorrection();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();

  const source = document.getElementById('float-source');
  if (source.classList.contains('is-editing')) {
    cancelEditMode();
    return;
  }
    window.luvoelle.floatAction('close');
});
document.getElementById('close-float').addEventListener('click', () => window.luvoelle.floatAction('close'));
document.getElementById('open-main').addEventListener('click', () => window.luvoelle.floatAction('open-main'));
document.getElementById('resize-float').addEventListener('click', async () => {
  const result = await window.luvoelle.floatAction('resize');
  if (result?.mode) updateFloatSizeButton(result.mode);
});
document.getElementById('pin-float').addEventListener('click', async () => {
  pinState = await window.luvoelle.floatAction('pin');
  document.getElementById('pin-float').classList.toggle('is-active', pinState);
  showToast(pinState ? '窗口已固定' : '已取消固定');
});
