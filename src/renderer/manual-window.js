'use strict';

const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const elements = {
  title: document.querySelector('#manualTitle'),
  meta: document.querySelector('#manualMeta'),
  stage: document.querySelector('#manualStage'),
  loading: document.querySelector('#manualLoading'),
  canvas: document.querySelector('#manualCanvas'),
  brushCursor: document.querySelector('#manualBrushCursor'),
  brushSize: document.querySelector('#manualBrushSize'),
  brushSizeValue: document.querySelector('#manualBrushSizeValue'),
  undo: document.querySelector('#manualUndo'),
  clear: document.querySelector('#manualClear'),
  cancel: document.querySelector('#manualCancel'),
  send: document.querySelector('#manualSend')
};

let sourceFile = null;
let baseImage = null;
let strokes = [];
let activeStroke = null;
let pointerId = null;
let cursorPosition = { x: 0.5, y: 0.5 };
let zoom = 1;
let panX = 0;
let panY = 0;
let spaceHeld = false;
let panPointer = null;

function updateBrushCursor() {
  const canvas = elements.canvas;
  if (!baseImage || canvas.classList.contains('is-hidden')) {
    elements.brushCursor.classList.add('is-hidden');
    return;
  }
  const stageRectangle = elements.stage.getBoundingClientRect();
  const canvasRectangle = canvas.getBoundingClientRect();
  const brushPercent = Number(elements.brushSize.value) || 3;
  const diameter = Math.max(2, Math.min(canvasRectangle.width, canvasRectangle.height) * brushPercent / 100);
  elements.brushCursor.style.width = `${diameter}px`;
  elements.brushCursor.style.height = `${diameter}px`;
  elements.brushCursor.style.left = `${canvasRectangle.left - stageRectangle.left + cursorPosition.x * canvasRectangle.width}px`;
  elements.brushCursor.style.top = `${canvasRectangle.top - stageRectangle.top + cursorPosition.y * canvasRectangle.height}px`;
  elements.brushCursor.classList.remove('is-hidden');
}

function updateControls() {
  const hasStrokes = strokes.length > 0;
  elements.undo.disabled = !hasStrokes;
  elements.clear.disabled = !hasStrokes;
  elements.send.disabled = !hasStrokes;
  const brushValue = Number(elements.brushSize.value) || 3;
  elements.brushSizeValue.value = `${brushValue.toFixed(brushValue % 1 ? 1 : 0)}%`;
  elements.brushSizeValue.textContent = elements.brushSizeValue.value;
}

function redrawCanvas() {
  const canvas = elements.canvas;
  const context = canvas.getContext('2d');
  if (!context || !baseImage) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
  const brushWidth = Math.min(canvas.width, canvas.height) * (Number(elements.brushSize.value) || 3) / 100;
  context.strokeStyle = 'rgba(255, 45, 143, .58)';
  context.fillStyle = 'rgba(255, 45, 143, .58)';
  context.lineWidth = brushWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    if (!stroke.length) continue;
    if (stroke.length === 1) {
      context.beginPath();
      context.arc(stroke[0].x * canvas.width, stroke[0].y * canvas.height, brushWidth / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.beginPath();
    context.moveTo(stroke[0].x * canvas.width, stroke[0].y * canvas.height);
    for (const point of stroke.slice(1)) context.lineTo(point.x * canvas.width, point.y * canvas.height);
    context.stroke();
  }
  updateControls();
  updateBrushCursor();
}

function clampPan() {
  const canvas = elements.canvas;
  const imageWidth = canvas.clientWidth * zoom;
  const imageHeight = canvas.clientHeight * zoom;
  const maxX = Math.max(0, (imageWidth - elements.stage.clientWidth) / 2 + 16);
  const maxY = Math.max(0, (imageHeight - elements.stage.clientHeight) / 2 + 16);
  panX = Math.min(maxX, Math.max(-maxX, panX));
  panY = Math.min(maxY, Math.max(-maxY, panY));
}

function applyTransform() {
  clampPan();
  elements.canvas.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
  updateBrushCursor();
}

function setZoom(value, anchorClientX, anchorClientY) {
  const nextZoom = Math.min(ZOOM_LEVELS.at(-1), Math.max(ZOOM_LEVELS[0], value));
  if (nextZoom === zoom) return;
  // 以锚点（通常是鼠标指针位置，未传入时为舞台中心）为中心缩放
  const stageRectangle = elements.stage.getBoundingClientRect();
  const anchorX = (typeof anchorClientX === 'number' ? anchorClientX : stageRectangle.left + stageRectangle.width / 2)
    - (stageRectangle.left + stageRectangle.width / 2);
  const anchorY = (typeof anchorClientY === 'number' ? anchorClientY : stageRectangle.top + stageRectangle.height / 2)
    - (stageRectangle.top + stageRectangle.height / 2);
  const ratio = nextZoom / zoom;
  panX = panX * ratio + anchorX * (1 - ratio);
  panY = panY * ratio + anchorY * (1 - ratio);
  zoom = nextZoom;
  if (zoom <= 1) {
    panX = 0;
    panY = 0;
  }
  applyTransform();
}

function stepZoom(direction, anchorClientX, anchorClientY) {
  const next = direction > 0
    ? ZOOM_LEVELS.find((level) => level > zoom + 0.001)
    : [...ZOOM_LEVELS].reverse().find((level) => level < zoom - 0.001);
  if (next) setZoom(next, anchorClientX, anchorClientY);
}

function resetView() {
  zoom = 1;
  panX = 0;
  panY = 0;
  panPointer = null;
  spaceHeld = false;
  elements.canvas.classList.remove('is-panning');
  elements.canvas.style.transform = '';
}

function canvasPoint(event) {
  const rectangle = elements.canvas.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - rectangle.left) / Math.max(1, rectangle.width))),
    y: Math.min(1, Math.max(0, (event.clientY - rectangle.top) / Math.max(1, rectangle.height)))
  };
}

