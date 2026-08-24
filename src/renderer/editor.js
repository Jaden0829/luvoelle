const canvas = document.getElementById('editor-canvas');
const context = canvas.getContext('2d', { alpha: false, willReadFrequently: false });
const stage = document.getElementById('canvas-stage');
const toolbar = document.querySelector('.editor-toolbar');
const toolOptions = document.querySelector('.tool-options');
const inlineMode = new URLSearchParams(location.search).get('inline') === '1';
const editorBridge = (() => {
  if (window.luvoelle) return window.luvoelle;
  try { return window.parent?.luvoelle; } catch { return null; }
})();
if (!editorBridge) throw new Error('Luvoelle editor bridge is unavailable');
if (inlineMode) {
  document.documentElement.classList.add('inline-mode-root');
  document.body.classList.add('inline-mode');
  document.getElementById('cancel-inline-editor').hidden = false;
}
const actions = [];
const redoStack = [];
let baseImage;
let activeTool = 'rect';
let activeColor = '#ff4d57';
let activeMosaicMode = 'square';
let activeArrowStyle = 'open';
let activeEmoji = '😊';
let draft = null;
let activePointerId = null;
let selectedMosaicIndex = -1;
let selectedVectorIndex = -1;
let selectedEmojiIndex = -1;
let emojiDragOffset = null;
let inlineRect = null;
let inlineControls = null;
let inlineControlsDrag = null;
let mosaicTransform = null;
let rectRadiusTransform = null;
let completeWhenReady = false;

const toolHints = {
  rect: '拖动绘制矩形',
  ellipse: '拖动绘制椭圆',
  arrow: '拖动绘制箭头',
  pen: '按住鼠标自由绘制',
  mosaic: '涂抹需要隐藏的区域',
  text: '输入文字后点击图片放置',
  emoji: '选择 Emoji 后点击图片放置，可拖动调整位置',
};

function makeCanvas(width = canvas.width, height = canvas.height) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

function normalizedRect(start, end) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function firstGrapheme(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (typeof Intl.Segmenter === 'function') {
    const segment = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)[Symbol.iterator]().next().value;
    return segment?.segment || '';
  }
  return Array.from(text)[0] || '';
}

function emojiFont(size) {
  return `${size}px "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif`;
}

function emojiBounds(action, targetContext = context) {
  targetContext.save();
  targetContext.font = emojiFont(action.fontSize);
  const measured = targetContext.measureText(action.emoji);
  targetContext.restore();
  const width = Math.max(action.fontSize * 0.92, measured.width);
  const height = action.fontSize * 1.18;
  return {
    x: action.point.x - width / 2,
    y: action.point.y - height / 2,
    width,
    height,
  };
}

function findEmojiAtPoint(point) {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (action.type !== 'emoji') continue;
    const bounds = emojiBounds(action);
    const padding = Math.max(6, action.fontSize * 0.12);
    if (point.x >= bounds.x - padding && point.x <= bounds.x + bounds.width + padding
      && point.y >= bounds.y - padding && point.y <= bounds.y + bounds.height + padding) return index;
  }
  return -1;
}

function drawLinePath(targetContext, points) {
  if (!points.length) return;
  targetContext.beginPath();
  targetContext.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => targetContext.lineTo(point.x, point.y));
  targetContext.stroke();
}

function drawMosaic(targetContext, action) {
  const width = targetContext.canvas.width;
  const height = targetContext.canvas.height;
  const snapshot = makeCanvas(width, height);
  snapshot.getContext('2d').drawImage(targetContext.canvas, 0, 0);

  const mask = makeCanvas(width, height);
  const maskContext = mask.getContext('2d');
  maskContext.strokeStyle = '#fff';
  maskContext.fillStyle = '#fff';
  if (action.mode === 'square') {
    const rect = normalizedRect(action.start, action.end);
    maskContext.fillRect(rect.x, rect.y, rect.width, rect.height);
  } else if (action.mode === 'circle') {
    const rect = normalizedRect(action.start, action.end);
    maskContext.beginPath();
    maskContext.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2);
    maskContext.fill();
  } else if (action.points.length === 1) {
    maskContext.beginPath();
    maskContext.arc(action.points[0].x, action.points[0].y, action.brushSize / 2, 0, Math.PI * 2);
    maskContext.fill();
  } else {
    maskContext.lineWidth = action.brushSize;
    maskContext.lineCap = 'round';
    maskContext.lineJoin = 'round';
    drawLinePath(maskContext, action.points);
  }

  const layer = makeCanvas(width, height);
  const layerContext = layer.getContext('2d');
  if (['square', 'circle'].includes(action.mode)) {
    const blurRadius = Math.max(2, action.pixelSize * 0.55);
    layerContext.filter = `blur(${blurRadius}px) saturate(.84) brightness(1.06)`;
    layerContext.drawImage(snapshot, 0, 0);
    layerContext.filter = 'none';
  } else {
    const blockSize = Math.max(4, action.pixelSize);
    const reduced = makeCanvas(Math.max(1, Math.ceil(width / blockSize)), Math.max(1, Math.ceil(height / blockSize)));
    const reducedContext = reduced.getContext('2d');
    reducedContext.imageSmoothingEnabled = true;
    reducedContext.drawImage(snapshot, 0, 0, reduced.width, reduced.height);
    layerContext.imageSmoothingEnabled = false;
    layerContext.drawImage(reduced, 0, 0, reduced.width, reduced.height, 0, 0, width, height);
  }
  layerContext.globalCompositeOperation = 'destination-in';
  layerContext.drawImage(mask, 0, 0);
  if (['square', 'circle'].includes(action.mode)) {
    layerContext.globalCompositeOperation = 'source-atop';
    layerContext.fillStyle = 'rgba(224, 238, 250, .07)';
    layerContext.fillRect(0, 0, width, height);
  }
  targetContext.drawImage(layer, 0, 0);
}

function mosaicHandles(action) {
  const rect = normalizedRect(action.start, action.end);
  const middleX = rect.x + rect.width / 2;
  const middleY = rect.y + rect.height / 2;
  return {
    nw: { x: rect.x, y: rect.y },
    n: { x: middleX, y: rect.y },
    ne: { x: rect.x + rect.width, y: rect.y },
    e: { x: rect.x + rect.width, y: middleY },
    se: { x: rect.x + rect.width, y: rect.y + rect.height },
    s: { x: middleX, y: rect.y + rect.height },
    sw: { x: rect.x, y: rect.y + rect.height },
    w: { x: rect.x, y: middleY },
  };
}

