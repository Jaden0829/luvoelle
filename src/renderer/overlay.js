const screenImage = document.getElementById('screen-image');
const selection = document.getElementById('selection');
const selectionImage = document.getElementById('selection-image');
const selectionSize = document.getElementById('selection-size');
const loupe = document.getElementById('loupe');
const processing = document.getElementById('processing');
const inlineEditor = document.getElementById('inline-editor');
let config;
let startPoint;
let isSelecting = false;
let pointerDown = false;
let hoveredWindow = null;
let imageReady = false;
let pendingRect = null;
let inlineEditorReady = false;
let pendingInlineEditor = null;
let selectionCommitted = false;
let pendingInlineCompletion = false;
let overlayPaintToken = 0;
let previewLoadToken = 0;
let previewObjectUrl = '';
let lastPointerPosition = null;
let sortedWindowTargets = [];
let pendingPointerPosition = null;
let pointerFrameRequest = 0;
let interactionMetrics = null;
const DRAG_THRESHOLD = 5;

function createInteractionMetrics(value) {
  return {
    sessionId: Number(value?.sessionId) || 0,
    mode: String(value?.mode || ''),
    pointerEvents: 0,
    renderedFrames: 0,
    coalescedEvents: 0,
    totalFrameMs: 0,
    maxFrameMs: 0,
    reported: false,
  };
}

function reportInteractionMetrics() {
  if (!interactionMetrics || interactionMetrics.reported || !interactionMetrics.pointerEvents) return;
  interactionMetrics.reported = true;
  window.luvoelle.reportOverlayInteraction({
    sessionId: interactionMetrics.sessionId,
    mode: interactionMetrics.mode,
    pointerEvents: interactionMetrics.pointerEvents,
    renderedFrames: interactionMetrics.renderedFrames,
    coalescedEvents: interactionMetrics.coalescedEvents,
    maxFrameMs: Math.round(interactionMetrics.maxFrameMs * 100) / 100,
    averageFrameMs: interactionMetrics.renderedFrames
      ? Math.round((interactionMetrics.totalFrameMs / interactionMetrics.renderedFrames) * 100) / 100
      : 0,
    targetCount: sortedWindowTargets.length,
  });
}

function rebuildWindowTargetIndex() {
  sortedWindowTargets = [...(config?.windowTargets || [])].sort((left, right) => {
    const areaDifference = (left.width * left.height) - (right.width * right.height);
    if (Math.abs(areaDifference) > 1) return areaDifference;
    if (left.source === 'uia' && right.source !== 'uia') return -1;
    if (right.source === 'uia' && left.source !== 'uia') return 1;
    return (Number(left.zIndex) || 0) - (Number(right.zIndex) || 0);
  });
}

function cancelPointerFrame() {
  if (pointerFrameRequest) cancelAnimationFrame(pointerFrameRequest);
  pointerFrameRequest = 0;
  pendingPointerPosition = null;
}

function releasePreviewObjectUrl() {
  if (!previewObjectUrl) return;
  URL.revokeObjectURL(previewObjectUrl);
  previewObjectUrl = '';
}

function previewBytes(value) {
  const bytes = value?.imageBytes;
  if (ArrayBuffer.isView(bytes) || bytes instanceof ArrayBuffer) return bytes;
  if (Array.isArray(bytes?.data)) return new Uint8Array(bytes.data);
  return null;
}

function resetInlineEditor() {
  pendingInlineEditor = null;
  pendingInlineCompletion = false;
  inlineEditor.hidden = true;
  document.body.classList.remove('is-inline-editing');
  delete document.body.dataset.captureQuality;
  delete document.body.dataset.captureBackend;
  try { inlineEditor.contentWindow?.postMessage({ type: 'editor:inline-reset' }, '*'); } catch { /* iframe may still be loading */ }
}

