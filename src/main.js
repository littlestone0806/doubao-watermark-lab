'use strict';

const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
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
  imageWaitSeconds: 30,
  parallelProcessing: false,
  showBrowserWindow: true,
  themeMode: 'auto',
  colorPalette: 'forest',
  themeColor: PALETTE_COLORS.forest,
  automationSafetyVersion: AUTOMATION_SAFETY_VERSION,
  cropStrategyVersion: CROP_STRATEGY_VERSION
};

let mainWindow;
let doubaoWindow;
let previewWindow;
let loginTimer;
let loginFlowActive = false;
let running = false;
let cancelRequested = false;

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
    imageWaitSeconds: Math.min(300, Math.max(5, Number.isFinite(Number(input.imageWaitSeconds)) ? Math.round(Number(input.imageWaitSeconds)) : 30)),
    parallelProcessing: input.parallelProcessing === true,
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
  const temporary = `${settingsPath()}.tmp`;
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
  const temporary = `${queueRecordsPath()}.tmp`;
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

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 680,
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
  mainWindow.on('closed', () => {
    mainWindow = null;
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
  if (running) throw new Error('批处理运行期间不能退出登录');
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

function hideDoubaoWindows() {
  const persistentSession = session.fromPartition(DOUBAO_PARTITION);
  for (const window of BrowserWindow.getAllWindows()) {
    if (window !== mainWindow && !window.isDestroyed() && window.webContents.session === persistentSession) {
      window.hide();
    }
  }
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

async function ensureBatchWindows(count, { show }) {
  const windows = [createDoubaoWindow({ focus: show })];
  while (auxWorkerWindows.length < count - 1) {
    auxWorkerWindows.push(createAuxWorkerWindow(auxWorkerWindows.length));
  }
  for (const extra of auxWorkerWindows.splice(Math.max(0, count - 1))) {
    extra.destroy();
  }
  windows.push(...auxWorkerWindows);
  if (show) {
    windows.forEach((window, index) => {
      if (index === 0) return;
      window.setPosition(90 + index * 56, 70 + index * 48);
      window.show();
    });
    windows[0].focus();
  } else {
    hideDoubaoWindows();
  }
  await Promise.all(windows.map(waitForDoubaoLoad));
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
  if (running) throw new Error('已有批处理任务正在运行');
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
  const mode = runtime.mode === 'manual' ? 'manual' : 'batch';
  const useParallel = mode !== 'manual' && settings.parallelProcessing && files.length > 1;
  const windows = await ensureBatchWindows(useParallel ? Math.min(PARALLEL_WORKER_COUNT, files.length) : 1, {
    show: settings.showBrowserWindow
  });
  const browser = windows[0];

  const login = await getLoginStatus();
  if (!login.loggedIn) {
    loginFlowActive = true;
    browser.show();
    const automation = new DoubaoAutomation(browser);
    await automation.openLoginDialog().catch(() => {});
    throw new Error('请先在豆包窗口完成登录；登录状态会自动保存');
  }

  running = true;
  cancelRequested = false;
  batchEvent({
    type: 'batch-start',
    total: files.length,
    mode,
    path: runtime.eventPath || null,
    parallel: useParallel,
    workers: useParallel ? windows.length : 1
  });
  const results = [];
  // 并行模式下正在被使用的历史会话，避免两个任务同时写进同一会话
  const inUseConversations = new Set();

  const processAt = async (index, workerWindow) => {
    const file = files[index];
    const eventPath = files.length === 1 && runtime.eventPath ? runtime.eventPath : file.path;
    const sourcePath = files.length === 1 && runtime.sourcePath ? runtime.sourcePath : file.path;
    const jobBase = {
      index,
      path: eventPath,
      name: path.basename(sourcePath),
      total: files.length,
      mode
    };
    batchEvent({ type: 'job-start', ...jobBase });

    const automation = new DoubaoAutomation(workerWindow, {
      isCancelled: () => cancelRequested,
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
        if (!settings.showBrowserWindow) hideDoubaoWindows();
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
    } catch (error) {
      if (error.code === 'CANCELLED' || cancelRequested) return;
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

  try {
    if (!useParallel) {
      for (let index = 0; index < files.length; index += 1) {
        if (cancelRequested) break;
        await processAt(index, browser);
        if (index < files.length - 1 && !cancelRequested && settings.intervalSeconds > 0) {
          batchEvent({ type: 'batch-wait', seconds: settings.intervalSeconds, nextIndex: index + 1 });
          await new Promise((resolve) => setTimeout(resolve, settings.intervalSeconds * 1000));
        }
      }
    } else {
      // 多线程：每个工作窗口独立取任务；任务启动统一错开 5 秒，降低触发风控的概率
      let nextIndex = 0;
      let lastStartAt = 0;
      const worker = async (workerWindow) => {
        while (!cancelRequested) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= files.length) return;
          if (lastStartAt) {
            const waitMs = PARALLEL_STAGGER_MS - (Date.now() - lastStartAt);
            if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
          if (cancelRequested) return;
          lastStartAt = Date.now();
          await processAt(index, workerWindow);
        }
      };
      await Promise.all(windows.map((workerWindow) => worker(workerWindow)));
    }
  } finally {
    running = false;
    const cancelled = cancelRequested;
    cancelRequested = false;
    batchEvent({
      type: 'batch-complete',
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
  if (running) throw new Error('已有处理任务正在运行');
  const sourcePath = typeof payload.sourcePath === 'string' ? path.resolve(payload.sourcePath) : '';
  const [source] = await validateImagePaths([sourcePath]);
  if (!source) throw new Error('原图不存在或格式不受支持');
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
        height: markedUpload.height
      }]
    });
  } finally {
    await fs.rm(markedUpload.directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function getImagePreviewData(targetPath) {
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
  const scale = Math.min(1, 1800 / width, 1200 / height);
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

async function openImagePreviewWindow(targetPath) {
  const preview = await getImagePreviewData(targetPath);
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

function registerIpc() {
  ipcMain.handle('settings:get', loadSettings);
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
  ipcMain.handle('image:preview', (_event, targetPath) => getImagePreviewData(targetPath));
  ipcMain.handle('image:open-preview', (_event, targetPath) => openImagePreviewWindow(targetPath));
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
    if (running) cancelRequested = true;
    return running;
  });
  ipcMain.handle('path:open', async (_event, targetPath) => {
    if (typeof targetPath !== 'string' || !path.isAbsolute(targetPath)) return '无效路径';
    return shell.openPath(targetPath);
  });
}

app.whenReady().then(async () => {
  const appIcon = nativeImage.createFromPath(APP_ICON_PATH);
  if (process.platform === 'darwin' && !appIcon.isEmpty()) app.dock.setIcon(appIcon);
  configureDoubaoSession();
  registerIpc();
  createMainWindow();
  await broadcastLoginStatus();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  clearInterval(loginTimer);
  cancelRequested = true;
});