function drawMosaicSelection(targetContext, action) {
  if (!action || !['square', 'circle'].includes(action.mode)) return;
  const rect = normalizedRect(action.start, action.end);
  const displayWidth = Math.max(1, canvas.getBoundingClientRect().width);
  const scale = canvas.width / displayWidth;
  const trace = () => {
    targetContext.beginPath();
    if (action.mode === 'square') targetContext.rect(rect.x, rect.y, rect.width, rect.height);
    else targetContext.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2);
    targetContext.stroke();
  };
  targetContext.save();
  targetContext.setLineDash([6 * scale, 4 * scale]);
  targetContext.strokeStyle = 'rgba(0, 0, 0, .42)';
  targetContext.lineWidth = 3.2 * scale;
  trace();
  targetContext.strokeStyle = 'rgba(255, 255, 255, .78)';
  targetContext.lineWidth = 1.35 * scale;
  trace();
  targetContext.setLineDash([]);
  Object.values(mosaicHandles(action)).forEach((handle) => {
    const size = 7 * scale;
    targetContext.fillStyle = '#f7fbff';
    targetContext.strokeStyle = '#1685f5';
    targetContext.lineWidth = 1.5 * scale;
    targetContext.beginPath();
    targetContext.roundRect(handle.x - size / 2, handle.y - size / 2, size, size, 1.8 * scale);
    targetContext.fill();
    targetContext.stroke();
  });
  targetContext.restore();
}

function mosaicDisplayScale() {
  return canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
}

function mosaicHandleAtPoint(point, action) {
  if (!action || !['square', 'circle'].includes(action.mode)) return '';
  const radius = 9 * mosaicDisplayScale();
  return Object.entries(mosaicHandles(action)).find(([, handle]) => Math.hypot(point.x - handle.x, point.y - handle.y) <= radius)?.[0] || '';
}

function mosaicContainsPoint(action, point) {
  if (!action || !['square', 'circle'].includes(action.mode)) return false;
  const rect = normalizedRect(action.start, action.end);
  if (action.mode === 'square') {
    return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
  }
  if (rect.width <= 0 || rect.height <= 0) return false;
  const normalizedX = (point.x - (rect.x + rect.width / 2)) / (rect.width / 2);
  const normalizedY = (point.y - (rect.y + rect.height / 2)) / (rect.height / 2);
  return normalizedX ** 2 + normalizedY ** 2 <= 1;
}

function findMosaicAtPoint(point) {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    if (mosaicContainsPoint(actions[index], point)) return index;
  }
  return -1;
}

function selectMosaicAction(index) {
  const action = actions[index];
  if (!action || !['square', 'circle'].includes(action.mode)) return false;
  selectedMosaicIndex = index;
  selectedVectorIndex = -1;
  selectedEmojiIndex = -1;
  document.getElementById('mosaic-pixel').value = String(action.pixelSize);
  document.getElementById('mosaic-pixel-value').textContent = String(action.pixelSize);
  setMosaicMode(action.mode, true);
  document.getElementById('tool-hint').textContent = `${action.mode === 'square' ? '方形' : '圆形'}磨砂区域已选中 · 拖动控制点缩放，拖动内部移动`;
  return true;
}

function startMosaicTransform(event, point, index, mode) {
  const action = actions[index];
  const rect = normalizedRect(action.start, action.end);
  mosaicTransform = { index, mode, pointerStart: point, rect: { ...rect } };
  activePointerId = event.pointerId;
  canvas.setPointerCapture(activePointerId);
}

function updateMosaicTransform(point) {
  if (!mosaicTransform) return;
  const action = actions[mosaicTransform.index];
  if (!action) return;
  const original = mosaicTransform.rect;
  let left = original.x;
  let top = original.y;
  let right = original.x + original.width;
  let bottom = original.y + original.height;
  const minimumSize = 12 * mosaicDisplayScale();

  if (mosaicTransform.mode === 'move') {
    const deltaX = point.x - mosaicTransform.pointerStart.x;
    const deltaY = point.y - mosaicTransform.pointerStart.y;
    left = Math.max(0, Math.min(canvas.width - original.width, original.x + deltaX));
    top = Math.max(0, Math.min(canvas.height - original.height, original.y + deltaY));
    right = left + original.width;
    bottom = top + original.height;
  } else {
    if (mosaicTransform.mode.includes('w')) left = Math.max(0, Math.min(right - minimumSize, point.x));
    if (mosaicTransform.mode.includes('e')) right = Math.min(canvas.width, Math.max(left + minimumSize, point.x));
    if (mosaicTransform.mode.includes('n')) top = Math.max(0, Math.min(bottom - minimumSize, point.y));
    if (mosaicTransform.mode.includes('s')) bottom = Math.min(canvas.height, Math.max(top + minimumSize, point.y));
  }
  action.start = { x: left, y: top };
  action.end = { x: right, y: bottom };
  render();
}

