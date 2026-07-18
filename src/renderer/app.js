'use strict';

const api = window.watermarkLab;
const state = {
  files: [],
  running: false,
  loggedIn: false,
  settings: null,
  activeBatches: new Set(),
  queueReady: false
};

const elements = {
  loginPill: document.querySelector('#loginPill'),
  loginText: document.querySelector('#loginText'),
  loginButton: document.querySelector('#loginButton'),
  loginButtonText: document.querySelector('#loginButtonText'),
  logoutButton: document.querySelector('#logoutButton'),
  dropZone: document.querySelector('#dropZone'),
  emptyState: document.querySelector('#emptyState'),
  queueList: document.querySelector('#queueList'),
  queueListToolbar: document.querySelector('#queueListToolbar'),
  queueCount: document.querySelector('#queueCount'),
  clearButton: document.querySelector('#clearButton'),
  selectAllCheckbox: document.querySelector('#selectAllCheckbox'),
  intervalSeconds: document.querySelector('#intervalSeconds'),
  imageWaitSeconds: document.querySelector('#imageWaitSeconds'),
  parallelProcessing: document.querySelector('#parallelProcessing'),
  maxConcurrentControl: document.querySelector('#maxConcurrentControl'),
  maxConcurrentTasks: document.querySelector('#maxConcurrentTasks'),
  strategySummaryText: document.querySelector('#strategySummaryText'),
  advancedSettingsButton: document.querySelector('#advancedSettingsButton'),
  showBrowserWindow: document.querySelector('#showBrowserWindow'),
  themeModeButtons: [...document.querySelectorAll('[data-theme-mode]')],
  paletteButtons: [...document.querySelectorAll('[data-palette]')],
  themeColor: document.querySelector('#themeColor'),
  themeColorValue: document.querySelector('#themeColorValue'),
  customColorControl: document.querySelector('#customColorControl'),
  appearanceToggle: document.querySelector('#appearanceToggle'),
  appearanceColors: document.querySelector('#appearanceColors'),
  outputButton: document.querySelector('#outputButton'),
  outputPath: document.querySelector('#outputPath'),
  openOutputButton: document.querySelector('#openOutputButton'),
  cancelButton: document.querySelector('#cancelButton'),
  startButton: document.querySelector('#startButton'),
  startCount: document.querySelector('#startCount'),
  previewModal: document.querySelector('#previewModal'),
  previewBackdrop: document.querySelector('#previewBackdrop'),
  previewTitle: document.querySelector('#previewTitle'),
  previewMeta: document.querySelector('#previewMeta'),
  previewClose: document.querySelector('#previewClose'),
  previewLoading: document.querySelector('#previewLoading'),
  previewImage: document.querySelector('#previewImage'),
  previewStage: document.querySelector('#previewStage'),
  previewZoomOut: document.querySelector('#previewZoomOut'),
  previewZoomReset: document.querySelector('#previewZoomReset'),
  previewZoomIn: document.querySelector('#previewZoomIn'),
  previewZoomValue: document.querySelector('#previewZoomValue'),
  toastRegion: document.querySelector('#toastRegion'),
  thumbPopover: document.querySelector('#thumbPopover'),
  thumbPopoverImage: document.querySelector('#thumbPopoverImage')
};

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatPercent(value) {
  const number = Number(value) || 0;
  return `${Number.isInteger(number) ? number : number.toFixed(1)}%`;
}

function toast(message, type = 'info') {
  const item = document.createElement('div');
  item.className = `toast ${type === 'error' ? 'error' : ''}`;
  item.textContent = message;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 4600);
}

function readSettings() {
  return {
    ...state.settings,
    outputDirectory: state.settings.outputDirectory,
    showBrowserWindow: elements.showBrowserWindow.checked,
    intervalSeconds: Math.min(600, Math.max(0, Math.round(Number(elements.intervalSeconds.value) || 0))),
    imageWaitSeconds: Math.min(300, Math.max(5, Math.round(Number(elements.imageWaitSeconds.value) || 60))),
    parallelProcessing: elements.parallelProcessing.checked,
    maxConcurrentTasks: Math.min(8, Math.max(1, Math.round(Number(elements.maxConcurrentTasks.value) || 3)))
  };
}

let saveTimer;
function scheduleSettingsSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!state.settings) return;
    state.settings = await api.saveSettings(readSettings());
  }, 450);
}

