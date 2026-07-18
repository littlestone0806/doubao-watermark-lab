'use strict';

const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const elements = {
  title: document.querySelector('#previewTitle'),
  meta: document.querySelector('#previewMeta'),
  stage: document.querySelector('#previewStage'),
  stack: document.querySelector('#compareStack'),
  image: document.querySelector('#previewImage'),
  sourceImage: document.querySelector('#sourceImage'),
  heatmapImage: document.querySelector('#heatmapImage'),
  divider: document.querySelector('#compareDivider'),
  compareToggle: document.querySelector('#compareToggle'),
  diffToggle: document.querySelector('#diffToggle'),
  diffBadge: document.querySelector('#diffBadge'),
  loading: document.querySelector('#previewLoading'),
  zoomOut: document.querySelector('#zoomOut'),
  zoomReset: document.querySelector('#zoomReset'),
  zoomIn: document.querySelector('#zoomIn'),
  zoomValue: document.querySelector('#zoomValue')
};

let zoom = 1;
let panX = 0;
let panY = 0;
let pointer = null;
// 对比模式状态：split 为分割线位置（占显示宽度的百分比）
let comparing = false;
let split = 50;
let splitPointer = null;
let sourceAvailable = false;
// 差异热力模式状态
let diffing = false;
let diffAvailable = false;
let qcStats = null;
let baseMeta = '';

function clampPan() {
  const imageWidth = elements.image.clientWidth * zoom;
  const imageHeight = elements.image.clientHeight * zoom;
  const maxX = Math.max(0, (imageWidth - elements.stage.clientWidth) / 2 + 14);
  const maxY = Math.max(0, (imageHeight - elements.stage.clientHeight) / 2 + 14);
  panX = Math.min(maxX, Math.max(-maxX, panX));
  panY = Math.min(maxY, Math.max(-maxY, panY));
}

function applyTransform() {
  clampPan();
  elements.stack.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
  elements.stack.classList.toggle('is-zoomed', zoom > 1);
  elements.zoomValue.textContent = zoom === 1 ? '适合' : `${Math.round(zoom * 100)}%`;
  elements.zoomOut.disabled = zoom <= ZOOM_LEVELS[0];
  elements.zoomIn.disabled = zoom >= ZOOM_LEVELS.at(-1);
}

function setZoom(value, anchorClientX, anchorClientY) {
  const nextZoom = Math.min(ZOOM_LEVELS.at(-1), Math.max(ZOOM_LEVELS[0], value));
  if (nextZoom === zoom) return;
  // 以锚点（通常是鼠标指针位置，未传入时为舞台中心）为中心缩放：
  // 缩放前后保持锚点下的图像点不动
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
  pointer = null;
  applyTransform();
}

// 初始即按舞台大小铺满显示（小图也放大到合适尺寸），缩放再以此为基础
function fitImageToStage() {
  const naturalWidth = elements.image.naturalWidth;
  const naturalHeight = elements.image.naturalHeight;
  if (!naturalWidth || !naturalHeight) return;
  const stageWidth = Math.max(1, elements.stage.clientWidth - 28);
  const stageHeight = Math.max(1, elements.stage.clientHeight - 28);
  const fit = Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight);
  elements.image.style.width = `${Math.max(1, Math.round(naturalWidth * fit))}px`;
}

function applySplit() {
  split = Math.min(98, Math.max(2, split));
  elements.stack.style.setProperty('--split', `${split}%`);
}

function setCompare(enabled) {
  if (enabled && !sourceAvailable) return;
  if (enabled) setDiff(false);
  comparing = enabled;
  elements.compareToggle.classList.toggle('is-active', comparing);
  elements.sourceImage.classList.toggle('is-hidden', !comparing);
  elements.divider.classList.toggle('is-hidden', !comparing);
  for (const badge of elements.stack.querySelectorAll('.compare-badge:not(.badge-diff)')) {
    badge.classList.toggle('is-hidden', !comparing);
  }
}

function setDiff(enabled) {
  if (enabled && !diffAvailable) return;
  if (enabled) setCompare(false);
  diffing = enabled;
  elements.diffToggle.classList.toggle('is-active', diffing);
  elements.heatmapImage.classList.toggle('is-hidden', !diffing);
  elements.diffBadge.classList.toggle('is-hidden', !diffing);
  // 差异模式下副标题显示质检统计
  elements.meta.textContent = diffing && qcStats
    ? `${baseMeta} · 变化像素 ${(qcStats.changedRatio * 100).toFixed(1)}%`
    : baseMeta;
}