function mosaicCursor(handle) {
  return ({ n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' })[handle] || 'move';
}

function drawEmojiSelection(targetContext, action) {
  if (!action || action.type !== 'emoji') return;
  const bounds = emojiBounds(action, targetContext);
  const displayWidth = Math.max(1, canvas.getBoundingClientRect().width);
  const scale = canvas.width / displayWidth;
  const padding = 5 * scale;
  targetContext.save();
  targetContext.setLineDash([5 * scale, 4 * scale]);
  targetContext.strokeStyle = 'rgba(22, 133, 245, .92)';
  targetContext.lineWidth = 1.4 * scale;
  targetContext.strokeRect(bounds.x - padding, bounds.y - padding, bounds.width + padding * 2, bounds.height + padding * 2);
  targetContext.setLineDash([]);
  targetContext.fillStyle = '#1685f5';
  targetContext.beginPath();
  targetContext.arc(bounds.x + bounds.width + padding, bounds.y + bounds.height + padding, 3.6 * scale, 0, Math.PI * 2);
  targetContext.fill();
  targetContext.restore();
}

function roundedRectPath(targetContext, rect, radius = 0) {
  const cornerRadius = Math.max(0, Math.min(Number(radius) || 0, rect.width / 2, rect.height / 2));
  targetContext.beginPath();
  if (cornerRadius <= 0.01) {
    targetContext.rect(rect.x, rect.y, rect.width, rect.height);
    return;
  }
  targetContext.moveTo(rect.x + cornerRadius, rect.y);
  targetContext.lineTo(rect.x + rect.width - cornerRadius, rect.y);
  targetContext.arcTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + cornerRadius, cornerRadius);
  targetContext.lineTo(rect.x + rect.width, rect.y + rect.height - cornerRadius);
  targetContext.arcTo(rect.x + rect.width, rect.y + rect.height, rect.x + rect.width - cornerRadius, rect.y + rect.height, cornerRadius);
  targetContext.lineTo(rect.x + cornerRadius, rect.y + rect.height);
  targetContext.arcTo(rect.x, rect.y + rect.height, rect.x, rect.y + rect.height - cornerRadius, cornerRadius);
  targetContext.lineTo(rect.x, rect.y + cornerRadius);
  targetContext.arcTo(rect.x, rect.y, rect.x + cornerRadius, rect.y, cornerRadius);
  targetContext.closePath();
}

function drawArrowHead(targetContext, point, angle, headSize, filled = false) {
  const wingAngle = Math.PI / 6;
  const first = {
    x: point.x - headSize * Math.cos(angle - wingAngle),
    y: point.y - headSize * Math.sin(angle - wingAngle),
  };
  const second = {
    x: point.x - headSize * Math.cos(angle + wingAngle),
    y: point.y - headSize * Math.sin(angle + wingAngle),
  };
  targetContext.beginPath();
  targetContext.moveTo(first.x, first.y);
  targetContext.lineTo(point.x, point.y);
  targetContext.lineTo(second.x, second.y);
  if (filled) {
    targetContext.closePath();
    targetContext.fill();
  } else targetContext.stroke();
}

function drawArrow(targetContext, action) {
  const dx = action.end.x - action.start.x;
  const dy = action.end.y - action.start.y;
  const angle = Math.atan2(dy, dx);
  const head = Math.max(12, action.strokeWidth * 4.2);
  const style = action.arrowStyle || 'open';
  const filled = ['filled', 'filled-double', 'dot'].includes(style);
  targetContext.beginPath();
  targetContext.moveTo(action.start.x, action.start.y);
  targetContext.lineTo(action.end.x, action.end.y);
  targetContext.stroke();
  drawArrowHead(targetContext, action.end, angle, head, filled);
  if (['double', 'filled-double'].includes(style)) {
    drawArrowHead(targetContext, action.start, angle + Math.PI, head, style === 'filled-double');
  }
  if (style === 'dot') {
    targetContext.beginPath();
    targetContext.arc(action.start.x, action.start.y, Math.max(4, action.strokeWidth * 1.15), 0, Math.PI * 2);
    targetContext.fill();
  }
}

function vectorDisplayScale() {
  return canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
}

function rectRadiusHandle(action) {
  if (!action || action.type !== 'rect') return null;
  const rect = normalizedRect(action.start, action.end);
  const maximum = Math.min(rect.width, rect.height) / 2;
  const radius = Math.max(0, Math.min(Number(action.cornerRadius) || 0, maximum));
  const inset = Math.min(maximum, Math.max(radius, 12 * vectorDisplayScale()));
  return { x: rect.x + inset, y: rect.y + inset };
}

function drawVectorSelection(targetContext, action) {
  if (!action || action.type !== 'rect') return;
  const handle = rectRadiusHandle(action);
  if (!handle) return;
  const scale = vectorDisplayScale();
  targetContext.save();
  targetContext.fillStyle = '#f7fbff';
  targetContext.strokeStyle = '#1685f5';
  targetContext.lineWidth = 1.7 * scale;
  targetContext.beginPath();
  targetContext.arc(handle.x, handle.y, 5.1 * scale, 0, Math.PI * 2);
  targetContext.fill();
  targetContext.stroke();
  targetContext.restore();
}

function rectRadiusHandleAtPoint(point, action) {
  const handle = rectRadiusHandle(action);
  return Boolean(handle && Math.hypot(point.x - handle.x, point.y - handle.y) <= 11 * vectorDisplayScale());
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
}

function vectorContainsPoint(action, point) {
  if (!action || !['rect', 'ellipse', 'arrow'].includes(action.type)) return false;
  const tolerance = Math.max(8 * vectorDisplayScale(), Number(action.strokeWidth || 0) * 1.5);
  if (action.type === 'arrow') return distanceToSegment(point, action.start, action.end) <= tolerance;
  const rect = normalizedRect(action.start, action.end);
  if (action.type === 'rect') {
    const insideExpanded = point.x >= rect.x - tolerance && point.x <= rect.x + rect.width + tolerance
      && point.y >= rect.y - tolerance && point.y <= rect.y + rect.height + tolerance;
    const insideContracted = point.x > rect.x + tolerance && point.x < rect.x + rect.width - tolerance
      && point.y > rect.y + tolerance && point.y < rect.y + rect.height - tolerance;
    return insideExpanded && !insideContracted;
  }
  if (rect.width <= 0 || rect.height <= 0) return false;
  const radiusX = rect.width / 2;
  const radiusY = rect.height / 2;
  const normalized = Math.hypot((point.x - (rect.x + radiusX)) / radiusX, (point.y - (rect.y + radiusY)) / radiusY);
  return Math.abs(normalized - 1) * Math.min(radiusX, radiusY) <= tolerance;
}

function findVectorAtPoint(point, type = activeTool) {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    if (actions[index].type === type && vectorContainsPoint(actions[index], point)) return index;
  }
  return -1;
}

function syncVectorControls(action) {
  if (!action) return;
  document.getElementById('stroke-width').value = String(action.strokeWidth);
  document.getElementById('stroke-width-value').textContent = String(action.strokeWidth);
  const swatch = [...document.querySelectorAll('.color-swatch')].find((candidate) => candidate.dataset.color === action.color);
  setActiveColor(action.color, swatch || null, !swatch);
  if (action.type === 'arrow') setArrowStyle(action.arrowStyle || 'open', true);
}

function selectVectorAction(index) {
  const action = actions[index];
  if (!action || !['rect', 'ellipse', 'arrow'].includes(action.type)) return false;
  selectedVectorIndex = index;
  selectedMosaicIndex = -1;
  selectedEmojiIndex = -1;
  syncVectorControls(action);
  document.getElementById('tool-hint').textContent = action.type === 'rect'
    ? '矩形已选中 · 拖动蓝色圆点调整圆角'
    : action.type === 'arrow'
      ? '箭头已选中 · 可切换样式与线宽'
      : '椭圆已选中 · 可调整线宽与颜色';
  render();
  return true;
}

function startRectRadiusTransform(event, action) {
  rectRadiusTransform = { action };
  activePointerId = event.pointerId;
  canvas.setPointerCapture(activePointerId);
  canvas.style.cursor = 'nwse-resize';
}

function updateRectRadiusTransform(point) {
  const action = rectRadiusTransform?.action;
  if (!action) return;
  const rect = normalizedRect(action.start, action.end);
  action.cornerRadius = Math.max(0, Math.min(
    Math.min(rect.width, rect.height) / 2,
    Math.max(point.x - rect.x, point.y - rect.y),
  ));
  render();
}