function applySettings(settings) {
  state.settings = settings;
  applyAppearance(settings);
  elements.showBrowserWindow.checked = settings.showBrowserWindow;
  elements.intervalSeconds.value = String(settings.intervalSeconds ?? 30);
  elements.imageWaitSeconds.value = String(settings.imageWaitSeconds ?? 60);
  elements.parallelProcessing.checked = settings.parallelProcessing === true;
  elements.maxConcurrentTasks.value = String(settings.maxConcurrentTasks ?? 3);
  syncProcessingControls();
  elements.outputPath.textContent = settings.outputDirectory;
  elements.outputPath.title = settings.outputDirectory;
  const edgeName = settings.cropEdge === 'bottom' ? '底部' : '顶部';
  elements.strategySummaryText.textContent = `${edgeName}添加 ${formatPercent(settings.cropPercent)} 临时隔离带，白边补偿 ${formatPercent(settings.cropCompensationPercent)}。`;
}

const PRESET_COLORS = Object.freeze({
  forest: '#246b55',
  ocean: '#28739a',
  violet: '#745ca7',
  sunset: '#b9663e',
  graphite: '#53636a'
});

function themeColorParts(value) {
  const hex = /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : PRESET_COLORS.forest;
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  const darken = (channel) => Math.round(channel * 0.68).toString(16).padStart(2, '0');
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return {
    hex,
    rgb: `${red}, ${green}, ${blue}`,
    deep: `#${darken(red)}${darken(green)}${darken(blue)}`,
    contrast: luminance > 0.68 ? '#14201b' : '#f7fffb'
  };
}