window.previewBridge.onLoad((preview) => {
  document.title = `预览 · ${preview.name}`;
  elements.title.textContent = preview.name;
  baseMeta = `${preview.width} × ${preview.height}`;
  elements.meta.textContent = baseMeta;
  elements.loading.classList.remove('is-hidden');
  elements.stack.classList.add('is-hidden');
  // 原图数据随结果一起下发（可能为空：原图被移动或删除时不可对比）
  sourceAvailable = Boolean(preview.source?.dataUrl);
  setCompare(false);
  split = 50;
  applySplit();
  elements.compareToggle.classList.toggle('is-hidden', !sourceAvailable);
  // 质检数据：有热力图时开放"差异热力"开关，异常结论给按钮加警示色
  qcStats = preview.qc || null;
  diffAvailable = Boolean(preview.qc?.heatmap?.dataUrl);
  setDiff(false);
  elements.diffToggle.classList.toggle('is-hidden', !diffAvailable);
  elements.diffToggle.classList.toggle('is-warning', diffAvailable && preview.qc.verdict !== 'ok');
  if (diffAvailable) {
    elements.heatmapImage.src = preview.qc.heatmap.dataUrl;
  } else {
    elements.heatmapImage.removeAttribute('src');
  }
  elements.image.onload = () => {
    elements.loading.classList.add('is-hidden');
    elements.stack.classList.remove('is-hidden');
    fitImageToStage();
    requestAnimationFrame(resetView);
  };
  elements.image.src = preview.dataUrl;
  if (sourceAvailable) {
    elements.sourceImage.src = preview.source.dataUrl;
    elements.sourceImage.alt = `原图 · ${preview.source.width} × ${preview.source.height}`;
  } else {
    elements.sourceImage.removeAttribute('src');
  }
});

elements.compareToggle.addEventListener('click', () => setCompare(!comparing));
elements.diffToggle.addEventListener('click', () => setDiff(!diffing));

// 拖动分割线调整原图/结果占比
elements.divider.addEventListener('pointerdown', (event) => {
  event.stopPropagation();
  splitPointer = event.pointerId;
  elements.divider.setPointerCapture(event.pointerId);
});
elements.divider.addEventListener('pointermove', (event) => {
  if (splitPointer !== event.pointerId) return;
  const rect = elements.stack.getBoundingClientRect();
  if (!rect.width) return;
  split = ((event.clientX - rect.left) / rect.width) * 100;
  applySplit();
});
const endSplitDrag = (event) => {
  if (splitPointer === event.pointerId) splitPointer = null;
};
elements.divider.addEventListener('pointerup', endSplitDrag);
elements.divider.addEventListener('pointercancel', endSplitDrag);

elements.zoomOut.addEventListener('click', () => stepZoom(-1));
elements.zoomIn.addEventListener('click', () => stepZoom(1));
elements.zoomReset.addEventListener('click', resetView);
elements.stage.addEventListener('dblclick', (event) => setZoom(zoom === 1 ? 2 : 1, event.clientX, event.clientY));
elements.stage.addEventListener('wheel', (event) => {
  event.preventDefault();
  if (event.metaKey || event.ctrlKey) {
    stepZoom(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY);
  } else if (zoom > 1) {
    panX -= event.deltaX;
    panY -= event.deltaY;
    applyTransform();
  }
}, { passive: false });
elements.stack.addEventListener('pointerdown', (event) => {
  if (zoom <= 1) return;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  elements.stack.setPointerCapture(event.pointerId);
  elements.stack.classList.add('is-dragging');
});
elements.stack.addEventListener('pointermove', (event) => {
  if (!pointer || pointer.id !== event.pointerId) return;
  panX += event.clientX - pointer.x;
  panY += event.clientY - pointer.y;
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  applyTransform();
});
function endDrag(event) {
  if (!pointer || pointer.id !== event.pointerId) return;
  pointer = null;
  elements.stack.classList.remove('is-dragging');
}
elements.stack.addEventListener('pointerup', endDrag);
elements.stack.addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => {
  fitImageToStage();
  applyTransform();
});
document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    stepZoom(1);
  } else if (event.key === '-') {
    event.preventDefault();
    stepZoom(-1);
  } else if (event.key === '0') {
    event.preventDefault();
    resetView();
  }
});
