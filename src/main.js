'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, session } = require('electron');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { computeDiffStats, verdictForStats, buildHeatmap } = require('./qc-check');
const { DoubaoAutomation, DOUBAO_CHAT_URL } = require('./doubao-automation');
const {
  downloadBestImage,
  isExactSourceImage,
  prepareManualMarkedUpload,
  preparePaddedUpload,
  saveProcessedImage
} = require('./image-pipeline');
const { buildManualEditPrompt, buildPrompt, DEFAULT_PROMPT, MANUAL_EDIT_PROMPT } = require('./prompt');

const DOUBAO_PARTITION = 'persist:watermark-lab-doubao';
const APP_ICON_PATH = path.join(__dirname, 'assets', 'app-icon.png');
const APP_DISPLAY_NAME = '水印清理工作台';
// Dock 悬停与系统各处显示应用名（开发模式下默认显示 Electron）
app.setName(APP_DISPLAY_NAME);
// setName 会改变 userData 默认位置；若旧目录已存在则钉回去，避免设置、队列与豆包登录态丢失
const LEGACY_USER_DATA = path.join(app.getPath('appData'), 'doubao-watermark-lab');
try {
  if (fsSync.existsSync(LEGACY_USER_DATA)) app.setPath('userData', LEGACY_USER_DATA);
} catch { /* 保留默认路径 */ }
const AUTOMATION_SAFETY_VERSION = 1;
const CROP_STRATEGY_VERSION = 4;
const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif', '.avif', '.heic', '.heif']);
const THEME_MODES = new Set(['auto', 'light', 'dark']);
const PALETTE_COLORS = Object.freeze({
  forest: '#246b55',
  ocean: '#28739a',
  violet: '#745ca7',
  sunset: '#b9663e',
  graphite: '#53636a'
});
const COLOR_PALETTES = new Set([...Object.keys(PALETTE_COLORS), 'custom']);
const STABLE_PROCESSING_SETTINGS = Object.freeze({
  preferOriginal: true,
  cropMode: 'fallback',
  addPaddingBeforeUpload: true,
  newConversation: false
});
const PARALLEL_WORKER_COUNT = 3;
const MAX_CONCURRENT_LIMIT = 8;
const PARALLEL_STAGGER_MS = 5_000;
const DEFAULT_SETTINGS = {
  outputDirectory: '',
  prompt: DEFAULT_PROMPT,
  manualEditPrompt: MANUAL_EDIT_PROMPT,
  ...STABLE_PROCESSING_SETTINGS,
  cropEdge: 'top',
  cropPercent: 10,
  cropCompensationPercent: 0.5,
  intervalSeconds: 30,
  imageWaitSeconds: 60,
  parallelProcessing: true,
  showBrowserWindow: false,
  themeMode: 'auto',
  colorPalette: 'forest',
  themeColor: PALETTE_COLORS.forest,
  automationSafetyVersion: AUTOMATION_SAFETY_VERSION,
  cropStrategyVersion: CROP_STRATEGY_VERSION
};

let mainWindow;
let doubaoWindow;
let previewWindow;
let manualWindow;
let advancedWindow;
let loginTimer;
let loginFlowActive = false;
// 批处理与涂抹重绘都支持并发：activeBatchCount 跟踪进行中的任务数，每个批次持有独立取消标记；
// busyWindows 记录被批次占用的豆包窗口
let activeBatchCount = 0;
let batchSeq = 0;
const activeCancelRefs = new Set();
const busyWindows = new Set();
let tempFileSeq = 0;