function drawAction(targetContext, action) {
  targetContext.save();
  targetContext.strokeStyle = action.color;
  targetContext.fillStyle = action.color;
  targetContext.lineWidth = action.strokeWidth;
  targetContext.lineCap = 'round';
  targetContext.lineJoin = 'round';

  if (action.type === 'rect') {
    const rect = normalizedRect(action.start, action.end);
    roundedRectPath(targetContext, rect, action.cornerRadius);
    targetContext.stroke();
  }
  if (action.type === 'ellipse') {
    const rect = normalizedRect(action.start, action.end);
    targetContext.beginPath();
    targetContext.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2);
    targetContext.stroke();
  }
  if (action.type === 'arrow') {
    drawArrow(targetContext, action);
  }
  if (action.type === 'pen') drawLinePath(targetContext, action.points);
  if (action.type === 'mosaic') drawMosaic(targetContext, action);
  if (action.type === 'text') {
    targetContext.font = `600 ${action.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif`;
    targetContext.textBaseline = 'top';
    action.text.split('\n').forEach((line, index) => targetContext.fillText(line, action.point.x, action.point.y + index * action.fontSize * 1.25));
  }
  if (action.type === 'emoji') {
    targetContext.font = emojiFont(action.fontSize);
    targetContext.textAlign = 'center';
    targetContext.textBaseline = 'middle';
    targetContext.fillText(action.emoji, action.point.x, action.point.y);
  }
  targetContext.restore();
}

function render(showSelection = true) {
  if (!baseImage) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
  actions.forEach((action) => drawAction(context, action));
  if (draft) drawAction(context, draft);
  const selectedAction = actions[selectedMosaicIndex];
  const selectedVector = actions[selectedVectorIndex];
  const selectedEmoji = actions[selectedEmojiIndex];
  const guideAction = draft?.type === 'mosaic' && ['square', 'circle'].includes(draft.mode) ? draft : selectedAction;
  if (showSelection && activeTool === 'mosaic') drawMosaicSelection(context, guideAction);
  if (showSelection && activeTool === 'emoji') drawEmojiSelection(context, selectedEmoji);
  if (showSelection && activeTool === 'rect') drawVectorSelection(context, selectedVector?.type === 'rect' ? selectedVector : null);
  document.getElementById('editor-count').textContent = `${actions.length} 个标注`;
  canvas.dataset.annotations = String(actions.length);
  canvas.dataset.selectionGuide = showSelection && activeTool === 'mosaic' && ['square', 'circle'].includes(guideAction?.mode) ? guideAction.mode : '';
  canvas.dataset.selectedMosaicBlur = selectedAction?.type === 'mosaic' ? String(selectedAction.pixelSize) : '';
  const selectedMosaicRect = selectedAction?.type === 'mosaic' && ['square', 'circle'].includes(selectedAction.mode) ? normalizedRect(selectedAction.start, selectedAction.end) : null;
  canvas.dataset.selectedMosaicRect = selectedMosaicRect ? [selectedMosaicRect.x, selectedMosaicRect.y, selectedMosaicRect.width, selectedMosaicRect.height].map((value) => Math.round(value)).join(',') : '';
  canvas.dataset.mosaicEffect = selectedMosaicRect ? 'frosted-glass' : selectedAction?.type === 'mosaic' ? 'pixelated-brush' : '';
  canvas.dataset.selectedVectorStroke = selectedVector ? String(selectedVector.strokeWidth) : '';
  canvas.dataset.selectedArrowStyle = selectedVector?.type === 'arrow' ? selectedVector.arrowStyle || 'open' : '';
  canvas.dataset.selectedRectRadius = selectedVector?.type === 'rect' ? String(Math.round(Number(selectedVector.cornerRadius) || 0)) : '';
  canvas.dataset.selectedEmoji = selectedEmoji?.type === 'emoji' ? selectedEmoji.emoji : '';
  canvas.dataset.selectedEmojiSize = selectedEmoji?.type === 'emoji' ? String(selectedEmoji.fontSize) : '';
  canvas.dataset.selectedEmojiX = selectedEmoji?.type === 'emoji' ? String(Math.round(selectedEmoji.point.x)) : '';
  canvas.dataset.selectedEmojiY = selectedEmoji?.type === 'emoji' ? String(Math.round(selectedEmoji.point.y)) : '';
  document.getElementById('undo-editor').disabled = actions.length === 0;
  document.getElementById('redo-editor').disabled = redoStack.length === 0;
}

function fitCanvas() {
  if (!baseImage) return;
  if (inlineMode && inlineRect) {
    canvas.style.width = `${inlineRect.width}px`;
    canvas.style.height = `${inlineRect.height}px`;
    return;
  }
  const availableWidth = Math.max(120, stage.clientWidth - 44);
  const availableHeight = Math.max(120, stage.clientHeight - 44);
  const scale = Math.min(availableWidth / canvas.width, availableHeight / canvas.height, 1.5);
  canvas.style.width = `${Math.round(canvas.width * scale)}px`;
  canvas.style.height = `${Math.round(canvas.height * scale)}px`;
}

function configureInlineLayout(rect) {
  const safeRect = {
    left: Math.max(0, Number(rect?.left) || 0),
    top: Math.max(0, Number(rect?.top) || 0),
    width: Math.max(12, Math.min(innerWidth, Number(rect?.width) || 12)),
    height: Math.max(12, Math.min(innerHeight, Number(rect?.height) || 12)),
  };
  safeRect.width = Math.min(safeRect.width, innerWidth - safeRect.left);
  safeRect.height = Math.min(safeRect.height, innerHeight - safeRect.top);
  inlineRect = safeRect;

  const margin = 10;
  const controlsHeight = 103;
  const controlsWidth = Math.min(940, innerWidth - 16);
  const controlsLeft = Math.max(8, Math.min(innerWidth - controlsWidth - 8, safeRect.left + safeRect.width / 2 - controlsWidth / 2));
  const below = safeRect.top + safeRect.height + margin;
  const above = safeRect.top - controlsHeight - margin;
  const controlsTop = below + controlsHeight <= innerHeight - 8
    ? below
    : above >= 8
      ? above
      : Math.max(8, innerHeight - controlsHeight - 8);

  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--inline-canvas-left', `${safeRect.left}px`);
  rootStyle.setProperty('--inline-canvas-top', `${safeRect.top}px`);
  rootStyle.setProperty('--inline-canvas-width', `${safeRect.width}px`);
  rootStyle.setProperty('--inline-canvas-height', `${safeRect.height}px`);
  rootStyle.setProperty('--inline-controls-left', `${controlsLeft}px`);
  rootStyle.setProperty('--inline-controls-top', `${controlsTop}px`);
  rootStyle.setProperty('--inline-controls-width', `${controlsWidth}px`);
  inlineControls = { left: controlsLeft, top: controlsTop, width: controlsWidth, height: controlsHeight };
  fitCanvas();
}