function prepareOverlay(value) {
  reportInteractionMetrics();
  cancelPointerFrame();
  previewLoadToken += 1;
  document.body.classList.remove('is-standby');
  config = value;
  rebuildWindowTargetIndex();
  interactionMetrics = createInteractionMetrics(value);
  startPoint = null;
  isSelecting = false;
  pointerDown = false;
  hoveredWindow = null;
  lastPointerPosition = null;
  imageReady = false;
  pendingRect = null;
  selectionCommitted = false;
  resetInlineEditor();
  selection.hidden = true;
  selection.classList.remove('is-window-target');
  loupe.hidden = true;
  processing.hidden = true;
  document.getElementById('capture-header').hidden = false;
  screenImage.classList.remove('is-ready');
  screenImage.removeAttribute('src');
  selectionImage.style.backgroundImage = 'none';
  loupe.style.backgroundImage = 'none';
  releasePreviewObjectUrl();
  document.getElementById('capture-mode').textContent = ({
    ocr: '截图取字',
    prompt: '截图转提示词',
    edit: '截图标注',
    translate: '截图翻译',
  })[value.mode] || '截图翻译';
  document.getElementById('capture-instruction').textContent = '悬停智能识别窗口与内部区域，单击截取；拖动自由框选';
  document.body.dataset.windowTargets = String(value.windowTargets?.length || 0);
  document.body.dataset.smartWindowTargets = '0';
  document.body.dataset.captureVariant = value.captureVariant || 'faithful';
  document.body.dataset.previewQuality = 'waiting';
  delete document.body.dataset.initialPreviewFormat;
  delete document.body.dataset.previewReadyAt;
  delete document.body.dataset.previewLoadError;
  const paintToken = ++overlayPaintToken;
  const preparedAt = Date.now();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (paintToken !== overlayPaintToken || document.body.classList.contains('is-standby')) return;
    window.luvoelle.reportOverlayPaint({
      sessionId: value.sessionId,
      displayId: value.displayId,
      preparedAt,
      paintedAt: Date.now(),
    });
  }));
}

window.luvoelle.onOverlayPrepare(prepareOverlay);

function applyOverlayTargetsUpdate(value) {
  if (!config || value?.sessionId !== config.sessionId) return;
  const topLevelTargets = (config.windowTargets || []).filter((target) => target.source !== 'uia');
  const smartTargets = Array.isArray(value.targets) ? value.targets : [];
  config.windowTargets = [...topLevelTargets, ...smartTargets];
  rebuildWindowTargetIndex();
  document.body.dataset.windowTargets = String(config.windowTargets.length);
  document.body.dataset.smartWindowTargets = String(smartTargets.length);
  if (!pointerDown && lastPointerPosition) {
    hoveredWindow = findWindowTarget(lastPointerPosition);
    if (hoveredWindow) {
      loupe.hidden = true;
      displaySelection(hoveredWindow, { windowTarget: true, title: hoveredWindow.title });
    }
  }
}

window.luvoelle.onOverlayTargetsUpdate(applyOverlayTargetsUpdate);

function enterStandby() {
  const standbyToken = ++overlayPaintToken;
  reportInteractionMetrics();
  cancelPointerFrame();
  previewLoadToken += 1;
  config = null;
  startPoint = null;
  isSelecting = false;
  pointerDown = false;
  hoveredWindow = null;
  lastPointerPosition = null;
  imageReady = false;
  pendingRect = null;
  selectionCommitted = false;
  resetInlineEditor();
  selection.hidden = true;
  loupe.hidden = true;
  processing.hidden = true;
  screenImage.classList.remove('is-ready');
  screenImage.removeAttribute('src');
  selectionImage.style.backgroundImage = 'none';
  loupe.style.backgroundImage = 'none';
  releasePreviewObjectUrl();
  document.body.classList.add('is-standby');
  document.body.dataset.captureState = 'standby';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (standbyToken === overlayPaintToken && document.body.classList.contains('is-standby')) {
      window.luvoelle.reportOverlayStandbyReady();
    }
  }));
}

window.luvoelle.onOverlayStandby(enterStandby);

window.luvoelle.onOverlayInit((value) => {
  if (!config || value?.sessionId !== config.sessionId) return;
  config = { ...config, ...value };
  document.body.dataset.sourceCaptureBackend = value.captureBackend || 'unknown';
  document.body.dataset.captureVariant = value.captureVariant || config.captureVariant || 'faithful';
  document.body.dataset.previewFormat = value.previewFormat || 'png';
  document.body.dataset.initialPreviewFormat = value.previewFormat || 'png';
  document.body.dataset.previewQuality = value.previewQuality || 'lossless';
  document.body.dataset.captureState = 'loading-frame';
  selectionImage.style.backgroundSize = `${innerWidth}px ${innerHeight}px`;
  loupe.style.backgroundSize = `${innerWidth * 2}px ${innerHeight * 2}px`;
  if (value.previewFormat === 'bmp') loadLosslessBmpPreview(value);
  else {
    screenImage.src = value.image;
    selectionImage.style.backgroundImage = `url(${value.image})`;
    loupe.style.backgroundImage = `url(${value.image})`;
  }
});