// 并发批次可能同时写同一文件，临时文件名必须唯一，避免 rename 竞态
function uniqueTemporaryPath(targetPath) {
  tempFileSeq += 1;
  return `${targetPath}.${process.pid}.${Date.now()}.${tempFileSeq}.tmp`;
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function queueRecordsPath() {
  return path.join(app.getPath('userData'), 'queue-records.json');
}

async function loadSettings() {
  const defaults = {
    ...DEFAULT_SETTINGS,
    outputDirectory: path.join(app.getPath('pictures'), 'Watermark Lab')
  };
  try {
    const saved = JSON.parse(await fs.readFile(settingsPath(), 'utf8'));
    return sanitizeSettings({
      ...defaults,
      ...saved,
      themeColor: saved.themeColor || PALETTE_COLORS[saved.colorPalette] || defaults.themeColor
    });
  } catch {
    return defaults;
  }
}

function sanitizeSettings(input = {}) {
  const colorPalette = COLOR_PALETTES.has(input.colorPalette) ? input.colorPalette : 'forest';
  const fallbackThemeColor = PALETTE_COLORS[colorPalette] || PALETTE_COLORS.forest;
  const themeColor = typeof input.themeColor === 'string' && /^#[0-9a-f]{6}$/i.test(input.themeColor)
    ? input.themeColor.toLowerCase()
    : fallbackThemeColor;
  return {
    outputDirectory: typeof input.outputDirectory === 'string' && input.outputDirectory
      ? path.resolve(input.outputDirectory)
      : path.join(app.getPath('pictures'), 'Watermark Lab'),
    prompt: typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.trim().slice(0, 4000) : DEFAULT_PROMPT,
    manualEditPrompt: typeof input.manualEditPrompt === 'string' && input.manualEditPrompt.trim()
      ? input.manualEditPrompt.trim().slice(0, 4000)
      : MANUAL_EDIT_PROMPT,
    ...STABLE_PROCESSING_SETTINGS,
    cropEdge: input.cropEdge === 'bottom' ? 'bottom' : 'top',
    cropPercent: Math.min(25, Math.max(10, Number(input.cropPercent) || 10)),
    cropCompensationPercent: Math.min(3, Math.max(0, Number(input.cropCompensationPercent) || 0)),
    intervalSeconds: Math.min(600, Math.max(0, Number.isFinite(Number(input.intervalSeconds)) ? Math.round(Number(input.intervalSeconds)) : 30)),
    imageWaitSeconds: Math.min(300, Math.max(5, Number.isFinite(Number(input.imageWaitSeconds)) ? Math.round(Number(input.imageWaitSeconds)) : 60)),
    parallelProcessing: input.parallelProcessing === true,
    maxConcurrentTasks: Math.min(MAX_CONCURRENT_LIMIT, Math.max(1, Math.round(Number(input.maxConcurrentTasks) || PARALLEL_WORKER_COUNT))),
    showBrowserWindow: input.showBrowserWindow !== false,
    themeMode: THEME_MODES.has(input.themeMode) ? input.themeMode : 'auto',
    colorPalette,
    themeColor,
    automationSafetyVersion: AUTOMATION_SAFETY_VERSION,
    cropStrategyVersion: CROP_STRATEGY_VERSION
  };
}

async function saveSettings(settings) {
  const sanitized = sanitizeSettings(settings);
  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  const temporary = uniqueTemporaryPath(settingsPath());
  await fs.writeFile(temporary, JSON.stringify(sanitized, null, 2), 'utf8');
  await fs.rename(temporary, settingsPath());
  return sanitized;
}

function sanitizeQueueRecord(record = {}) {
  const sourcePath = typeof record.path === 'string' && path.isAbsolute(record.path)
    ? path.resolve(record.path)
    : '';
  if (!sourcePath) return null;
  const outputPath = typeof record.outputPath === 'string' && path.isAbsolute(record.outputPath)
    ? path.resolve(record.outputPath)
    : '';
  const thumbnail = typeof record.thumbnail === 'string'
    && record.thumbnail.length <= 600_000
    && /^data:image\//i.test(record.thumbnail)
    ? record.thumbnail
    : '';
  return {
    path: sourcePath,
    name: typeof record.name === 'string' ? record.name.slice(0, 240) : path.basename(sourcePath),
    bytes: Math.max(0, Number(record.bytes) || 0),
    width: Math.max(0, Number(record.width) || 0),
    height: Math.max(0, Number(record.height) || 0),
    thumbnail,
    status: ['complete', 'error'].includes(record.status) ? record.status : '',
    message: typeof record.message === 'string' ? record.message.slice(0, 500) : '',
    ...(typeof record.selected === 'boolean' ? { selected: record.selected } : {}),
    conversationId: typeof record.conversationId === 'string' && /^[0-9a-zA-Z_-]{6,64}$/.test(record.conversationId)
      ? record.conversationId
      : '',
    outputPath,
    outputWidth: Math.max(0, Number(record.outputWidth) || 0),
    outputHeight: Math.max(0, Number(record.outputHeight) || 0),
    cropped: Boolean(record.cropped),
    cropPercent: Math.max(0, Number(record.cropPercent) || 0),
    cropEdge: record.cropEdge === 'bottom' ? 'bottom' : 'top',
    removedUploadPadding: Boolean(record.removedUploadPadding)
  };
}

async function saveQueueRecords(records) {
  const sanitized = (Array.isArray(records) ? records : [])
    .slice(0, 300)
    .map(sanitizeQueueRecord)
    .filter(Boolean);
  await fs.mkdir(path.dirname(queueRecordsPath()), { recursive: true });
  const temporary = uniqueTemporaryPath(queueRecordsPath());
  await fs.writeFile(temporary, JSON.stringify(sanitized, null, 2), 'utf8');
  await fs.rename(temporary, queueRecordsPath());
  return true;
}

async function validStoredOutput(targetPath) {
  if (!targetPath || !SUPPORTED_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) return '';
  try {
    const stat = await fs.stat(targetPath);
    return stat.isFile() && stat.size <= 80 * 1024 * 1024 ? targetPath : '';
  } catch {
    return '';
  }
}

async function loadQueueRecords() {
  let saved;
  try {
    saved = JSON.parse(await fs.readFile(queueRecordsPath(), 'utf8'));
  } catch {
    return [];
  }
  const records = [];
  for (const rawRecord of (Array.isArray(saved) ? saved : []).slice(0, 300)) {
    const record = sanitizeQueueRecord(rawRecord);
    if (!record) continue;
    const [freshSource] = await validateImagePaths([record.path]);
    const outputPath = await validStoredOutput(record.outputPath);
    const source = freshSource || {
      path: record.path,
      name: record.name,
      bytes: record.bytes,
      width: record.width,
      height: record.height,
      thumbnail: record.thumbnail,
      missing: true
    };
    records.push({
      ...record,
      ...source,
      outputPath,
      status: outputPath ? 'complete' : (source.missing ? 'error' : (record.status === 'error' ? 'error' : '')),
      message: outputPath ? '' : (source.missing ? '原图文件已移动或删除' : record.message)
    });
  }
  return records;
}

// Windows 上毛玻璃（backdrop-filter）合成层会让 Chromium 关闭次像素抗锯齿，
// 中文渲染发虚。给本地窗口 body 打上平台标记，样式表据此关闭背景模糊、提高面板不透明度。
// 只用于本地页面，绝不注入豆包等外部页面。
function applyPlatformWindowTweaks(window) {
  if (process.platform !== 'win32') return;
  window.webContents.on('dom-ready', () => {
    window.webContents.executeJavaScript(
      `document.body && document.body.classList.add('platform-win32')`
    ).catch(() => {});
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 736,
    minWidth: 940,
    minHeight: 630,
    backgroundColor: '#f5f4ef',
    icon: APP_ICON_PATH,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    title: '水印清理工作台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  applyPlatformWindowTweaks(mainWindow);
  mainWindow.on('closed', () => {
    mainWindow = null;
    // 主窗口关闭即退出整个应用：强制销毁豆包等后台窗口，避免进程残留
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
    app.quit();
  });
}

function configureDoubaoSession() {
  const persistentSession = session.fromPartition(DOUBAO_PARTITION);
  persistentSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });
  persistentSession.setPermissionCheckHandler((_webContents, permission) => permission === 'clipboard-sanitized-write');
  return persistentSession;
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

async function cookieLoginHint() {
  try {
    const cookies = await session.fromPartition(DOUBAO_PARTITION).cookies.get({ url: 'https://www.doubao.com/' });
    return cookies.some((cookie) => !/csrf/i.test(cookie.name)
      && /^(?:sessionid(?:_ss)?|sid_(?:guard|tt)|uid_tt(?:_ss)?|passport_auth_status|sso_auth_status)$/i.test(cookie.name));
  } catch {
    return false;
  }
}

async function getLoginStatus() {
  const cookieHint = await cookieLoginHint();
  let pageStatus = null;
  if (doubaoWindow && !doubaoWindow.isDestroyed() && !doubaoWindow.webContents.isLoading()) {
    try {
      const automation = new DoubaoAutomation(doubaoWindow);
      pageStatus = await automation.getLoginStatus();
    } catch {
      pageStatus = null;
    }
  }
  const loggedIn = pageStatus ? pageStatus.loggedIn && (cookieHint || pageStatus.hasAccount) : cookieHint;
  return {
    loggedIn,
    cookieHint,
    pageStatus,
    persistent: true
  };
}

async function broadcastLoginStatus() {
  const status = await getLoginStatus();
  sendToRenderer('login:status', status);
  if (loginFlowActive && status.loggedIn) {
    loginFlowActive = false;
    const persistentSession = session.fromPartition(DOUBAO_PARTITION);
    persistentSession.flushStorageData();
    clearInterval(loginTimer);
    loginTimer = null;
    for (const window of BrowserWindow.getAllWindows()) {
      if (window !== mainWindow && !window.isDestroyed() && window.webContents.session === persistentSession) {
        window.hide();
        window.destroy();
      }
    }
    doubaoWindow = null;
  }
}

async function waitForDoubaoLoad(browser) {
  if (!browser.webContents.isLoading()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('豆包页面加载超时')), 35_000);
    browser.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function openDoubaoLogin() {
  const currentStatus = await getLoginStatus();
  loginFlowActive = !currentStatus.loggedIn;
  const browser = createDoubaoWindow({ focus: true });
  await waitForDoubaoLoad(browser);
  browser.show();
  browser.focus();
  const automation = new DoubaoAutomation(browser);
  const result = await automation.openLoginDialog();
  if (result.alreadyLoggedIn) loginFlowActive = false;
  await broadcastLoginStatus();
  return result;
}

async function logoutDoubao() {
  if (activeBatchCount > 0) throw new Error('批处理运行期间不能退出登录');
  clearInterval(loginTimer);
  loginTimer = null;
  loginFlowActive = false;

  const persistentSession = session.fromPartition(DOUBAO_PARTITION);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window !== mainWindow && !window.isDestroyed() && window.webContents.session === persistentSession) {
      window.destroy();
    }
  }
  doubaoWindow = null;
  await persistentSession.clearStorageData();
  await persistentSession.clearCache();
  await persistentSession.clearAuthCache();
  persistentSession.flushStorageData();
  sendToRenderer('login:status', {
    loggedIn: false,
    cookieHint: false,
    pageStatus: null,
    persistent: true
  });
  return true;
}