function clampInlineControls(left, top) {
  const width = inlineControls?.width || Math.min(940, innerWidth - 16);
  const height = inlineControls?.height || 103;
  const margin = 8;
  return {
    left: Math.max(margin, Math.min(Math.max(margin, innerWidth - width - margin), left)),
    top: Math.max(margin, Math.min(Math.max(margin, innerHeight - height - margin), top)),
  };
}

function moveInlineControls(left, top) {
  if (!inlineMode || !inlineControls) return;
  const position = clampInlineControls(left, top);
  inlineControls.left = position.left;
  inlineControls.top = position.top;
  document.documentElement.style.setProperty('--inline-controls-left', `${position.left}px`);
  document.documentElement.style.setProperty('--inline-controls-top', `${position.top}px`);
}

function finishInlineControlsDrag(event) {
  if (!inlineControlsDrag || (event?.pointerId != null && event.pointerId !== inlineControlsDrag.pointerId)) return;
  const { captureElement, pointerId } = inlineControlsDrag;
  if (captureElement?.hasPointerCapture?.(pointerId)) captureElement.releasePointerCapture(pointerId);
  inlineControlsDrag = null;
  document.body.classList.remove('is-dragging-controls');
}

function startInlineControlsDrag(event) {
  if (!inlineMode || !inlineControls || event.button !== 0 || event.isPrimary === false) return;
  if (event.target.closest('button, input, label, select, textarea, a')) return;
  event.preventDefault();
  event.stopPropagation();
  inlineControlsDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originLeft: inlineControls.left,
    originTop: inlineControls.top,
    captureElement: event.currentTarget,
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  document.body.classList.add('is-dragging-controls');
}

if (inlineMode) {
  [toolbar, toolOptions].forEach((surface) => {
    surface.addEventListener('pointerdown', startInlineControlsDrag);
    surface.addEventListener('pointermove', (event) => {
      if (!inlineControlsDrag || event.pointerId !== inlineControlsDrag.pointerId) return;
      event.preventDefault();
      moveInlineControls(
        inlineControlsDrag.originLeft + event.clientX - inlineControlsDrag.startX,
        inlineControlsDrag.originTop + event.clientY - inlineControlsDrag.startY,
      );
    });
    surface.addEventListener('pointerup', finishInlineControlsDrag);
    surface.addEventListener('pointercancel', finishInlineControlsDrag);
    surface.addEventListener('lostpointercapture', finishInlineControlsDrag);
  });
  window.addEventListener('resize', () => {
    if (inlineControls) moveInlineControls(inlineControls.left, inlineControls.top);
  });
}

function showToast(message) {
  const toast = document.getElementById('editor-toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  setTimeout(() => toast.classList.remove('is-visible'), 1500);
}

function pointFromEvent(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - bounds.left) * canvas.width / bounds.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - bounds.top) * canvas.height / bounds.height)),
  };
}

function strokeWidth() { return Number(document.getElementById('stroke-width').value); }
function mosaicBrushSize() { return Number(document.getElementById('mosaic-brush').value); }
function mosaicPixelSize() { return Number(document.getElementById('mosaic-pixel').value); }

function setArrowStyle(style, applyToSelection = true) {
  const normalized = ['open', 'filled', 'double', 'filled-double', 'dot'].includes(style) ? style : 'open';
  activeArrowStyle = normalized;
  document.querySelectorAll('[data-arrow-style]').forEach((candidate) => {
    const active = candidate.dataset.arrowStyle === normalized;
    candidate.classList.toggle('is-active', active);
    candidate.setAttribute('aria-pressed', String(active));
  });
  const selected = actions[selectedVectorIndex];
  if (applyToSelection && selected?.type === 'arrow') selected.arrowStyle = normalized;
  document.getElementById('tool-hint').textContent = selected?.type === 'arrow'
    ? '箭头样式已更新 · 可继续调整线宽与颜色'
    : '拖动绘制箭头 · 画好后仍可切换样式';
  render();
}

function setMosaicMode(mode, preserveSelection = false) {
  activeMosaicMode = mode;
  if (!preserveSelection) selectedMosaicIndex = -1;
  selectedVectorIndex = -1;
  selectedEmojiIndex = -1;
  document.querySelectorAll('[data-mosaic-mode]').forEach((candidate) => {
    const active = candidate.dataset.mosaicMode === mode;
    candidate.classList.toggle('is-active', active);
    candidate.setAttribute('aria-pressed', String(active));
  });
  document.querySelector('.mosaic-brush-option').hidden = mode !== 'brush';
  document.getElementById('tool-hint').textContent = ({
    square: '拖动创建方形磨砂玻璃区域',
    circle: '拖动创建圆形磨砂玻璃区域',
    brush: '按住鼠标自由涂抹像素马赛克',
  })[mode];
  render();
}

function commit(action) {
  actions.push(action);
  selectedMosaicIndex = action.type === 'mosaic' ? actions.length - 1 : -1;
  selectedVectorIndex = ['rect', 'ellipse', 'arrow'].includes(action.type) ? actions.length - 1 : -1;
  selectedEmojiIndex = action.type === 'emoji' ? actions.length - 1 : -1;
  redoStack.length = 0;
  draft = null;
  if (action.type === 'mosaic' && ['square', 'circle'].includes(action.mode)) {
    document.getElementById('tool-hint').textContent = `已选择${action.mode === 'square' ? '方形' : '圆形'}磨砂区域 · 可调模糊度、拖动位置或缩放范围`;
  }
  if (selectedVectorIndex >= 0) {
    const label = action.type === 'rect' ? '矩形' : action.type === 'ellipse' ? '椭圆' : '箭头';
    document.getElementById('tool-hint').textContent = action.type === 'rect'
      ? '已选择矩形 · 拖动蓝色圆点调整圆角'
      : action.type === 'arrow'
        ? '已选择箭头 · 可切换上方样式与线宽'
        : `已选择${label} · 可调整上方线宽`;
  }
  if (selectedEmojiIndex >= 0) {
    document.getElementById('tool-hint').textContent = `已添加 ${action.emoji} · 可拖动位置或调整大小`;
  }
  render();
}