function applyAppearance(settings) {
  const root = document.documentElement;
  const color = themeColorParts(settings.themeColor || PRESET_COLORS[settings.colorPalette]);
  root.dataset.theme = settings.themeMode || 'auto';
  root.dataset.palette = settings.colorPalette || 'forest';
  root.style.setProperty('--accent', color.hex);
  root.style.setProperty('--accent-deep', color.deep);
  root.style.setProperty('--accent-rgb', color.rgb);
  root.style.setProperty('--accent-contrast', color.contrast);
  elements.themeColor.value = color.hex;
  elements.themeColorValue.value = color.hex.toUpperCase();
  elements.themeColorValue.textContent = color.hex.toUpperCase();
  const customActive = settings.colorPalette === 'custom';
  elements.customColorControl.classList.toggle('is-active', customActive);
  elements.themeModeButtons.forEach((button) => {
    const active = button.dataset.themeMode === settings.themeMode;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  elements.paletteButtons.forEach((button) => {
    const active = button.dataset.palette === settings.colorPalette;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
let previewRequest = 0;
let previewZoom = 1;
let previewPanX = 0;
let previewPanY = 0;
let previewPointer = null;

function clampPreviewPan() {
  const imageWidth = elements.previewImage.clientWidth * previewZoom;
  const imageHeight = elements.previewImage.clientHeight * previewZoom;
  const maxX = Math.max(0, (imageWidth - elements.previewStage.clientWidth) / 2 + 16);
  const maxY = Math.max(0, (imageHeight - elements.previewStage.clientHeight) / 2 + 16);
  previewPanX = Math.min(maxX, Math.max(-maxX, previewPanX));
  previewPanY = Math.min(maxY, Math.max(-maxY, previewPanY));
}

function applyPreviewTransform() {
  clampPreviewPan();
  elements.previewImage.style.transform = `translate3d(${previewPanX}px, ${previewPanY}px, 0) scale(${previewZoom})`;
  elements.previewImage.classList.toggle('is-zoomed', previewZoom > 1);
  elements.previewZoomValue.textContent = previewZoom === 1 ? '适合' : `${Math.round(previewZoom * 100)}%`;
  elements.previewZoomOut.disabled = previewZoom <= ZOOM_LEVELS[0];
  elements.previewZoomIn.disabled = previewZoom >= ZOOM_LEVELS.at(-1);
}

function setPreviewZoom(value, anchorClientX, anchorClientY) {
  const nextZoom = Math.min(ZOOM_LEVELS.at(-1), Math.max(ZOOM_LEVELS[0], value));
  if (nextZoom === previewZoom) return;
  // 以锚点（通常是鼠标指针位置，未传入时为舞台中心）为中心缩放：
  // 缩放前后保持锚点下的图像点不动
  const stageRectangle = elements.previewStage.getBoundingClientRect();
  const anchorX = (typeof anchorClientX === 'number' ? anchorClientX : stageRectangle.left + stageRectangle.width / 2)
    - (stageRectangle.left + stageRectangle.width / 2);
  const anchorY = (typeof anchorClientY === 'number' ? anchorClientY : stageRectangle.top + stageRectangle.height / 2)
    - (stageRectangle.top + stageRectangle.height / 2);
  const ratio = nextZoom / previewZoom;
  previewPanX = previewPanX * ratio + anchorX * (1 - ratio);
  previewPanY = previewPanY * ratio + anchorY * (1 - ratio);
  previewZoom = nextZoom;
  if (previewZoom <= 1) {
    previewPanX = 0;
    previewPanY = 0;
  }
  applyPreviewTransform();
}

function stepPreviewZoom(direction, anchorClientX, anchorClientY) {
  const next = direction > 0
    ? ZOOM_LEVELS.find((level) => level > previewZoom + 0.001)
    : [...ZOOM_LEVELS].reverse().find((level) => level < previewZoom - 0.001);
  if (next) setPreviewZoom(next, anchorClientX, anchorClientY);
}

function resetPreviewView() {
  previewZoom = 1;
  previewPanX = 0;
  previewPanY = 0;
  previewPointer = null;
  applyPreviewTransform();
}

function closePreview() {
  previewRequest += 1;
  if (elements.previewModal.contains(document.activeElement)) document.activeElement.blur();
  elements.previewModal.classList.add('is-hidden');
  elements.previewModal.setAttribute('aria-hidden', 'true');
  elements.previewImage.classList.add('is-hidden');
  elements.previewImage.removeAttribute('src');
  elements.previewImage.removeAttribute('style');
  resetPreviewView();
}

async function openPreview(file) {
  if (!file.outputPath) return;
  try {
    await api.openPreviewWindow(file.outputPath);
  } catch (error) {
    toast(error.message || String(error), 'error');
  }
}

async function openManualEditor(file) {
  try {
    await api.openManualWindow({ path: file.path, name: file.name });
  } catch (error) {
    toast(error.message || String(error), 'error');
  }
}

async function startBatchForFiles(files) {
  const settings = readSettings();
  state.settings = await api.saveSettings(settings);
  try {
    await api.startBatch({
      paths: files.map((file) => ({ path: file.path, conversationId: file.conversationId || '' })),
      settings: state.settings
    });
  } catch (error) {
    files.forEach((file) => { file.regenRequested = false; });
    if (state.activeBatches.size) renderQueue();
    else setRunning(false);
    toast(error.message || String(error), 'error');
  }
}

// 单张重新生成：效果等同于只勾选这一张再点“开始批量处理”。
// 其他任务正在运行时点击会立即并发执行（同时处理的任务数由设置决定）。
async function regenerateFile(file) {
  if (file.missing || file.regenRequested || file.status === 'active') return;
  const maxConcurrent = state.settings?.maxConcurrentTasks || 3;
  if (state.activeBatches.size >= maxConcurrent) {
    toast(`最多同时处理 ${maxConcurrent} 张图片，请等待其中一张完成`, 'error');
    return;
  }
  updateFile(file.path, { regenRequested: true });
  await startBatchForFiles([file]);
}

async function handleManualSubmitted(payload = {}) {
  const sourcePath = typeof payload.sourcePath === 'string' ? payload.sourcePath : '';
  const strokes = Array.isArray(payload.strokes) ? payload.strokes : [];
  if (!sourcePath || !strokes.length) return;
  const maxConcurrent = state.settings?.maxConcurrentTasks || 3;
  if (state.activeBatches.size >= maxConcurrent) {
    toast(`最多同时处理 ${maxConcurrent} 张图片，请等待其中一张完成`, 'error');
    return;
  }
  const file = state.files.find((item) => item.path === sourcePath);
  setRunning(true);
  if (file) updateFile(file.path, { status: 'active', message: '正在生成涂抹标记', progress: 5 });
  try {
    await api.startManualEdit({
      sourcePath,
      strokes,
      brushPercent: Number(payload.brushPercent) || 3,
      conversationId: file?.conversationId || '',
      settings: readSettings()
    });
  } catch (error) {
    if (state.activeBatches.size) renderQueue();
    else setRunning(false);
    if (file) updateFile(file.path, { status: file.outputPath ? 'complete' : 'error', message: '' });
    toast(error.message || String(error), 'error');
  }
}

function progressForMessage(message, current = 0) {
  const text = String(message || '');
  const resourceMatch = text.match(/(\d+)\s*\/\s*(\d+)/);
  let progress = current;
  if (/准备处理/.test(text)) progress = 5;
  else if (/创建新对话/.test(text)) progress = 9;
  else if (/临时空白|添加.*空白/.test(text)) progress = 14;
  else if (/上传原图/.test(text)) progress = 24;
  else if (/填写处理指令/.test(text)) progress = 34;
  else if (/安全验证/.test(text)) progress = Math.max(current, 42);
  else if (/重绘图片/.test(text)) progress = 56;
  else if (resourceMatch) progress = 68 + Math.round((Number(resourceMatch[1]) / Math.max(1, Number(resourceMatch[2]))) * 14);
  else if (/原生保存|下载/.test(text)) progress = 84;
  else if (/高清预览|高清画布|生成结果画布/.test(text)) progress = 90;
  return Math.min(96, Math.max(current, progress));
}

function syncProcessingControls() {
  elements.parallelProcessing.disabled = state.running;
  elements.imageWaitSeconds.disabled = state.running;
  elements.intervalSeconds.disabled = state.running || elements.parallelProcessing.checked;
  elements.maxConcurrentControl.classList.toggle('is-hidden', !elements.parallelProcessing.checked);
  elements.maxConcurrentTasks.disabled = state.running || !elements.parallelProcessing.checked;
}

function syncActionState() {
  const selectedCount = state.files.filter((file) => file.selected !== false).length;
  elements.queueCount.textContent = `${state.files.length} 张`;
  elements.startCount.textContent = String(selectedCount);
  elements.startButton.disabled = state.running || !selectedCount || !state.loggedIn;
  elements.clearButton.disabled = state.running || !state.files.length;
  elements.dropZone.disabled = state.running;
  elements.selectAllCheckbox.disabled = state.running || !state.files.length;
  elements.selectAllCheckbox.checked = selectedCount > 0 && selectedCount === state.files.length;
  elements.selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < state.files.length;
  syncProcessingControls();
  elements.cancelButton.classList.toggle('is-hidden', !state.running);
  elements.startButton.classList.toggle('is-hidden', state.running);
  elements.emptyState.classList.toggle('is-hidden', state.files.length > 0);
  elements.queueListToolbar.classList.toggle('is-hidden', state.files.length === 0);
}

// 悬停原图缩略图时展示的放大气泡；预览图按路径缓存，最多保留 30 张
const thumbPreviewCache = new Map();
let thumbHoverToken = 0;
let thumbHoverTimer = 0;

function positionThumbPopover(anchor) {
  const rect = anchor.getBoundingClientRect();
  const pop = elements.thumbPopover;
  const size = pop.getBoundingClientRect();
  let left = rect.right + 10;
  if (left + size.width > window.innerWidth - 12) left = rect.left - size.width - 10;
  if (left < 12) left = Math.max(12, Math.min(rect.right + 10, window.innerWidth - size.width - 12));
  const top = Math.max(12, Math.min(rect.top + rect.height / 2 - size.height / 2, window.innerHeight - size.height - 12));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

function hideThumbPopover() {
  thumbHoverToken += 1;
  clearTimeout(thumbHoverTimer);
  elements.thumbPopover.classList.add('is-hidden');
}

async function showThumbPopover(file, anchor) {
  const token = ++thumbHoverToken;
  const reveal = (dataUrl) => {
    if (token !== thumbHoverToken) return;
    elements.thumbPopoverImage.onload = () => {
      if (token === thumbHoverToken) positionThumbPopover(anchor);
    };
    elements.thumbPopoverImage.src = dataUrl;
    elements.thumbPopover.classList.remove('is-hidden');
    positionThumbPopover(anchor);
  };
  const cached = thumbPreviewCache.get(file.path);
  if (cached) {
    reveal(cached);
    return;
  }
  try {
    const preview = await api.getImagePreview(file.path, 480);
    if (thumbPreviewCache.size >= 30) thumbPreviewCache.delete(thumbPreviewCache.keys().next().value);
    thumbPreviewCache.set(file.path, preview.dataUrl);
    reveal(preview.dataUrl);
  } catch {
    // 原图缺失或不可读时不显示气泡
  }
}

function bindThumbPopover(image, file) {
  image.addEventListener('mouseenter', () => {
    clearTimeout(thumbHoverTimer);
    thumbHoverTimer = setTimeout(() => showThumbPopover(file, image), 140);
  });
  image.addEventListener('mouseleave', hideThumbPopover);
}
elements.queueList.addEventListener('scroll', hideThumbPopover);

function makeQueueItem(file, index) {
  const row = document.createElement('article');
  row.className = `queue-item ${file.status ? `is-${file.status}` : ''}${file.selected === false ? ' is-unchecked' : ''}`;
  row.dataset.path = file.path;

  const check = document.createElement('input');
  check.className = 'queue-check-input';
  check.type = 'checkbox';
  check.checked = file.selected !== false;
  check.disabled = state.running;
  check.title = '勾选后参与本次批处理';
  check.setAttribute('aria-label', `选择 ${file.name}`);
  check.addEventListener('click', (event) => event.stopPropagation());
  check.addEventListener('change', () => {
    file.selected = check.checked;
    renderQueue();
  });

  const image = document.createElement('img');
  image.className = 'queue-thumb';
  image.src = file.thumbnail;
  image.alt = '';
  bindThumbPopover(image, file);

  const copy = document.createElement('div');
  copy.className = 'queue-copy';
  const name = document.createElement('span');
  name.className = 'queue-name';
  name.textContent = file.name;
  name.title = file.path;
  const meta = document.createElement('span');
  meta.className = 'queue-meta';
  meta.textContent = `${file.width} × ${file.height} · ${formatBytes(file.bytes)}`;
  copy.append(name, meta);

  const status = document.createElement('div');
  status.className = 'job-status';
  if (file.status === 'complete' && file.outputPath) {
    status.classList.add('result-actions');
    const regenerateButton = document.createElement('button');
    regenerateButton.className = 'result-action-button regenerate-result';
    regenerateButton.type = 'button';
    regenerateButton.disabled = Boolean(file.missing) || Boolean(file.regenRequested);
    regenerateButton.classList.toggle('is-pending', Boolean(file.regenRequested));
    regenerateButton.title = file.missing
      ? '原图已移动或删除，无法重新生成'
      : file.regenRequested
        ? '正在发起重新生成…'
        : '重新生成（接回该图片的历史对话）';
    regenerateButton.setAttribute('aria-label', '重新生成');
    regenerateButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>';
    regenerateButton.addEventListener('click', () => regenerateFile(file));
    const previewButton = document.createElement('button');
    previewButton.className = 'result-action-button preview-result';
    previewButton.type = 'button';
    previewButton.textContent = '预览';
    previewButton.addEventListener('click', () => openPreview(file));
    const manualButton = document.createElement('button');
    manualButton.className = 'result-action-button manual-result';
    manualButton.type = 'button';
    manualButton.textContent = '涂抹重绘';
    manualButton.disabled = Boolean(file.missing);
    manualButton.title = file.missing ? '原图已移动或删除，无法手动涂抹' : '在原图上涂抹后重新发送';
    manualButton.addEventListener('click', () => openManualEditor(file));
    status.append(regenerateButton, previewButton, manualButton);
  } else {
    const statusTitle = document.createElement('strong');
    statusTitle.textContent = file.message || (file.selected === false && !file.status ? '本次跳过' : '等待处理');
    statusTitle.title = statusTitle.textContent;
    const statusMeta = document.createElement('span');
    statusMeta.textContent = file.status === 'error'
      ? '可以重新开始任务重试'
      : `队列 #${String(index + 1).padStart(2, '0')}`;
    status.append(statusTitle, statusMeta);
  }

  const remove = document.createElement('button');
  remove.className = 'remove-button';
  remove.type = 'button';
  remove.textContent = '×';
  remove.title = '移除';
  remove.disabled = state.running;
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    state.files = state.files.filter((item) => item.path !== file.path);
    renderQueue();
  });

  row.append(check, image, copy, status, remove);
  if (file.status === 'active') {
    const progress = document.createElement('div');
    progress.className = 'task-progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-valuemin', '0');
    progress.setAttribute('aria-valuemax', '100');
    progress.setAttribute('aria-valuenow', String(file.progress || 5));
    const progressBar = document.createElement('span');
    progressBar.style.width = `${file.progress || 5}%`;
    progress.append(progressBar);
    row.append(progress);
  }
  return row;
}

function renderQueue() {
  hideThumbPopover();
  elements.queueList.replaceChildren(...state.files.map(makeQueueItem));
  syncActionState();
  scheduleQueueSave();
}

let queueSaveTimer;
function scheduleQueueSave(delay = 180) {
  if (!state.queueReady) return;
  clearTimeout(queueSaveTimer);
  queueSaveTimer = setTimeout(() => {
    api.saveQueueRecords(state.files).catch((error) => {
      console.error('保存队列记录失败', error);
    });
  }, delay);
}

async function persistQueueNow() {
  if (!state.queueReady) return;
  clearTimeout(queueSaveTimer);
  await api.saveQueueRecords(state.files);
}

async function addFiles(files) {
  const existing = new Set(state.files.map((file) => file.path));
  const additions = files.filter((file) => !existing.has(file.path));
  state.files.push(...additions.map((file) => ({ ...file, status: '', message: '', selected: true })));
  renderQueue();
  if (files.length && !additions.length) toast('这些图片已经在队列中');
}

function updateLogin(status) {
  state.loggedIn = Boolean(status?.loggedIn);
  elements.loginPill.classList.toggle('is-online', state.loggedIn);
  elements.loginPill.classList.toggle('is-offline', !state.loggedIn);
  elements.loginText.textContent = state.loggedIn ? '豆包已登录 · 状态已保存' : '豆包未登录';
  elements.loginButtonText.textContent = state.loggedIn ? '打开豆包' : '登录豆包';
  elements.logoutButton.classList.toggle('is-hidden', !state.loggedIn);
  elements.logoutButton.disabled = state.running;
  syncActionState();
}

function setRunning(value) {
  state.running = value;
  elements.logoutButton.disabled = value;
  renderQueue();
}

function updateFile(path, patch) {
  const item = state.files.find((file) => file.path === path);
  if (!item) return;
  Object.assign(item, patch);
  renderQueue();
}

function handleBatchEvent(event) {
  if (event.type === 'batch-start') {
    const batchId = event.batchId || 'default';
    const firstBatch = state.activeBatches.size === 0;
    state.activeBatches.add(batchId);
    if (firstBatch) setRunning(true);
    if (event.parallel) toast(`多线程模式已开启：${event.workers || 3} 张图片同时处理`);
    if (event.mode === 'manual' && event.path) {
      updateFile(event.path, { status: 'active', message: '准备局部重绘', progress: 5 });
    } else if (firstBatch) {
      state.files.forEach((file) => {
        if (file.selected === false) return;
        Object.assign(file, { status: '', message: '', progress: 0 });
      });
      renderQueue();
    }
  }
  if (event.type === 'job-start') {
    updateFile(event.path, {
      status: 'active',
      message: event.mode === 'manual' ? '准备局部重绘' : '准备处理',
      progress: 5,
      regenRequested: false
    });
  }
  if (event.type === 'job-progress') {
    const current = state.files.find((file) => file.path === event.path)?.progress || 5;
    updateFile(event.path, {
      status: 'active',
      message: event.message,
      progress: progressForMessage(event.message, current)
    });
  }
  if (event.type === 'verification-required') {
    toast('豆包触发了安全验证，已暂停任务并显示验证窗口，请手动完成');
  }
  if (event.type === 'verification-cleared') {
    toast('安全验证已完成，正在重新开始被中断的任务');
  }
  if (event.type === 'job-complete') {
    const source = state.files.find((file) => file.path === event.sourcePath);
    if (source) {
      Object.assign(source, {
        status: 'complete',
        message: '',
        selected: false,
        regenRequested: false,
        ...(event.conversationId ? { conversationId: event.conversationId } : {}),
        outputPath: event.outputPath,
        cropped: event.cropped,
        cropPercent: event.cropPercent,
        cropEdge: event.cropEdge,
        removedUploadPadding: event.removedUploadPadding,
        outputWidth: event.width,
        outputHeight: event.height,
        progress: 100
      });
      renderQueue();
      persistQueueNow().catch((error) => console.error('保存完成记录失败', error));
    }
  }
  if (event.type === 'job-error') {
    const source = state.files.find((file) => file.path === event.path);
    updateFile(event.path, {
      status: event.mode === 'manual' && source?.outputPath ? 'complete' : 'error',
      message: event.mode === 'manual' && source?.outputPath ? '' : event.error,
      regenRequested: false,
      ...(event.conversationId ? { conversationId: event.conversationId } : {})
    });
    toast(`${event.name}：${event.error}`, 'error');
  }
  if (event.type === 'batch-complete') {
    state.activeBatches.delete(event.batchId || 'default');
    const idle = state.activeBatches.size === 0;
    if (idle) setRunning(false);
    if (event.cancelled && idle) {
      state.files.forEach((file) => {
        if (file.status !== 'active') return;
        Object.assign(file, file.outputPath
          ? { status: 'complete', message: '', progress: 100 }
          : { status: '', message: '', progress: 0 });
      });
      renderQueue();
    }
    if (event.cancelled) toast(event.mode === 'manual' ? '局部重绘已停止' : '批处理已停止');
    else if (event.failed) toast(event.mode === 'manual' ? '局部重绘失败，请调整涂抹区域后重试' : `处理结束：成功 ${event.completed} 张，失败 ${event.failed} 张`, 'error');
    else toast(event.mode === 'manual' ? '局部重绘完成，点击预览查看结果' : `全部完成，共导出 ${event.completed} 张图片`);
  }
}

elements.loginButton.addEventListener('click', async () => {
  try {
    const result = await api.openLogin();
    if (!result?.alreadyLoggedIn) toast('已打开豆包登录界面，登录状态会自动保存');
  } catch (error) {
    toast(error.message || String(error), 'error');
  }
});

elements.logoutButton.addEventListener('click', async () => {
  elements.logoutButton.disabled = true;
  try {
    await api.logout();
    updateLogin({ loggedIn: false });
    toast('已退出豆包登录，并清除本工具保存的登录状态');
  } catch (error) {
    toast(error.message || String(error), 'error');
  } finally {
    elements.logoutButton.disabled = state.running;
  }
});

elements.dropZone.addEventListener('click', async () => addFiles(await api.selectImages()));
elements.dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (!state.running) elements.dropZone.classList.add('is-over');
});
elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('is-over'));
elements.dropZone.addEventListener('drop', async (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove('is-over');
  if (state.running) return;
  const paths = [...event.dataTransfer.files].map((file) => api.pathForFile(file)).filter(Boolean);
  addFiles(await api.validatePaths(paths));
});