function createDoubaoWindow({ focus = true } = {}) {
  if (doubaoWindow && !doubaoWindow.isDestroyed()) {
    if (focus) doubaoWindow.show();
    return doubaoWindow;
  }

  configureDoubaoSession();
  doubaoWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 780,
    minHeight: 620,
    show: focus,
    title: '豆包网页 · 水印清理工作台',
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: DOUBAO_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      safeDialogs: true
    }
  });

  doubaoWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/([\w-]+\.)*(doubao\.com|bytedance\.com|toutiao\.com|feishu\.cn)\//i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: doubaoWindow,
          autoHideMenuBar: true,
          webPreferences: {
            partition: DOUBAO_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const update = () => setTimeout(broadcastLoginStatus, 800);
  doubaoWindow.webContents.on('did-finish-load', update);
  doubaoWindow.webContents.on('did-navigate', update);
  doubaoWindow.webContents.on('did-navigate-in-page', update);
  doubaoWindow.loadURL(DOUBAO_CHAT_URL);
  doubaoWindow.on('closed', () => {
    doubaoWindow = null;
    loginFlowActive = false;
    clearInterval(loginTimer);
    loginTimer = null;
    broadcastLoginStatus();
  });
  loginTimer = setInterval(broadcastLoginStatus, 5000);
  return doubaoWindow;
}

let auxWorkerWindows = [];

function createAuxWorkerWindow(position) {
  const workerWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    minWidth: 780,
    minHeight: 620,
    show: false,
    title: `豆包网页 · 并行任务 ${position + 2}`,
    backgroundColor: '#ffffff',
    webPreferences: {
      partition: DOUBAO_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      safeDialogs: true
    }
  });

  workerWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/([\w-]+\.)*(doubao\.com|bytedance\.com|toutiao\.com|feishu\.cn)\//i.test(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: workerWindow,
          autoHideMenuBar: true,
          webPreferences: {
            partition: DOUBAO_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  workerWindow.on('closed', () => {
    auxWorkerWindows = auxWorkerWindows.filter((item) => item !== workerWindow);
  });
  workerWindow.loadURL(DOUBAO_CHAT_URL);
  return workerWindow;
}

function hideIdleDoubaoWindows() {
  const persistentSession = session.fromPartition(DOUBAO_PARTITION);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window !== mainWindow && !window.isDestroyed() && window.webContents.session === persistentSession && !busyWindows.has(window)) {
      window.hide();
    }
  }
}

// 为批次分配互不冲突的豆包窗口：优先复用空闲窗口，不够时新建；批次结束后释放
async function acquireBatchWindows(count, { show }) {
  createDoubaoWindow({ focus: false });
  const idleWindows = () => [doubaoWindow, ...auxWorkerWindows]
    .filter((window) => window && !window.isDestroyed() && !busyWindows.has(window));
  const windows = [];
  for (let index = 0; index < count; index += 1) {
    let window = idleWindows().find((item) => !windows.includes(item));
    if (!window) {
      window = createAuxWorkerWindow(auxWorkerWindows.length);
      auxWorkerWindows.push(window);
    }
    busyWindows.add(window);
    windows.push(window);
  }
  if (show) {
    windows.forEach((window, index) => {
      window.setPosition(90 + index * 56, 70 + index * 48);
      window.show();
    });
    if (activeBatchCount <= 1) windows[0].focus();
  } else {
    hideIdleDoubaoWindows();
  }
  try {
    await Promise.all(windows.map(waitForDoubaoLoad));
  } catch (error) {
    windows.forEach((window) => busyWindows.delete(window));
    throw error;
  }
  return windows;
}