function selectTool(tool) {
  mosaicTransform = null;
  rectRadiusTransform = null;
  const enteringMosaic = tool === 'mosaic' && activeTool !== 'mosaic';
  if (tool !== activeTool) {
    selectedMosaicIndex = -1;
    selectedVectorIndex = -1;
    selectedEmojiIndex = -1;
  }
  activeTool = tool;
  document.body.dataset.tool = tool;
  document.querySelectorAll('.tool-button[data-tool]').forEach((button) => button.classList.toggle('is-active', button.dataset.tool === tool));
  const isMosaic = tool === 'mosaic';
  const isText = tool === 'text';
  const isEmoji = tool === 'emoji';
  const isArrow = tool === 'arrow';
  document.getElementById('color-options').hidden = isMosaic || isEmoji;
  document.querySelector('.options-separator').hidden = isMosaic || isEmoji;
  document.querySelector('.standard-option').hidden = isMosaic || isText || isEmoji;
  document.querySelectorAll('.mosaic-option').forEach((element) => { element.hidden = !isMosaic; });
  document.querySelector('.text-option').hidden = !isText;
  document.querySelector('.emoji-option').hidden = !isEmoji;
  document.querySelector('.arrow-style-option').hidden = !isArrow;
  if (isMosaic) {
    if (enteringMosaic) activeMosaicMode = 'square';
    setMosaicMode(activeMosaicMode);
  } else {
    selectedMosaicIndex = -1;
    if (isArrow) setArrowStyle(activeArrowStyle, false);
    else document.getElementById('tool-hint').textContent = toolHints[tool];
  }
  canvas.style.cursor = isText ? 'text' : isEmoji ? 'copy' : 'crosshair';
  if (isText) document.getElementById('text-content').focus();
  render();
}

canvas.addEventListener('pointerdown', (event) => {
  if (!baseImage || event.button !== 0) return;
  const point = pointFromEvent(event);
  if (activeTool === 'text') {
    const text = document.getElementById('text-content').value.trim();
    if (!text) {
      showToast('请先输入要添加的文字');
      document.getElementById('text-content').focus();
      return;
    }
    commit({ type: 'text', point, text, color: activeColor, fontSize: Number(document.getElementById('text-size').value), strokeWidth: 0 });
    return;
  }
  if (activeTool === 'emoji') {
    const hitIndex = findEmojiAtPoint(point);
    if (hitIndex >= 0) {
      selectedEmojiIndex = hitIndex;
      selectedMosaicIndex = -1;
      selectedVectorIndex = -1;
      const action = actions[hitIndex];
      setActiveEmoji(action.emoji);
      document.getElementById('emoji-size').value = String(action.fontSize);
      document.getElementById('emoji-size-value').textContent = String(action.fontSize);
      activePointerId = event.pointerId;
      emojiDragOffset = { x: point.x - action.point.x, y: point.y - action.point.y };
      canvas.setPointerCapture(activePointerId);
      canvas.style.cursor = 'grabbing';
      document.getElementById('tool-hint').textContent = `已选择 ${action.emoji} · 拖动调整位置`;
      render();
      return;
    }
    if (!activeEmoji) {
      showToast('请先选择或粘贴一个 Emoji');
      document.getElementById('emoji-custom').focus();
      return;
    }
    commit({ type: 'emoji', point, emoji: activeEmoji, color: '', fontSize: Number(document.getElementById('emoji-size').value), strokeWidth: 0 });
    return;
  }

  if (activeTool === 'mosaic' && activeMosaicMode !== 'brush') {
    const selectedAction = actions[selectedMosaicIndex];
    const handle = mosaicHandleAtPoint(point, selectedAction);
    if (handle) {
      startMosaicTransform(event, point, selectedMosaicIndex, handle);
      canvas.style.cursor = mosaicCursor(handle);
      return;
    }
    const hitIndex = findMosaicAtPoint(point);
    if (hitIndex >= 0 && selectMosaicAction(hitIndex)) {
      startMosaicTransform(event, point, hitIndex, 'move');
      canvas.style.cursor = 'move';
      return;
    }
  }

  if (['rect', 'ellipse', 'arrow'].includes(activeTool)) {
    const selectedAction = actions[selectedVectorIndex];
    if (activeTool === 'rect' && selectedAction?.type === 'rect' && rectRadiusHandleAtPoint(point, selectedAction)) {
      startRectRadiusTransform(event, selectedAction);
      return;
    }
    const hitIndex = findVectorAtPoint(point, activeTool);
    if (hitIndex >= 0 && selectVectorAction(hitIndex)) return;
  }

  activePointerId = event.pointerId;
  canvas.setPointerCapture(activePointerId);
  if (activeTool === 'pen') draft = { type: 'pen', points: [point], color: activeColor, strokeWidth: strokeWidth() };
  else if (activeTool === 'mosaic' && activeMosaicMode === 'brush') draft = { type: 'mosaic', mode: 'brush', points: [point], brushSize: mosaicBrushSize(), pixelSize: mosaicPixelSize(), color: '', strokeWidth: 0 };
  else if (activeTool === 'mosaic') draft = { type: 'mosaic', mode: activeMosaicMode, start: point, end: point, pixelSize: mosaicPixelSize(), color: '', strokeWidth: 0 };
  else if (activeTool === 'rect') draft = { type: 'rect', start: point, end: point, cornerRadius: 0, color: activeColor, strokeWidth: strokeWidth() };
  else if (activeTool === 'arrow') draft = { type: 'arrow', start: point, end: point, arrowStyle: activeArrowStyle, color: activeColor, strokeWidth: strokeWidth() };
  else draft = { type: activeTool, start: point, end: point, color: activeColor, strokeWidth: strokeWidth() };
  render();
});

canvas.addEventListener('pointermove', (event) => {
  const point = pointFromEvent(event);
  if (activePointerId === null) {
    if (activeTool === 'mosaic' && activeMosaicMode !== 'brush') {
      const handle = mosaicHandleAtPoint(point, actions[selectedMosaicIndex]);
      canvas.style.cursor = handle ? mosaicCursor(handle) : findMosaicAtPoint(point) >= 0 ? 'move' : 'crosshair';
    } else if (activeTool === 'rect' && rectRadiusHandleAtPoint(point, actions[selectedVectorIndex])) {
      canvas.style.cursor = 'nwse-resize';
    } else if (['rect', 'ellipse', 'arrow'].includes(activeTool)) {
      canvas.style.cursor = findVectorAtPoint(point, activeTool) >= 0 ? 'pointer' : 'crosshair';
    }
    return;
  }
  if (event.pointerId !== activePointerId) return;
  if (mosaicTransform) {
    updateMosaicTransform(point);
    return;
  }
  if (rectRadiusTransform) {
    updateRectRadiusTransform(point);
    return;
  }
  if (emojiDragOffset && selectedEmojiIndex >= 0) {
    const action = actions[selectedEmojiIndex];
    const bounds = emojiBounds(action);
    action.point = {
      x: Math.max(bounds.width / 2, Math.min(canvas.width - bounds.width / 2, point.x - emojiDragOffset.x)),
      y: Math.max(bounds.height / 2, Math.min(canvas.height - bounds.height / 2, point.y - emojiDragOffset.y)),
    };
    render();
    return;
  }
  if (!draft) return;
  if (draft.points) {
    const previous = draft.points[draft.points.length - 1];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) > 1.5) draft.points.push(point);
  } else draft.end = point;
  render();
});

