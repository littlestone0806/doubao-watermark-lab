'use strict';

/*
 * 质检演示截图（开发用）：node scripts/qc-demo-shots.cjs
 * 启动开发版应用，截取主窗口黄标与预览窗差异热力图，保存到 .qc-demo/shots/。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const PORT = 9342;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const DEMO = path.join(CWD, '.qc-demo');
const SHOTS = path.join(DEMO, 'shots');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[shots ${new Date().toISOString().slice(11, 19)}] ${message}`);

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
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  async screenshot(filePath) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
    log(`已截图: ${path.basename(filePath)}`);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function listTargets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
}

async function waitTarget(urlPart, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(400);
    const target = (await listTargets()).find((item) => item.url.includes(urlPart) && item.type === 'page');
    if (target) return new CDP(target.webSocketDebuggerUrl);
  }
  throw new Error(`窗口未出现: ${urlPart}`);
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: CWD, detached: true, stdio: 'ignore' });
  const killApp = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', killApp);

  let main = null;
  let preview = null;
  try {
    const boot = Date.now();
    while (Date.now() - boot < 30_000) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
      await sleep(500);
    }
    main = await waitTarget('renderer/index.html');
    await sleep(3000);
    await main.screenshot(path.join(SHOTS, '1-主窗口-黄标.png'));

    const openPreview = async (sourceName, outputName) => {
      const payload = {
        targetPath: path.join(DEMO, outputName),
        sourcePath: path.join(DEMO, sourceName)
      };
      await main.evaluate(`watermarkLab.openPreviewWindow(${JSON.stringify(payload)}); "ok"`);
      preview?.close();
      preview = await waitTarget('preview-window.html');
      await sleep(1800);
      return preview;
    };

    const diffWin = await openPreview('演示-差异过大.png', '演示-差异过大-输出.png');
    await diffWin.evaluate(`document.querySelector('#diffToggle').click(); "ok"`);
    await sleep(600);
    await diffWin.screenshot(path.join(SHOTS, '2-预览-差异过大-热力图.png'));

    const unchangedWin = await openPreview('演示-疑似未处理.png', '演示-疑似未处理-输出.png');
    await unchangedWin.screenshot(path.join(SHOTS, '3-预览-疑似未处理-警示按钮.png'));
    await unchangedWin.evaluate(`document.querySelector('#diffToggle').click(); "ok"`);
    await sleep(600);
    await unchangedWin.screenshot(path.join(SHOTS, '4-预览-疑似未处理-热力图.png'));
  } finally {
    preview?.close();
    main?.close();
    killApp();
    log('应用已关闭');
  }
  console.log(`截图目录: ${SHOTS}`);
}

main().catch((error) => {
  console.error('截图失败:', error.message);
  process.exitCode = 1;
});