async function validateImagePaths(paths) {
  const unique = [...new Set((paths || []).filter((value) => typeof value === 'string').map((value) => path.resolve(value)))];
  const valid = [];
  for (const filePath of unique.slice(0, 300)) {
    if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size > 80 * 1024 * 1024) continue;
      const previewImage = nativeImage.createFromPath(filePath);
      if (previewImage.isEmpty()) continue;
      const preview = previewImage.resize({ width: 104, height: 104, quality: 'good' });
      const size = previewImage.getSize();
      valid.push({
        path: filePath,
        name: path.basename(filePath),
        bytes: stat.size,
        width: size.width,
        height: size.height,
        thumbnail: preview.toDataURL()
      });
    } catch {
      // Ignore unreadable dropped files.
    }
  }
  return valid;
}

function batchEvent(payload) {
  sendToRenderer('batch:event', payload);
}

async function runBatch(items, rawSettings, runtime = {}) {
  const mode = runtime.mode === 'manual' ? 'manual' : 'batch';
  // 批处理与涂抹重绘都允许并发，合计上限由「同时处理」设置决定（默认 3，控制风控）
  const maxConcurrent = sanitizeSettings(rawSettings || {}).maxConcurrentTasks || PARALLEL_WORKER_COUNT;
  if (activeBatchCount >= maxConcurrent) {
    throw new Error(`最多同时处理 ${maxConcurrent} 张图片，请等待其中一张完成`);
  }
  // 守卫通过后同步占位：快速连续点击也不会突破并发上限
  const batchId = `batch-${Date.now()}-${batchSeq += 1}`;
  const cancelRef = { value: false };
  activeCancelRefs.add(cancelRef);
  activeBatchCount += 1;
  try {
    return await runBatchReserved(items, rawSettings, runtime, { mode, batchId, cancelRef });
  } finally {
    activeCancelRefs.delete(cancelRef);
    activeBatchCount -= 1;
  }
}