function finishPointer(event) {
  if (mosaicTransform && event.pointerId === activePointerId) {
    const action = actions[mosaicTransform.index];
    mosaicTransform = null;
    activePointerId = null;
    canvas.style.cursor = 'move';
    if (action) document.getElementById('tool-hint').textContent = `${action.mode === 'square' ? '方形' : '圆形'}磨砂范围已更新 · 可继续调整模糊度`;
    render();
    return;
  }
  if (rectRadiusTransform && event.pointerId === activePointerId) {
    rectRadiusTransform = null;
    activePointerId = null;
    canvas.style.cursor = 'nwse-resize';
    document.getElementById('tool-hint').textContent = '矩形圆角已更新 · 可继续拖动蓝色圆点调整';
    render();
    return;
  }
  if (emojiDragOffset && event.pointerId === activePointerId) {
    emojiDragOffset = null;
    activePointerId = null;
    canvas.style.cursor = 'copy';
    document.getElementById('tool-hint').textContent = 'Emoji 位置已更新 · 可继续调整大小';
    render();
    return;
  }
  if (!draft || event.pointerId !== activePointerId) return;
  const completed = draft;
  activePointerId = null;
  if (!completed.points && Math.hypot(completed.end.x - completed.start.x, completed.end.y - completed.start.y) < 3) {
    draft = null;
    render();
    return;
  }
  commit(completed);
}

canvas.addEventListener('pointerup', finishPointer);
canvas.addEventListener('pointercancel', () => { draft = null; mosaicTransform = null; rectRadiusTransform = null; emojiDragOffset = null; activePointerId = null; canvas.style.cursor = activeTool === 'emoji' ? 'copy' : 'crosshair'; render(); });

function setActiveEmoji(value, sourceButton = null) {
  const emoji = firstGrapheme(value);
  if (!emoji) return false;
  activeEmoji = emoji;
  document.getElementById('emoji-custom').value = emoji;
  document.querySelectorAll('[data-emoji]').forEach((button) => button.classList.toggle('is-active', button === sourceButton || button.dataset.emoji === emoji));
  document.querySelector('.emoji-tool-glyph').textContent = emoji;
  document.getElementById('tool-hint').textContent = `已选择 ${emoji} · 点击图片放置`;
  return true;
}

function setActiveColor(value, sourceButton = null, custom = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) return false;
  activeColor = normalized;
  document.querySelectorAll('.color-swatch').forEach((candidate) => candidate.classList.toggle('is-active', !custom && candidate === sourceButton));
  const picker = document.getElementById('custom-color-picker');
  const pickerControl = document.getElementById('custom-color-control');
  picker.value = normalized;
  pickerControl.style.setProperty('--picked-color', normalized);
  pickerControl.classList.toggle('is-active', custom);
  canvas.dataset.activeColor = normalized;
  const selected = actions[selectedVectorIndex];
  if (selected) {
    selected.color = activeColor;
    render();
  }
  return true;
}

document.querySelectorAll('.tool-button[data-tool]').forEach((button) => button.addEventListener('click', () => selectTool(button.dataset.tool)));
document.querySelectorAll('.color-swatch').forEach((button) => button.addEventListener('click', () => {
  setActiveColor(button.dataset.color, button);
}));
document.getElementById('custom-color-picker').addEventListener('input', (event) => setActiveColor(event.currentTarget.value, null, true));
document.querySelectorAll('[data-mosaic-mode]').forEach((button) => button.addEventListener('click', () => setMosaicMode(button.dataset.mosaicMode)));
document.querySelectorAll('[data-arrow-style]').forEach((button) => button.addEventListener('click', () => setArrowStyle(button.dataset.arrowStyle, true)));
document.querySelectorAll('[data-emoji]').forEach((button) => button.addEventListener('click', () => setActiveEmoji(button.dataset.emoji, button)));
document.getElementById('emoji-custom').addEventListener('input', (event) => {
  const emoji = firstGrapheme(event.currentTarget.value);
  if (!emoji) return;
  setActiveEmoji(emoji);
});

[['stroke-width', 'stroke-width-value'], ['mosaic-brush', 'mosaic-brush-value'], ['mosaic-pixel', 'mosaic-pixel-value'], ['text-size', 'text-size-value'], ['emoji-size', 'emoji-size-value']].forEach(([inputId, outputId]) => {
  const input = document.getElementById(inputId);
  input.addEventListener('input', () => { document.getElementById(outputId).textContent = input.value; });
});
document.getElementById('mosaic-pixel').addEventListener('input', (event) => {
  const selected = actions[selectedMosaicIndex];
  if (!selected || selected.type !== 'mosaic') return;
  selected.pixelSize = Number(event.currentTarget.value);
  const modeLabel = selected.mode === 'square' ? '方形磨砂' : selected.mode === 'circle' ? '圆形磨砂' : '像素笔刷';
  document.getElementById('tool-hint').textContent = `${modeLabel}模糊度 ${selected.pixelSize}`;
  render();
});
document.getElementById('stroke-width').addEventListener('input', (event) => {
  const selected = actions[selectedVectorIndex];
  if (!selected || !['rect', 'ellipse', 'arrow'].includes(selected.type)) return;
  selected.strokeWidth = Number(event.currentTarget.value);
  const label = selected.type === 'rect' ? '矩形' : selected.type === 'ellipse' ? '椭圆' : '箭头';
  document.getElementById('tool-hint').textContent = `${label}线宽 ${selected.strokeWidth}`;
  render();
});
document.getElementById('emoji-size').addEventListener('input', (event) => {
  const selected = actions[selectedEmojiIndex];
  if (!selected || selected.type !== 'emoji') return;
  selected.fontSize = Number(event.currentTarget.value);
  document.getElementById('tool-hint').textContent = `${selected.emoji} 大小 ${selected.fontSize}`;
  render();
});

document.getElementById('undo-editor').addEventListener('click', () => {
  if (!actions.length) return;
  redoStack.push(actions.pop());
  selectedMosaicIndex = actions.findLastIndex((action) => action.type === 'mosaic');
  selectedVectorIndex = actions.findLastIndex((action) => ['rect', 'ellipse', 'arrow'].includes(action.type));
  selectedEmojiIndex = actions.findLastIndex((action) => action.type === 'emoji');
  const lastIndex = Math.max(selectedMosaicIndex, selectedVectorIndex, selectedEmojiIndex);
  if (lastIndex === selectedMosaicIndex && selectedMosaicIndex >= 0) {
    selectedVectorIndex = -1;
    selectedEmojiIndex = -1;
    setMosaicMode(actions[selectedMosaicIndex].mode, true);
  } else if (lastIndex === selectedEmojiIndex && selectedEmojiIndex >= 0) {
    selectedMosaicIndex = -1;
    selectedVectorIndex = -1;
    const selected = actions[selectedEmojiIndex];
    document.getElementById('emoji-size').value = String(selected.fontSize);
    document.getElementById('emoji-size-value').textContent = String(selected.fontSize);
    render();
  } else {
    selectedMosaicIndex = -1;
    selectedEmojiIndex = -1;
    render();
  }
});
document.getElementById('redo-editor').addEventListener('click', () => {
  if (!redoStack.length) return;
  const restored = redoStack.pop();
  actions.push(restored);
  selectedMosaicIndex = restored.type === 'mosaic' ? actions.length - 1 : -1;
  selectedVectorIndex = ['rect', 'ellipse', 'arrow'].includes(restored.type) ? actions.length - 1 : -1;
  selectedEmojiIndex = restored.type === 'emoji' ? actions.length - 1 : -1;
  if (restored.type === 'mosaic') setMosaicMode(restored.mode, true);
  else {
    if (restored.type === 'emoji') {
      document.getElementById('emoji-size').value = String(restored.fontSize);
      document.getElementById('emoji-size-value').textContent = String(restored.fontSize);
    }
    render();
  }
});

