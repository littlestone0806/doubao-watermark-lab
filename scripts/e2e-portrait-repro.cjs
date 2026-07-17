'use strict';

/*
 * 竖屏图片问题复现：生成/使用 800×1800 竖屏图，分别截图：
 *  1) 预览窗口适合模式  2) 预览窗口放大 2 倍  3) 手动涂抹弹窗
 * 用于确认“竖屏显示不全”“缩放从正下方展开”的真实表现，修复后再次运行对比。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGE = path.join(CWD, 'e2e-test-images', 'portrait-800x1800.png');
const PORT = 9342;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const OUT_DIR = path.join(CWD, 'docs', 'repro-portrait');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[repro ${new Date().toISOString().slice(11, 19)}] ${message}`);

class CDP {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const packet = JSON.parse(event.data);
      if (packet.id && this.pending.has(packet.id)) {
        const { resolve, reject } = this.pending.get(packet.id);
        this.pending.delete(packet.id);
        if (packet.error) reject(new Error(packet.error.message));
        else resolve(packet.result);
      }
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`页面脚本异常: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  async screenshot(filePath) {
    await this.send('Page.enable').catch(() => {});
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
    log(`截图: ${path.basename(filePath)}`);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: CWD, detached: true, stdio: 'ignore'
  });
  const killApp = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', killApp);

  let renderer = null;
  let preview = null;
  try {
    const boot = Date.now();
    while (Date.now() - boot < 30_000) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
      await sleep(500);
    }
    let targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    renderer = new CDP(targets.find((target) => target.url.includes('renderer/index.html')).webSocketDebuggerUrl);
    const readyWait = Date.now();
    while (Date.now() - readyWait < 15_000) {
      const ready = await renderer.evaluate(`typeof state !== 'undefined' && typeof addFiles === 'function'`).catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    await renderer.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');
    await renderer.evaluate(`(async () => { await addFiles(await watermarkLab.validatePaths(${JSON.stringify([IMAGE])})); return true; })()`);
    log('竖屏图已加入队列');

    // ---- 预览窗口 ----
    await renderer.evaluate(`watermarkLab.openPreviewWindow(${JSON.stringify(IMAGE)}); "ok"`);
    let previewTarget = null;
    const waitWin = Date.now();
    while (Date.now() - waitWin < 15_000) {
      await sleep(600);
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      previewTarget = targets.find((target) => target.url.includes('preview-window.html'));
      if (previewTarget) break;
    }
    if (!previewTarget) throw new Error('预览窗口未出现');
    preview = new CDP(previewTarget.webSocketDebuggerUrl);
    await sleep(2500);
    const fitInfo = await preview.evaluate(`(() => {
      const stage = document.querySelector('#previewStage').getBoundingClientRect();
      const img = document.querySelector('#previewImage').getBoundingClientRect();
      return { stage: { w: Math.round(stage.width), h: Math.round(stage.height) }, img: { w: Math.round(img.width), h: Math.round(img.height), top: Math.round(img.top - stage.top), bottom: Math.round(stage.bottom - img.bottom) } };
    })()`);
    log(`预览·适合: ${JSON.stringify(fitInfo)}`);
    await preview.screenshot(path.join(OUT_DIR, 'preview-fit.png'));

    await preview.evaluate(`(() => {
      const stage = document.querySelector('#previewStage').getBoundingClientRect();
      setZoom(2, stage.left + stage.width * 0.25, stage.top + stage.height * 0.25);
      return 'z';
    })()`);
    await sleep(600);
    const zoomInfo = await preview.evaluate(`(() => {
      const stage = document.querySelector('#previewStage').getBoundingClientRect();
      const img = document.querySelector('#previewImage').getBoundingClientRect();
      return { zoom, panX: Math.round(panX), panY: Math.round(panY), img: { w: Math.round(img.width), h: Math.round(img.height), top: Math.round(img.top - stage.top), bottom: Math.round(stage.bottom - img.bottom) } };
    })()`);
    log(`预览·2倍(锚点25%,25%): ${JSON.stringify(zoomInfo)}`);
    await preview.screenshot(path.join(OUT_DIR, 'preview-zoom2.png'));

    // ---- 手动涂抹弹窗 ----
    await renderer.evaluate(`(() => {
      const file = state.files.find((item) => item.path === ${JSON.stringify(IMAGE)});
      openManualEditor(file);
      return true;
    })()`);
    await sleep(2500);
    const manualInfo = await renderer.evaluate(`(() => {
      const stage = document.querySelector('#manualEditorStage').getBoundingClientRect();
      const canvas = document.querySelector('#manualEditorCanvas');
      const rect = canvas.getBoundingClientRect();
      return { stage: { w: Math.round(stage.width), h: Math.round(stage.height) }, canvas: { attrW: canvas.width, attrH: canvas.height, cssW: Math.round(rect.width), cssH: Math.round(rect.height), top: Math.round(rect.top - stage.top), bottom: Math.round(stage.bottom - rect.bottom) }, hidden: canvas.classList.contains('is-hidden') };
    })()`);
    log(`涂抹弹窗: ${JSON.stringify(manualInfo)}`);
    await renderer.screenshot(path.join(OUT_DIR, 'manual-editor.png'));

    // ---- 涂抹缩放 + 平移 ----
    await renderer.evaluate(`(() => {
      const stage = document.querySelector('#manualEditorStage').getBoundingClientRect();
      setManualZoom(2, stage.left + stage.width * 0.3, stage.top + stage.height * 0.3);
      return true;
    })()`);
    await sleep(500);
    const manualZoomInfo = await renderer.evaluate(`(() => {
      const stage = document.querySelector('#manualEditorStage').getBoundingClientRect();
      const rect = document.querySelector('#manualEditorCanvas').getBoundingClientRect();
      return { zoom: manualZoom, panX: Math.round(manualPanX), panY: Math.round(manualPanY), cssW: Math.round(rect.width), cssH: Math.round(rect.height), transform: document.querySelector('#manualEditorCanvas').style.transform };
    })()`);
    log(`涂抹·2倍(锚点30%,30%): ${JSON.stringify(manualZoomInfo)}`);
    await renderer.evaluate('manualPanY -= 120; applyManualTransform(); "p"');
    await sleep(300);
    await renderer.screenshot(path.join(OUT_DIR, 'manual-editor-zoom2.png'));
    await renderer.evaluate('closeManualEditor(); "c"');

    // ---- 清理：把测试图从队列移除并持久化 ----
    await renderer.evaluate(`(() => {
      const index = state.files.findIndex((item) => item.path === ${JSON.stringify(IMAGE)});
      if (index >= 0) state.files.splice(index, 1);
      renderQueue();
      persistQueueNow();
      return index;
    })()`);
    log('测试图已从队列移除');
  } finally {
    preview?.close();
    renderer?.close();
    killApp();
    log('应用已关闭');
  }
}

main().catch((error) => {
  console.error('复现失败:', error.message);
  process.exitCode = 1;
});