async function runBatchReserved(items, rawSettings, runtime, { mode, batchId, cancelRef }) {
  // 渲染进程会把每个任务的历史会话一起带过来（{ path, conversationId }），校验后合并回文件对象
  const requestedConversations = new Map();
  const requestedPaths = (Array.isArray(items) ? items : []).map((item) => {
    if (typeof item === 'string') return item;
    const itemPath = typeof item?.path === 'string' ? path.resolve(item.path) : '';
    const conversationId = typeof item?.conversationId === 'string' && /^[0-9a-zA-Z_-]{6,64}$/.test(item.conversationId)
      ? item.conversationId
      : '';
    if (itemPath && conversationId) requestedConversations.set(itemPath, conversationId);
    return itemPath;
  }).filter(Boolean);
  const files = Array.isArray(runtime.files)
    ? runtime.files
    : (await validateImagePaths(requestedPaths)).map((file) => ({
      ...file,
      conversationId: requestedConversations.get(file.path) || file.conversationId || ''
    }));
  if (!files.length) throw new Error('请先选择要处理的图片');
  const settings = runtime.persistSettings === false
    ? sanitizeSettings(rawSettings)
    : await saveSettings(rawSettings);
  const useParallel = mode !== 'manual' && settings.parallelProcessing && files.length > 1;
  const windows = await acquireBatchWindows(useParallel ? Math.min(settings.maxConcurrentTasks || PARALLEL_WORKER_COUNT, files.length) : 1, {
    show: settings.showBrowserWindow
  });
  const browser = windows[0];
  const releaseWindows = () => windows.forEach((window) => busyWindows.delete(window));

  try {
    const login = await getLoginStatus();
    if (!login.loggedIn) {
      loginFlowActive = true;
      browser.show();
      const automation = new DoubaoAutomation(browser);
      await automation.openLoginDialog().catch(() => {});
      throw new Error('请先在豆包窗口完成登录；登录状态会自动保存');
    }
  } catch (error) {
    releaseWindows();
    throw error;
  }

  batchEvent({
    type: 'batch-start',
    batchId,
    total: files.length,
    mode,
    path: runtime.eventPath || null,
    parallel: useParallel,
    workers: useParallel ? windows.length : 1
  });
  const results = [];
  // 并行模式下正在被使用的历史会话，避免两个任务同时写进同一会话
  const inUseConversations = new Set();
  // 批次级安全验证信号：任一任务完成验证后递增，正在执行的其他任务据此整任务重启
  const verificationEpoch = { value: 0 };

  const processAttempt = async (index, workerWindow, epochRef) => {
    const file = files[index];
    const eventPath = files.length === 1 && runtime.eventPath ? runtime.eventPath : file.path;
    const sourcePath = files.length === 1 && runtime.sourcePath ? runtime.sourcePath : file.path;
    const jobBase = {
      index,
      batchId,
      path: eventPath,
      name: path.basename(sourcePath),
      total: files.length,
      mode
    };
    batchEvent({ type: 'job-start', ...jobBase });

    const automation = new DoubaoAutomation(workerWindow, {
      isCancelled: () => cancelRef.value,
      // 信号值大于本任务基线，说明有任务完成了安全验证：本任务也可能已被波及，整任务重启
      shouldRestart: () => verificationEpoch.value > epochRef.value,
      onProgress: (message) => batchEvent({ type: 'job-progress', ...jobBase, message }),
      onVerificationRequired: () => {
        const persistentSession = session.fromPartition(DOUBAO_PARTITION);
        const doubaoWindows = BrowserWindow.getAllWindows().filter((window) =>
          window !== mainWindow && !window.isDestroyed() && window.webContents.session === persistentSession
        );
        for (const window of doubaoWindows) {
          if (window.isMinimized()) window.restore();
          window.show();
          window.moveTop();
        }
        if (process.platform === 'darwin') app.focus({ steal: true });
        const focusTarget = (workerWindow && !workerWindow.isDestroyed() && workerWindow) || doubaoWindows.at(-1) || browser;
        focusTarget.focus();
        batchEvent({ type: 'verification-required', ...jobBase });
      },
      onVerificationCleared: () => {
        verificationEpoch.value += 1;
        if (!settings.showBrowserWindow) {
          if (workerWindow && !workerWindow.isDestroyed()) workerWindow.hide();
          hideIdleDoubaoWindows();
        }
        batchEvent({ type: 'verification-cleared', ...jobBase });
      }
    });

    let taskConversationId = typeof file.conversationId === 'string' ? file.conversationId : '';
    // 并行时同一会话不能被两个任务同时使用，后来的任务另起新会话
    if (useParallel && taskConversationId && inUseConversations.has(taskConversationId)) taskConversationId = '';
    if (taskConversationId) inUseConversations.add(taskConversationId);
    let paddedUpload = null;
    try {
      if (settings.addPaddingBeforeUpload && settings.cropMode !== 'never') {
        const edgeName = settings.cropEdge === 'bottom' ? '底部' : '顶部';
        batchEvent({
          type: 'job-progress',
          ...jobBase,
          message: `正在给原图${edgeName}添加 ${settings.cropPercent}% 临时空白带`
        });
        paddedUpload = await preparePaddedUpload({
          sourcePath: file.path,
          nativeImage,
          temporaryDirectory: app.getPath('temp'),
          percent: settings.cropPercent,
          edge: settings.cropEdge
        });
      }
      const uploadPath = paddedUpload?.path || file.path;
      const { candidates, conversationId } = await automation.processImage({
        filePath: uploadPath,
        prompt: runtime.prompt || buildPrompt(settings),
        // 每个任务独占一个会话：有历史会话先接回（接回失败 processImage 内会自动开新对话），
        // 没有历史会话的一律开新对话，避免多张图串进同一会话、记录的会话 ID 互相覆盖
        newConversation: true,
        conversationId: taskConversationId,
        imageWaitSeconds: settings.imageWaitSeconds
      });
      let candidate;
      try {
        candidate = await downloadBestImage({
          candidates,
          electronSession: workerWindow.webContents.session,
          nativeImage,
          preferOriginal: settings.preferOriginal,
          onProgress: (message) => batchEvent({ type: 'job-progress', ...jobBase, message })
        });
      } catch (downloadError) {
        batchEvent({
          type: 'job-progress',
          ...jobBase,
          message: '大图链接不可直接下载，切换到高清画布导出'
        });
        try {
          candidate = await automation.captureLatestGeneratedCanvas(nativeImage, candidates);
        } catch (canvasError) {
          throw new Error(`${downloadError.message}；高清画布兜底也失败：${canvasError.message}`);
        }
      }
      const matchesUploadedImage = !String(candidate.source || '').startsWith('canvas')
        && (await isExactSourceImage(candidate, uploadPath)
          || (uploadPath !== file.path && await isExactSourceImage(candidate, file.path))
          || (sourcePath !== file.path && await isExactSourceImage(candidate, sourcePath)));
      if (matchesUploadedImage) {
        batchEvent({
          type: 'job-progress',
          ...jobBase,
          message: '候选资源与上传图片完全相同，已作废并切换到生成结果画布'
        });
        try {
          candidate = await automation.captureLatestGeneratedCanvas(nativeImage, candidates);
        } catch (canvasError) {
          throw new Error(`豆包返回了上传原图而不是生成结果；生成结果画布导出也失败：${canvasError.message}`);
        }
      }
      const saved = await saveProcessedImage({
        candidate,
        sourcePath,
        outputDirectory: settings.outputDirectory,
        settings,
        paddedUpload
      });
      const result = {
        ...jobBase,
        ...saved,
        conversationId: conversationId || taskConversationId || '',
        sourcePath: eventPath,
        outputPath: saved.path,
        path: eventPath
      };
      results.push(result);
      batchEvent({ type: 'job-complete', ...result });
      // 自动质检：不阻塞队列，对比完成后单独推送结论（失败静默忽略，不影响任务本身）
      runQcCheck(sourcePath, saved.path)
        .then((qc) => batchEvent({ type: 'job-qc', ...jobBase, outputPath: saved.path, qc }))
        .catch(() => {});
    } catch (error) {
      if (error.code === 'CANCELLED' || cancelRef.value) return;
      if (error.code === 'VERIFICATION_INTERRUPTED') return 'retry';
      const result = {
        ...jobBase,
        error: error.message || String(error),
        conversationId: error.conversationId || taskConversationId || ''
      };
      results.push(result);
      batchEvent({ type: 'job-error', ...result });
    } finally {
      if (taskConversationId) inUseConversations.delete(taskConversationId);
      if (paddedUpload?.directory) {
        await fs.rm(paddedUpload.directory, { recursive: true, force: true }).catch(() => {});
      }
    }
  };

  // 安全验证完成后整任务重启：验证中断后豆包可能假死或静默放弃生成，重跑是最可靠的恢复。
  // 每个任务最多重启 2 次；多线程下同批正在执行的任务也会收到信号一并重启
  const processAt = async (index, workerWindow) => {
    const maxVerificationRestarts = 2;
    const epochRef = { value: verificationEpoch.value };
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await processAttempt(index, workerWindow, epochRef);
      if (outcome !== 'retry' || cancelRef.value) return;
      if (attempt >= maxVerificationRestarts) {
        const file = files[index];
        const eventPath = files.length === 1 && runtime.eventPath ? runtime.eventPath : file.path;
        const sourcePath = files.length === 1 && runtime.sourcePath ? runtime.sourcePath : file.path;
        const result = {
          index,
          batchId,
          path: eventPath,
          name: path.basename(sourcePath),
          total: files.length,
          mode,
          error: '安全验证后任务仍被中断，请稍后重新开始该任务',
          conversationId: typeof files[index].conversationId === 'string' ? files[index].conversationId : ''
        };
        results.push(result);
        batchEvent({ type: 'job-error', ...result });
        return;
      }
      epochRef.value = verificationEpoch.value;
      batchEvent({
        type: 'job-progress',
        index,
        batchId,
        path: files.length === 1 && runtime.eventPath ? runtime.eventPath : files[index].path,
        name: path.basename(files.length === 1 && runtime.sourcePath ? runtime.sourcePath : files[index].path),
        total: files.length,
        mode,
        message: `安全验证已中断任务，正在重新开始（第 ${attempt + 1}/${maxVerificationRestarts} 次）`
      });
    }
  };

  try {
    if (!useParallel) {
      for (let index = 0; index < files.length; index += 1) {
        if (cancelRef.value) break;
        await processAt(index, browser);
        if (index < files.length - 1 && !cancelRef.value && settings.intervalSeconds > 0) {
          batchEvent({ type: 'batch-wait', seconds: settings.intervalSeconds, nextIndex: index + 1 });
          await new Promise((resolve) => setTimeout(resolve, settings.intervalSeconds * 1000));
        }
      }
    } else {
      // 多线程：每个工作窗口独立取任务；任务启动统一错开 5 秒，降低触发风控的概率
      let nextIndex = 0;
      let lastStartAt = 0;
      const worker = async (workerWindow) => {
        while (!cancelRef.value) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= files.length) return;
          if (lastStartAt) {
            const waitMs = PARALLEL_STAGGER_MS - (Date.now() - lastStartAt);
            if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
          if (cancelRef.value) return;
          lastStartAt = Date.now();
          await processAt(index, workerWindow);
        }
      };
      await Promise.all(windows.map((workerWindow) => worker(workerWindow)));
    }
  } finally {
    releaseWindows();
    const cancelled = cancelRef.value;
    batchEvent({
      type: 'batch-complete',
      batchId,
      cancelled,
      total: files.length,
      completed: results.filter((item) => item.outputPath && !item.error).length,
      failed: results.filter((item) => item.error).length,
      outputDirectory: settings.outputDirectory,
      mode,
      path: runtime.eventPath || null
    });
  }
  return results;
}