function exportedImage() {
  draft = null;
  render(false);
  const dataUrl = canvas.toDataURL('image/png');
  render(true);
  return dataUrl;
}

document.getElementById('copy-editor').addEventListener('click', async () => {
  const copied = await editorBridge.copyEditedImage(exportedImage());
  showToast(copied ? '编辑后的图片已复制' : '剪贴板被占用，请重试');
});
document.getElementById('save-editor').addEventListener('click', async () => {
  const result = await editorBridge.saveEditedImage(exportedImage());
  if (result.saved) showToast('PNG 已保存');
});
document.getElementById('pin-editor').addEventListener('click', async () => {
  const button = document.getElementById('pin-editor');
  button.disabled = true;
  try {
    const result = await editorBridge.pinEditedImage({ dataUrl: exportedImage(), rect: inlineMode ? inlineRect : null });
    if (!result?.ok) throw new Error('固定失败');
    if (inlineMode) window.parent.postMessage({ type: 'editor:inline-pinned' }, '*');
    else await editorBridge.closeImageEditor();
  } catch {
    button.disabled = false;
    showToast('无法固定截图，请重试');
  }
});
document.getElementById('done-editor').addEventListener('click', async () => {
  const button = document.getElementById('done-editor');
  button.disabled = true;
  const copied = await editorBridge.copyEditedImage(exportedImage());
  if (copied) {
    if (inlineMode) window.parent.postMessage({ type: 'editor:inline-finish' }, '*');
    else await editorBridge.closeImageEditor();
  }
  else {
    button.disabled = false;
    showToast('剪贴板被占用，图片尚未复制');
  }
});
document.getElementById('close-editor').addEventListener('click', () => {
  if (inlineMode) window.parent.postMessage({ type: 'editor:inline-cancel' }, '*');
  else editorBridge.closeImageEditor();
});
document.getElementById('minimize-editor').addEventListener('click', () => editorBridge.windowControl('minimize'));
document.getElementById('cancel-inline-editor').addEventListener('click', () => window.parent.postMessage({ type: 'editor:inline-cancel' }, '*'));

document.addEventListener('keydown', (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  const editingInput = event.target instanceof HTMLTextAreaElement
    || (event.target instanceof HTMLInputElement && ['text', 'search', 'url', 'email', 'number', 'password'].includes(event.target.type));
  if (event.key === 'Enter' && !editingInput && !event.isComposing && !event.repeat) {
    event.preventDefault();
    document.getElementById('done-editor').click();
    return;
  }
  if (!editingInput && activeTool === 'emoji' && selectedEmojiIndex >= 0 && (event.key === 'Delete' || event.key === 'Backspace')) {
    event.preventDefault();
    const [removed] = actions.splice(selectedEmojiIndex, 1);
    if (removed) redoStack.push(removed);
    selectedEmojiIndex = -1;
    document.getElementById('tool-hint').textContent = 'Emoji 已删除 · 可撤销恢复';
    render();
    return;
  }
  if (modifier && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    document.getElementById(event.shiftKey ? 'redo-editor' : 'undo-editor').click();
  }
  if (modifier && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    document.getElementById('redo-editor').click();
  }
  if (modifier && event.key.toLowerCase() === 's') {
    event.preventDefault();
    document.getElementById('save-editor').click();
  }
  if (event.key === 'Escape') {
    if (inlineMode) window.parent.postMessage({ type: 'editor:inline-cancel' }, '*');
    else editorBridge.closeImageEditor();
  }
});

function loadEditorImage(dataUrl) {
  baseImage = null;
  canvas.removeAttribute('data-ready');
  context.clearRect(0, 0, canvas.width, canvas.height);
  document.getElementById('editor-empty').hidden = false;
  document.getElementById('done-editor').disabled = false;
  const image = new Image();
  image.onload = () => {
    baseImage = image;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    actions.length = 0;
    redoStack.length = 0;
    draft = null;
    mosaicTransform = null;
    emojiDragOffset = null;
    selectedMosaicIndex = -1;
    selectedVectorIndex = -1;
    selectedEmojiIndex = -1;
    selectTool('rect');
    canvas.dataset.ready = 'true';
    document.getElementById('image-size').textContent = `${image.naturalWidth} × ${image.naturalHeight} px`;
    document.getElementById('editor-empty').hidden = true;
    fitCanvas();
    render();
    if (completeWhenReady) {
      completeWhenReady = false;
      setTimeout(() => document.getElementById('done-editor').click(), 0);
    }
  };
  image.onerror = () => {
    document.querySelector('#editor-empty strong').textContent = '无法载入这张截图';
  };
  image.src = dataUrl;
}

if (inlineMode) {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    if (event.data?.type === 'editor:inline-init') {
      configureInlineLayout(event.data.rect);
      loadEditorImage(event.data.dataUrl);
    }
    if (event.data?.type === 'editor:inline-complete') {
      if (baseImage && canvas.dataset.ready === 'true') document.getElementById('done-editor').click();
      else completeWhenReady = true;
    }
    if (event.data?.type === 'editor:inline-reset') {
      finishInlineControlsDrag();
      baseImage = null;
      completeWhenReady = false;
      actions.length = 0;
      redoStack.length = 0;
      draft = null;
      mosaicTransform = null;
      canvas.removeAttribute('data-ready');
      context.clearRect(0, 0, canvas.width, canvas.height);
      document.getElementById('editor-empty').hidden = false;
      document.getElementById('done-editor').disabled = false;
    }
  });
} else {
  editorBridge.onEditorInit(({ dataUrl }) => loadEditorImage(dataUrl));
}

new ResizeObserver(fitCanvas).observe(stage);
selectTool('rect');
if (inlineMode) window.parent.postMessage({ type: 'editor:inline-ready' }, '*');