function loadLosslessBmpPreview(value) {
  if (!config || value?.sessionId !== config.sessionId || value.previewFormat !== 'bmp') return;
  const bytes = previewBytes(value);
  if (!bytes) {
    document.body.dataset.previewLoadError = 'bmp-bytes';
    window.luvoelle.cancelCapture();
    return;
  }
  const token = ++previewLoadToken;
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: value.mimeType || 'image/bmp' }));
  const losslessImage = new Image();
  losslessImage.decoding = 'async';
  losslessImage.addEventListener('load', () => {
    if (token !== previewLoadToken
      || !config
      || value.sessionId !== config.sessionId
      || document.body.classList.contains('is-standby')) {
      URL.revokeObjectURL(objectUrl);
      return;
    }
    const previousObjectUrl = previewObjectUrl;
    previewObjectUrl = objectUrl;
    screenImage.src = objectUrl;
    selectionImage.style.backgroundImage = `url(${objectUrl})`;
    loupe.style.backgroundImage = `url(${objectUrl})`;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (previousObjectUrl && previousObjectUrl !== previewObjectUrl) URL.revokeObjectURL(previousObjectUrl);
    }));
  }, { once: true });
  losslessImage.addEventListener('error', () => {
    URL.revokeObjectURL(objectUrl);
    if (token === previewLoadToken) {
      document.body.dataset.previewLoadError = 'bmp-decode';
      window.luvoelle.cancelCapture();
    }
  }, { once: true });
  losslessImage.src = objectUrl;
}

screenImage.addEventListener('load', () => {
  imageReady = true;
  document.body.dataset.captureState = 'ready';
  document.body.dataset.previewReadyAt = String(Date.now());
  screenImage.classList.add('is-ready');
  if (config) {
    window.luvoelle.reportOverlayPreviewReady({
      sessionId: config.sessionId,
      displayId: config.displayId,
      format: document.body.dataset.previewFormat || '',
      quality: document.body.dataset.previewQuality || '',
      naturalWidth: screenImage.naturalWidth,
      naturalHeight: screenImage.naturalHeight,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      devicePixelRatio,
    });
  }
  if (pendingRect) {
    const rect = pendingRect;
    pendingRect = null;
    finalizeCapture(rect);
  }
});

screenImage.addEventListener('error', () => window.luvoelle.cancelCapture());

function clamp(value, minimum, maximum) { return Math.max(minimum, Math.min(maximum, value)); }