async function runManualEdit(payload = {}) {
  const sourcePath = typeof payload.sourcePath === 'string' ? path.resolve(payload.sourcePath) : '';
  const [source] = await validateImagePaths([sourcePath]);
  if (!source) throw new Error('原图不存在或格式不受支持');
  // 涂抹发送也要接回该图片的历史会话（没有历史会话时自动化层会自动开新对话）
  const conversationId = typeof payload.conversationId === 'string' && /^[0-9a-zA-Z_-]{6,64}$/.test(payload.conversationId)
    ? payload.conversationId
    : '';
  const markedUpload = await prepareManualMarkedUpload({
    sourcePath: source.path,
    nativeImage,
    temporaryDirectory: app.getPath('temp'),
    strokes: payload.strokes,
    brushPercent: payload.brushPercent
  });
  try {
    return await runBatch([markedUpload.path], payload.settings, {
      mode: 'manual',
      eventPath: source.path,
      sourcePath: source.path,
      prompt: buildManualEditPrompt(payload.settings),
      persistSettings: false,
      files: [{
        ...source,
        path: markedUpload.path,
        name: path.basename(markedUpload.path),
        width: markedUpload.width,
        height: markedUpload.height,
        conversationId
      }]
    });
  } finally {
    await fs.rm(markedUpload.directory, { recursive: true, force: true }).catch(() => {});
  }
}

// 自动质检：对比原图与处理结果，识别"疑似未处理 / 差异过大"并生成差异热力图。
// 无额外图像依赖：用 nativeImage 解码，统一缩到相同尺寸（≤512）后逐像素比较；
// 热力图按输出路径命名（同名覆盖，不会越积越多），存于 userData/qc。
async function runQcCheck(sourcePath, outputPath) {
  const sourceImage = nativeImage.createFromPath(sourcePath);
  const outputImage = nativeImage.createFromPath(outputPath);
  if (sourceImage.isEmpty() || outputImage.isEmpty()) throw new Error('质检图片读取失败');
  const sourceSize = sourceImage.getSize();
  const outputSize = outputImage.getSize();
  const scale = Math.min(1, 512 / Math.max(sourceSize.width, sourceSize.height, outputSize.width, outputSize.height));
  const width = Math.max(1, Math.round(Math.min(sourceSize.width, outputSize.width) * scale));
  const height = Math.max(1, Math.round(Math.min(sourceSize.height, outputSize.height) * scale));
  // toBitmap 为 BGRA 排列：红色通道在下标 2
  const sourcePixels = sourceImage.resize({ width, height, quality: 'good' }).toBitmap();
  const outputPixels = outputImage.resize({ width, height, quality: 'good' }).toBitmap();
  const stats = computeDiffStats(sourcePixels, outputPixels);
  const verdict = verdictForStats(stats);
  const heatmapPixels = buildHeatmap(sourcePixels, outputPixels, width, height, 2);
  const heatmap = nativeImage.createFromBitmap(heatmapPixels, { width, height });
  const directory = path.join(app.getPath('userData'), 'qc');
  await fs.mkdir(directory, { recursive: true });
  const key = crypto.createHash('sha1').update(outputPath).digest('hex').slice(0, 12);
  const heatmapPath = path.join(directory, `${key}.png`);
  await fs.writeFile(heatmapPath, heatmap.toPNG());
  return { verdict, ...stats, heatmapPath };
}

async function getImagePreviewData(targetPath, maxSize) {
  if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) {
    throw new Error('预览路径无效');
  }
  if (!SUPPORTED_EXTENSIONS.has(path.extname(targetPath).toLowerCase())) {
    throw new Error('该文件格式不支持预览');
  }
  const stat = await fs.stat(targetPath);
  if (!stat.isFile() || stat.size > 80 * 1024 * 1024) throw new Error('预览文件无效或过大');
  const image = nativeImage.createFromPath(targetPath);
  if (image.isEmpty()) throw new Error('无法读取处理结果');
  const { width, height } = image.getSize();
  // maxSize 不传时按预览大图处理（2560），传了则夹在 64-2560（如悬停气泡的 480）
  const requested = Math.round(Number(maxSize)) || 0;
  const limit = requested ? Math.min(2560, Math.max(64, requested)) : 2560;
  const scale = Math.min(1, limit / width, limit / height);
  const preview = scale < 1
    ? image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: 'good'
    })
    : image;
  return {
    name: path.basename(targetPath),
    width,
    height,
    dataUrl: preview.toDataURL()
  };
}

