'use strict';

const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const elements = {
  title: document.querySelector('#previewTitle'),
  meta: document.querySelector('#previewMeta'),
  stage: document.querySelector('#previewStage'),
  image: document.querySelector('#previewImage'),
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
  elements.image.style.transform = `translate3d(${panX}px, ${panY}px, 0) scale(${zoom})`;
  elements.image.classList.toggle('is-zoomed', zoom > 1);
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

window.previewBridge.onLoad((preview) => {
  document.title = `预览 · ${preview.name}`;
  elements.title.textContent = preview.name;
  elements.meta.textContent = `${preview.width} × ${preview.height}`;
  elements.loading.classList.remove('is-hidden');
  elements.image.classList.add('is-hidden');
  elements.image.onload = () => {
    elements.loading.classList.add('is-hidden');
    elements.image.classList.remove('is-hidden');
    fitImageToStage();
    requestAnimationFrame(resetView);
  };
  elements.image.src = preview.dataUrl;
});

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
elements.image.addEventListener('pointerdown', (event) => {
  if (zoom <= 1) return;
  pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  elements.image.setPointerCapture(event.pointerId);
  elements.image.classList.add('is-dragging');
});
elements.image.addEventListener('pointermove', (event) => {
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
  elements.image.classList.remove('is-dragging');
}
elements.image.addEventListener('pointerup', endDrag);
elements.image.addEventListener('pointercancel', endDrag);
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