function rectFromPoints(a, b) {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  return { left, top, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function displaySelection(rect, { windowTarget = false, title = '' } = {}) {
  selection.hidden = false;
  selection.classList.toggle('is-window-target', windowTarget);
  selection.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
  selection.style.width = `${rect.width}px`;
  selection.style.height = `${rect.height}px`;
  selectionImage.style.backgroundPosition = `${-rect.left}px ${-rect.top}px`;
  const scaleX = imageReady && screenImage.naturalWidth ? screenImage.naturalWidth / Math.max(1, innerWidth) : config?.scaleFactor || 1;
  const scaleY = imageReady && screenImage.naturalHeight ? screenImage.naturalHeight / Math.max(1, innerHeight) : config?.scaleFactor || 1;
  const dimensions = `${Math.round(rect.width * scaleX)} × ${Math.round(rect.height * scaleY)}`;
  if (windowTarget) {
    const compactTitle = String(title || '窗口').replace(/\s+/g, ' ').trim();
    selectionSize.textContent = `${compactTitle.length > 30 ? `${compactTitle.slice(0, 30)}…` : compactTitle}  ·  ${dimensions}`;
    selectionSize.title = compactTitle;
  } else {
    selectionSize.textContent = dimensions;
    selectionSize.removeAttribute('title');
  }
}

function updateSelection(point) {
  displaySelection(rectFromPoints(startPoint, point));
}

function findWindowTarget(point) {
  for (const target of sortedWindowTargets) {
    if (point.x >= target.left
      && point.y >= target.top
      && point.x <= target.left + target.width
      && point.y <= target.top + target.height) return target;
  }
  return null;
}

function updateWindowTarget(point) {
  lastPointerPosition = point;
  hoveredWindow = findWindowTarget(lastPointerPosition);
  if (!hoveredWindow) {
    selection.hidden = true;
    selection.classList.remove('is-window-target');
    updateLoupe(point);
    return;
  }
  loupe.hidden = true;
  displaySelection(hoveredWindow, { windowTarget: true, title: hoveredWindow.title });
}

function updateLoupe(point) {
  if (!config || !imageReady || isSelecting) { loupe.hidden = true; return; }
  const size = 116;
  const offset = 23;
  const left = point.x + offset + size > innerWidth ? point.x - offset - size : point.x + offset;
  const top = point.y + offset + size > innerHeight ? point.y - offset - size : point.y + offset;
  loupe.hidden = false;
  loupe.style.transform = `translate3d(${clamp(left, 8, innerWidth - size - 8)}px, ${clamp(top, 8, innerHeight - size - 8)}px, 0)`;
  const zoom = 2;
  loupe.style.backgroundPosition = `${size / 2 - point.x * zoom}px ${size / 2 - point.y * zoom}px`;
}

function renderPointerFrame() {
  pointerFrameRequest = 0;
  const point = pendingPointerPosition;
  pendingPointerPosition = null;
  if (!config || !point) return;
  const startedAt = performance.now();
  if (pointerDown) {
    if (!isSelecting && Math.hypot(point.x - startPoint.x, point.y - startPoint.y) >= DRAG_THRESHOLD) {
      isSelecting = true;
      hoveredWindow = null;
      selection.classList.remove('is-window-target');
    }
    if (isSelecting) updateSelection(point);
  } else updateWindowTarget(point);
  const elapsed = performance.now() - startedAt;
  if (interactionMetrics) {
    interactionMetrics.renderedFrames += 1;
    interactionMetrics.totalFrameMs += elapsed;
    interactionMetrics.maxFrameMs = Math.max(interactionMetrics.maxFrameMs, elapsed);
  }
}

function queuePointerFrame(point) {
  if (interactionMetrics) interactionMetrics.pointerEvents += 1;
  pendingPointerPosition = point;
  if (pointerFrameRequest) {
    if (interactionMetrics) interactionMetrics.coalescedEvents += 1;
    return;
  }
  pointerFrameRequest = requestAnimationFrame(renderPointerFrame);
}

function crop(rect) {
  const canvas = document.createElement('canvas');
  const scaleX = screenImage.naturalWidth / innerWidth;
  const scaleY = screenImage.naturalHeight / innerHeight;
  canvas.width = Math.max(1, Math.round(rect.width * scaleX));
  canvas.height = Math.max(1, Math.round(rect.height * scaleY));
  const context = canvas.getContext('2d', { alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    screenImage,
    Math.round(rect.left * scaleX),
    Math.round(rect.top * scaleY),
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return canvas.toDataURL('image/png');
}

function flushInlineEditor() {
  if (!inlineEditorReady || !pendingInlineEditor) return;
  inlineEditor.contentWindow.postMessage({ type: 'editor:inline-init', ...pendingInlineEditor }, '*');
  pendingInlineEditor = null;
  if (pendingInlineCompletion) {
    pendingInlineCompletion = false;
    inlineEditor.contentWindow.postMessage({ type: 'editor:inline-complete' }, '*');
  }
}

function completeInlineEditor() {
  pendingInlineCompletion = true;
  if (inlineEditor.hidden || !inlineEditorReady) return;
  pendingInlineCompletion = false;
  inlineEditor.contentWindow.postMessage({ type: 'editor:inline-complete' }, '*');
}

async function startInlineEditor(dataUrl, rect) {
  const request = (fallbackDataUrl) => window.luvoelle.submitCapture({
    dataUrl: fallbackDataUrl,
    mode: 'edit',
    rect,
    inline: true,
    displayId: config.displayId,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
  });
  let result = await request(dataUrl);
  if (result?.needsRendererFallback) {
    document.body.dataset.captureCropPath = 'renderer-fallback';
    dataUrl = crop(rect);
    result = await request(dataUrl);
  }
  if (!result?.ok) throw new Error(result?.message || '无法进入原地编辑');
  processing.hidden = true;
  selection.hidden = true;
  loupe.hidden = true;
  document.getElementById('capture-header').hidden = true;
  document.body.classList.add('is-inline-editing');
  document.body.dataset.captureQuality = result.lossless ? 'lossless' : 'fallback';
  document.body.dataset.captureBackend = result.captureBackend || 'unknown';
  pendingInlineEditor = { dataUrl: result.dataUrl || dataUrl, rect };
  inlineEditor.hidden = false;
  flushInlineEditor();
}

function canRequestFrozenSourceCrop() {
  const backend = String(config?.captureBackend || '');
  return Boolean(config?.displayId !== undefined && backend && backend !== 'unknown');
}

async function finalizeCapture(rect) {
  if (!imageReady) {
    pendingRect = rect;
    document.querySelector('.processing strong').textContent = '正在冻结选区';
    document.querySelector('.processing small').textContent = '选区已保留，无需重新框选';
    return;
  }
  document.querySelector('.processing strong').textContent = config.mode === 'prompt'
    ? '截图已复制，正在视觉拆解'
    : config.mode === 'edit'
      ? '截图已复制，正在打开编辑器'
      : '截图已复制，正在本地识别';
  document.querySelector('.processing small').textContent = config.mode === 'prompt'
    ? '即将打开可编辑的结构化提示词'
    : config.mode === 'edit'
      ? '按 Enter 可直接完成并复制，也可以继续编辑'
      : '图片不会被自动保存';
  const useFrozenSource = config.mode === 'edit' && canRequestFrozenSourceCrop();
  document.body.dataset.captureCropPath = useFrozenSource ? 'native-frame' : 'renderer';
  const dataUrl = useFrozenSource ? '' : crop(rect);
  try {
    if (config.mode === 'edit') await startInlineEditor(dataUrl, rect);
    else await window.luvoelle.submitCapture({
      dataUrl,
      mode: config.mode,
      rect,
      displayId: config.displayId,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    });
  } catch {
    window.luvoelle.cancelCapture();
  }
}

inlineEditor.addEventListener('load', () => {
  inlineEditorReady = true;
  flushInlineEditor();
});

window.addEventListener('message', (event) => {
  if (event.source !== inlineEditor.contentWindow) return;
  if (event.data?.type === 'editor:inline-ready') {
    inlineEditorReady = true;
    flushInlineEditor();
  }
  if (event.data?.type === 'editor:inline-finish' || event.data?.type === 'editor:inline-cancel' || event.data?.type === 'editor:inline-pinned') {
    resetInlineEditor();
    window.luvoelle.cancelCapture();
  }
});

document.addEventListener('mousedown', (event) => {
  if (!config || event.button !== 0 || event.target.closest('.capture-header')) return;
  cancelPointerFrame();
  startPoint = { x: event.clientX, y: event.clientY };
  hoveredWindow = findWindowTarget(startPoint);
  pointerDown = true;
  isSelecting = false;
  loupe.hidden = true;
});

document.addEventListener('mousemove', (event) => {
  queuePointerFrame({ x: event.clientX, y: event.clientY });
});

document.addEventListener('mouseup', async (event) => {
  if (!pointerDown) return;
  cancelPointerFrame();
  pointerDown = false;
  const endPoint = { x: event.clientX, y: event.clientY };
  const manualSelection = isSelecting || Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y) >= DRAG_THRESHOLD;
  isSelecting = false;
  const rect = manualSelection
    ? rectFromPoints(startPoint, endPoint)
    : hoveredWindow;
  hoveredWindow = null;
  if (!rect) {
    selection.hidden = true;
    return;
  }
  if (rect.width < 12 || rect.height < 12) {
    selection.hidden = true;
    return;
  }
  displaySelection(rect, { windowTarget: !manualSelection, title: rect.title });
  document.getElementById('capture-header').hidden = true;
  loupe.hidden = true;
  processing.hidden = false;
  selectionCommitted = true;
  await finalizeCapture(rect);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.luvoelle.cancelCapture();
    return;
  }
  if (event.key === 'Enter' && config?.mode === 'edit' && selectionCommitted && !event.isComposing && !event.repeat) {
    event.preventDefault();
    completeInlineEditor();
  }
});

document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
    window.luvoelle.cancelCapture();
});