async function openImagePreviewWindow(payload) {
  // 兼容旧的纯路径入参；新入参 { targetPath, sourcePath } 会附带原图用于前后对比
  const targetPath = typeof payload === 'string' ? payload : payload?.targetPath;
  const sourcePath = typeof payload === 'object' && payload ? payload.sourcePath : '';
  const preview = await getImagePreviewData(targetPath);
  // 原图可能已被移动或删除，加载失败时不影响结果预览
  preview.source = await getImagePreviewData(sourcePath).catch(() => null);
  // 有原图时附带质检差异热力图（质检失败不影响预览）
  preview.qc = sourcePath
    ? await runQcCheck(sourcePath, targetPath)
        .then(async (qc) => ({
          verdict: qc.verdict,
          changedRatio: qc.changedRatio,
          meanDiff: qc.meanDiff,
          heatmap: await getImagePreviewData(qc.heatmapPath).catch(() => null)
        }))
        .catch(() => null)
    : null;
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.setTitle(`预览 · ${preview.name}`);
    previewWindow.webContents.send('preview:load', preview);
    if (previewWindow.isMinimized()) previewWindow.restore();
    previewWindow.show();
    previewWindow.focus();
    return true;
  }

  previewWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#101714',
    icon: APP_ICON_PATH,
    title: `预览 · ${preview.name}`,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preview-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  previewWindow.loadFile(path.join(__dirname, 'renderer', 'preview-window.html'));
  applyPlatformWindowTweaks(previewWindow);
  previewWindow.once('ready-to-show', () => {
    if (!previewWindow || previewWindow.isDestroyed()) return;
    previewWindow.show();
    previewWindow.focus();
  });
  previewWindow.webContents.once('did-finish-load', () => {
    if (previewWindow && !previewWindow.isDestroyed()) previewWindow.webContents.send('preview:load', preview);
  });
  previewWindow.on('closed', () => {
    previewWindow = null;
  });
  return true;
}

async function openManualEditWindow(payload = {}) {
  const sourcePath = typeof payload.path === 'string' ? payload.path : '';
  if (!sourcePath || !path.isAbsolute(sourcePath)) throw new Error('涂抹原图路径无效');
  if (!SUPPORTED_EXTENSIONS.has(path.extname(sourcePath).toLowerCase())) {
    throw new Error('该文件格式不支持涂抹');
  }
  const file = { path: sourcePath, name: path.basename(sourcePath) };
  if (manualWindow && !manualWindow.isDestroyed()) {
    manualWindow.setTitle(`手动涂抹 · ${file.name}`);
    manualWindow.webContents.send('manual:load', file);
    if (manualWindow.isMinimized()) manualWindow.restore();
    manualWindow.show();
    manualWindow.focus();
    return true;
  }

  manualWindow = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    backgroundColor: '#101714',
    icon: APP_ICON_PATH,
    title: `手动涂抹 · ${file.name}`,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'manual-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  manualWindow.loadFile(path.join(__dirname, 'renderer', 'manual-window.html'));
  applyPlatformWindowTweaks(manualWindow);
  manualWindow.once('ready-to-show', () => {
    if (!manualWindow || manualWindow.isDestroyed()) return;
    manualWindow.show();
    manualWindow.focus();
  });
  manualWindow.webContents.once('did-finish-load', () => {
    if (manualWindow && !manualWindow.isDestroyed()) manualWindow.webContents.send('manual:load', file);
  });
  manualWindow.on('closed', () => {
    manualWindow = null;
  });
  return true;
}

function openAdvancedSettingsWindow() {
  if (advancedWindow && !advancedWindow.isDestroyed()) {
    if (advancedWindow.isMinimized()) advancedWindow.restore();
    advancedWindow.show();
    advancedWindow.focus();
    return true;
  }

  advancedWindow = new BrowserWindow({
    width: 620,
    height: 680,
    minWidth: 540,
    minHeight: 620,
    backgroundColor: '#f5f4ef',
    icon: APP_ICON_PATH,
    title: '高级处理设置',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 18 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'advanced-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  advancedWindow.loadFile(path.join(__dirname, 'renderer', 'advanced-window.html'));
  applyPlatformWindowTweaks(advancedWindow);
  advancedWindow.once('ready-to-show', () => {
    if (!advancedWindow || advancedWindow.isDestroyed()) return;
    advancedWindow.show();
    advancedWindow.focus();
  });
  advancedWindow.on('closed', () => {
    advancedWindow = null;
  });
  return true;
}

function registerIpc() {
  ipcMain.handle('settings:get', loadSettings);
  ipcMain.handle('advanced:open', () => openAdvancedSettingsWindow());
  ipcMain.handle('advanced:save', async (_event, value) => {
    const settings = await saveSettings(value);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('settings:updated', settings);
    return settings;
  });
  ipcMain.on('advanced:close', () => {
    if (advancedWindow && !advancedWindow.isDestroyed()) advancedWindow.close();
  });
  ipcMain.handle('settings:save', (_event, value) => saveSettings(value));
  ipcMain.handle('queue:get', loadQueueRecords);
  ipcMain.handle('queue:save', (_event, records) => saveQueueRecords(records));
  ipcMain.handle('login:open', openDoubaoLogin);
  ipcMain.handle('login:logout', logoutDoubao);
  ipcMain.handle('login:status', getLoginStatus);
  ipcMain.handle('files:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要去水印的图片',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: [...SUPPORTED_EXTENSIONS].map((item) => item.slice(1)) }]
    });
    return result.canceled ? [] : validateImagePaths(result.filePaths);
  });
  ipcMain.handle('files:validate', (_event, paths) => validateImagePaths(paths));
  ipcMain.handle('image:preview', (_event, targetPath, maxSize) => getImagePreviewData(targetPath, maxSize));
  ipcMain.handle('image:open-preview', (_event, targetPath) => openImagePreviewWindow(targetPath));
  ipcMain.handle('manual:open', (_event, payload) => openManualEditWindow(payload));
  ipcMain.on('manual:submit', (_event, payload) => {
    if (manualWindow && !manualWindow.isDestroyed()) manualWindow.close();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('manual:submitted', payload);
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  ipcMain.on('manual:close', () => {
    if (manualWindow && !manualWindow.isDestroyed()) manualWindow.close();
  });
  ipcMain.handle('output:select', async (_event, currentDirectory) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择输出文件夹',
      defaultPath: currentDirectory || app.getPath('pictures'),
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('batch:start', (_event, payload) => runBatch(payload?.paths, payload?.settings));
  ipcMain.handle('manual:start', (_event, payload) => runManualEdit(payload));
  ipcMain.handle('batch:cancel', () => {
    activeCancelRefs.forEach((ref) => { ref.value = true; });
    return activeCancelRefs.size > 0;
  });
  ipcMain.handle('path:open', async (_event, targetPath) => {
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) return '无效路径';
    return shell.openPath(targetPath);
  });
}

// 去掉系统菜单栏后，macOS 的文本编辑快捷键（⌘C/⌘V 等）会随菜单一起消失，这里按窗口补回
const MENULESS_EDIT_ACTIONS = new Map([
  ['c', 'copy'],
  ['v', 'paste'],
  ['x', 'cut'],
  ['a', 'selectAll']
]);

function registerEditShortcuts() {
  if (process.platform !== 'darwin') return;
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return;
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || !input.meta || input.control || input.alt) return;
      const key = (input.key || '').toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        if (input.shift) contents.redo();
        else contents.undo();
        return;
      }
      if (key === 'w') {
        event.preventDefault();
        BrowserWindow.fromWebContents(contents)?.close();
        return;
      }
      if (key === 'q') {
        event.preventDefault();
        app.quit();
        return;
      }
      const action = MENULESS_EDIT_ACTIONS.get(key);
      if (!action) return;
      event.preventDefault();
      contents[action]();
    });
  });
}