elements.clearButton.addEventListener('click', () => {
  state.files = [];
  renderQueue();
});

elements.selectAllCheckbox.addEventListener('change', () => {
  const checkAll = state.files.some((file) => file.selected === false);
  state.files.forEach((file) => { file.selected = checkAll; });
  renderQueue();
});

elements.showBrowserWindow.addEventListener('change', scheduleSettingsSave);
elements.intervalSeconds.addEventListener('change', scheduleSettingsSave);
elements.imageWaitSeconds.addEventListener('change', scheduleSettingsSave);
elements.maxConcurrentTasks.addEventListener('change', scheduleSettingsSave);
elements.parallelProcessing.addEventListener('change', () => {
  syncProcessingControls();
  scheduleSettingsSave();
});
elements.themeModeButtons.forEach((button) => button.addEventListener('click', async () => {
  state.settings = await api.saveSettings({ ...readSettings(), themeMode: button.dataset.themeMode });
  applySettings(state.settings);
}));
elements.paletteButtons.forEach((button) => button.addEventListener('click', async () => {
  state.settings = await api.saveSettings({
    ...readSettings(),
    colorPalette: button.dataset.palette,
    themeColor: PRESET_COLORS[button.dataset.palette]
  });
  applySettings(state.settings);
}));
elements.themeColor.addEventListener('input', () => {
  state.settings = {
    ...state.settings,
    colorPalette: 'custom',
    themeColor: elements.themeColor.value
  };
  applyAppearance(state.settings);
  scheduleSettingsSave();
});
function setAppearancePopover(open) {
  elements.appearanceColors.classList.toggle('is-hidden', !open);
  elements.appearanceToggle.setAttribute('aria-expanded', String(open));
  elements.appearanceToggle.title = open ? '收起颜色设置' : '展开颜色设置';
}
elements.appearanceToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  setAppearancePopover(elements.appearanceColors.classList.contains('is-hidden'));
});
document.addEventListener('click', (event) => {
  if (elements.appearanceColors.classList.contains('is-hidden')) return;
  if (event.target.closest('.appearance-popover-anchor')) return;
  setAppearancePopover(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.appearanceColors.classList.contains('is-hidden')) setAppearancePopover(false);
});
elements.advancedSettingsButton.addEventListener('click', () => api.openAdvancedSettings());
api.onSettingsUpdated((settings) => {
  applySettings(settings);
  toast('高级处理设置已保存');
});