async function loadSource(file) {
  sourceFile = file;
  baseImage = null;
  strokes = [];
  activeStroke = null;
  cursorPosition = { x: 0.5, y: 0.5 };
  resetView();
  document.title = `手动涂抹 · ${file.name}`;
  elements.title.textContent = `手动涂抹 · ${file.name}`;
  elements.meta.textContent = '请在原图上覆盖需要豆包重新处理的位置';
  elements.loading.textContent = '正在载入原图…';
  elements.loading.classList.remove('is-hidden');
  elements.canvas.classList.add('is-hidden');
  elements.brushCursor.classList.add('is-hidden');
  updateControls();
  try {
    const preview = await window.manualBridge.getImagePreview(file.path);
    if (sourceFile !== file) return;
    const image = new Image();
    image.onload = () => {
      if (sourceFile !== file) return;
      baseImage = image;
      elements.canvas.width = image.naturalWidth;
      elements.canvas.height = image.naturalHeight;
      elements.meta.textContent = `原图 ${preview.width} × ${preview.height} · 涂抹轨迹会按原始分辨率发送`;
      elements.loading.classList.add('is-hidden');
      elements.canvas.classList.remove('is-hidden');
      redrawCanvas();
      requestAnimationFrame(updateBrushCursor);
    };
    image.onerror = () => {
      elements.loading.textContent = '原图载入失败，请关闭窗口重试';
    };
    image.src = preview.dataUrl;
  } catch (error) {
    elements.loading.textContent = error.message || String(error);
  }
}

function submitStrokes() {
  if (!sourceFile || !strokes.length) return;
  elements.send.disabled = true;
  elements.send.textContent = '正在发送…';
  window.manualBridge.submit({
    sourcePath: sourceFile.path,
    strokes: strokes.map((stroke) => stroke.map((point) => ({ x: point.x, y: point.y }))),
    brushPercent: Number(elements.brushSize.value) || 3
  });
  window.manualBridge.close();
}

window.manualBridge.onLoad((file) => { loadSource(file); });

elements.brushSize.addEventListener('input', redrawCanvas);
elements.undo.addEventListener('click', () => {
  strokes.pop();
  redrawCanvas();
});
elements.clear.addEventListener('click', () => {
  strokes = [];
  activeStroke = null;
  redrawCanvas();
});
elements.cancel.addEventListener('click', () => window.manualBridge.close());
elements.send.addEventListener('click', submitStrokes);

elements.canvas.addEventListener('pointerdown', (event) => {
  if (!baseImage || event.button !== 0) return;
  event.preventDefault();
  if (spaceHeld) {
    panPointer = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX,
      panY
    };
    elements.canvas.setPointerCapture(event.pointerId);
    return;
  }
  pointerId = event.pointerId;
  cursorPosition = canvasPoint(event);
  activeStroke = [cursorPosition];
  strokes.push(activeStroke);
  elements.canvas.setPointerCapture(event.pointerId);
  elements.brushCursor.classList.add('is-painting');
  redrawCanvas();
});
elements.canvas.addEventListener('pointermove', (event) => {
  if (panPointer && event.pointerId === panPointer.pointerId) {
    panX = panPointer.panX + (event.clientX - panPointer.startX);
    panY = panPointer.panY + (event.clientY - panPointer.startY);
    applyTransform();
    return;
  }
  const point = canvasPoint(event);
  cursorPosition = point;
  updateBrushCursor();
  if (pointerId !== event.pointerId || !activeStroke) return;
  const previous = activeStroke.at(-1);
  if (Math.hypot(point.x - previous.x, point.y - previous.y) < 0.0015) return;
  activeStroke.push(point);
  redrawCanvas();
});
elements.canvas.addEventListener('pointerenter', (event) => {
  if (!baseImage) return;
  cursorPosition = canvasPoint(event);
  updateBrushCursor();
});
function endStroke(event) {
  if (panPointer && event.pointerId === panPointer.pointerId) {
    panPointer = null;
    return;
  }
  if (pointerId !== event.pointerId) return;
  pointerId = null;
  activeStroke = null;
  elements.brushCursor.classList.remove('is-painting');
  updateControls();
}
elements.canvas.addEventListener('pointerup', endStroke);
elements.canvas.addEventListener('pointercancel', endStroke);

elements.stage.addEventListener('wheel', (event) => {
  if (!baseImage) return;
  event.preventDefault();
  if (event.metaKey || event.ctrlKey) {
    stepZoom(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY);
    return;
  }
  if (zoom > 1) {
    panX -= event.deltaX;
    panY -= event.deltaY;
    applyTransform();
  }
}, { passive: false });

window.addEventListener('resize', applyTransform);

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey) {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      stepZoom(1);
      return;
    }
    if (event.key === '-') {
      event.preventDefault();
      stepZoom(-1);
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      resetView();
      return;
    }
  }
  if (event.code === 'Space' && !event.repeat
      && !(event.target instanceof HTMLInputElement)
      && !(event.target instanceof HTMLTextAreaElement)) {
    event.preventDefault();
    if (!spaceHeld) {
      spaceHeld = true;
      elements.canvas.classList.add('is-panning');
      elements.brushCursor.classList.add('is-hidden');
    }
    return;
  }
  if (event.key === 'Escape') window.manualBridge.close();
});
document.addEventListener('keyup', (event) => {
  if (event.code !== 'Space' || !spaceHeld) return;
  spaceHeld = false;
  panPointer = null;
  elements.canvas.classList.remove('is-panning');
  updateBrushCursor();
});