// 自动更新：启动后静默检查 GitHub Releases，有新版时后台下载，下载完成后询问是否重启安装。
// 未签名的 macOS 包无法自动安装更新（Squirrel 限制），检查/下载会静默失败，用户仍走发布页手动下载。
// macOS 未签名包无法使用 Squirrel 自动更新：改为 GitHub API 检查 + 引导下载 dmg（半自动更新）
let macUpdateInProgress = false;
async function checkMacUpdate() {
  const { newerVersionFromRelease, pickReleaseAsset } = require('./update-check');
  const response = await fetch('https://api.github.com/repos/littlestone0806/doubao-watermark-lab/releases/latest', {
    headers: { 'User-Agent': 'watermark-lab-updater', Accept: 'application/vnd.github+json' }
  });
  if (!response.ok) return;
  const release = await response.json();
  const latest = newerVersionFromRelease(release, app.getVersion());
  if (!latest || macUpdateInProgress) return;
  macUpdateInProgress = true;
  try {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现新版本',
      message: `新版本 ${latest} 已发布（当前 ${app.getVersion()}）`,
      detail: '由于应用未做 Apple 签名，macOS 无法自动安装更新。点击“立即下载”将为你下载安装包并打开，拖入「应用程序」替换即可。',
      buttons: ['立即下载', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice.response !== 0) return;
    const asset = pickReleaseAsset(release, /mac-arm64\.dmg$/i);
    if (!asset) {
      shell.openExternal(release.html_url);
      return;
    }
    sendToRenderer('app:event', { type: 'update-downloading', version: latest });
    const target = path.join(app.getPath('downloads'), asset.name);
    const downloadResponse = await fetch(asset.url, {
      headers: { 'User-Agent': 'watermark-lab-updater' },
      redirect: 'follow'
    });
    if (!downloadResponse.ok) throw new Error(`下载失败 HTTP ${downloadResponse.status}`);
    const buffer = Buffer.from(await downloadResponse.arrayBuffer());
    await fs.writeFile(target, buffer);
    const openChoice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '下载完成',
      message: `新版本 ${latest} 安装包已下载完成`,
      detail: '打开 dmg 后把应用拖入「应用程序」替换旧版即可。',
      buttons: ['打开安装包', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (openChoice.response === 0) shell.openPath(target);
  } finally {
    macUpdateInProgress = false;
  }
}

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  if (process.platform === 'darwin') {
    const check = () => checkMacUpdate().catch(() => {});
    setTimeout(check, 6_000);
    setInterval(check, 4 * 60 * 60 * 1000);
    return;
  }
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => {
    sendToRenderer('app:event', { type: 'update-available', version: info?.version || '' });
  });
  autoUpdater.on('update-downloaded', async (info) => {
    const version = info?.version ? ` ${info.version}` : '';
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新已就绪',
      message: `新版本${version}已下载完成`,
      detail: '重启应用后即可使用新版本；选择“稍后”则下次退出时自动安装。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice.response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (error) => {
    console.warn(`自动更新检查失败：${error?.message || error}`);
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 6_000);
  setInterval(check, 4 * 60 * 60 * 1000);
}

app.whenReady().then(async () => {
  // 应用不使用系统菜单栏（macOS 顶部菜单与 Windows 窗口菜单一并移除）
  Menu.setApplicationMenu(null);
  registerEditShortcuts();
  const appIcon = nativeImage.createFromPath(APP_ICON_PATH);
  if (process.platform === 'darwin' && !appIcon.isEmpty()) app.dock.setIcon(appIcon);
  configureDoubaoSession();
  registerIpc();
  createMainWindow();
  setupAutoUpdater();
  await broadcastLoginStatus();
  app.on('activate', () => {
    // 退出过程中不再重建窗口，避免关闭后 Dock 点击又拉起主窗口
    if (!appQuitting && BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

let appQuitting = false;
app.on('before-quit', () => {
  appQuitting = true;
  clearInterval(loginTimer);
  activeCancelRefs.forEach((ref) => { ref.value = true; });
  // 强制销毁所有窗口：豆包页面可能带 beforeunload，优雅关闭可能被拦截导致进程残留
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.destroy();
  }
});