elements.outputButton.addEventListener('click', async () => {
  const selected = await api.chooseOutput(state.settings.outputDirectory);
  if (!selected) return;
  state.settings.outputDirectory = selected;
  elements.outputPath.textContent = selected;
  elements.outputPath.title = selected;
  state.settings = await api.saveSettings(readSettings());
});

elements.openOutputButton.addEventListener('click', () => api.openPath(state.settings.outputDirectory));
elements.previewBackdrop.addEventListener('click', closePreview);
elements.previewClose.addEventListener('click', closePreview);
elements.previewZoomOut.addEventListener('click', () => stepPreviewZoom(-1));
elements.previewZoomIn.addEventListener('click', () => stepPreviewZoom(1));
elements.previewZoomReset.addEventListener('click', resetPreviewView);
elements.previewStage.addEventListener('dblclick', (event) => setPreviewZoom(previewZoom === 1 ? 2 : 1, event.clientX, event.clientY));
elements.previewStage.addEventListener('wheel', (event) => {
  if (elements.previewModal.classList.contains('is-hidden')) return;
  event.preventDefault();
  if (event.metaKey || event.ctrlKey) {
    stepPreviewZoom(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY);
    return;
  }
  if (previewZoom > 1) {
    previewPanX -= event.deltaX;
    previewPanY -= event.deltaY;
    applyPreviewTransform();
  }
}, { passive: false });
elements.previewImage.addEventListener('pointerdown', (event) => {
  if (previewZoom <= 1) return;
  previewPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  elements.previewImage.setPointerCapture(event.pointerId);
  elements.previewImage.classList.add('is-dragging');
});
elements.previewImage.addEventListener('pointermove', (event) => {
  if (!previewPointer || previewPointer.id !== event.pointerId) return;
  previewPanX += event.clientX - previewPointer.x;
  previewPanY += event.clientY - previewPointer.y;
  previewPointer.x = event.clientX;
  previewPointer.y = event.clientY;
  applyPreviewTransform();
});
function endPreviewDrag(event) {
  if (!previewPointer || previewPointer.id !== event.pointerId) return;
  previewPointer = null;
  elements.previewImage.classList.remove('is-dragging');
}
elements.previewImage.addEventListener('pointerup', endPreviewDrag);
elements.previewImage.addEventListener('pointercancel', endPreviewDrag);
window.addEventListener('resize', () => {
  if (!elements.previewModal.classList.contains('is-hidden')) applyPreviewTransform();
});
document.addEventListener('keydown', (event) => {
  const previewOpen = !elements.previewModal.classList.contains('is-hidden');
  if (previewOpen && (event.metaKey || event.ctrlKey)) {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      stepPreviewZoom(1);
      return;
    }
    if (event.key === '-') {
      event.preventDefault();
      stepPreviewZoom(-1);
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      resetPreviewView();
      return;
    }
  }
  if (event.key === 'Escape') {
    if (previewOpen) closePreview();
  }
});
elements.cancelButton.addEventListener('click', async () => {
  elements.cancelButton.disabled = true;
  elements.cancelButton.textContent = '正在停止…';
  await api.cancelBatch();
  setTimeout(() => {
    elements.cancelButton.disabled = false;
    elements.cancelButton.textContent = '停止任务';
  }, 1500);
});

elements.startButton.addEventListener('click', async () => {
  if (state.running) return;
  const items = state.files
    .filter((file) => file.selected !== false)
    .map((file) => ({ path: file.path, conversationId: file.conversationId || '' }));
  if (!items.length) return;
  // 立即切换为运行状态（显示「停止任务」），防止启动期间被当作没点到而重复点击
  setRunning(true);
  try {
    const settings = readSettings();
    state.settings = await api.saveSettings(settings);
    await api.startBatch({ paths: items, settings: state.settings });
  } catch (error) {
    if (state.activeBatches.size) renderQueue();
    else setRunning(false);
    toast(error.message || String(error), 'error');
  }
});

api.onLoginStatus(updateLogin);
api.onBatchEvent(handleBatchEvent);
api.onManualSubmitted(handleManualSubmitted);

async function initialize() {
  applySettings(await api.getSettings());
  state.files = (await api.getQueueRecords()).map((record) => ({
    ...record,
    selected: typeof record.selected === 'boolean' ? record.selected : record.status !== 'complete'
  }));
  state.queueReady = true;
  updateLogin(await api.getLoginStatus());
  renderQueue();
}

initialize().catch((error) => toast(error.message || String(error), 'error'));
