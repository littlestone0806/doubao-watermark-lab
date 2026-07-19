'use strict';

/* 快速验证采集来源小标记的渲染：注入三条假完成记录（直取/降级裁切/页面采集）后截图队列区 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const PORT = 9339;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const id = this.nextId++;
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
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: CWD, detached: true, stdio: 'ignore' });
  const killApp = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', killApp);
  try {
    for (let i = 0; i < 60; i += 1) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch { /* wait */ }
      await sleep(500);
    }
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const mainTarget = targets.find((t) => t.url.includes('renderer/index.html'));
    const cdp = new CDP(mainTarget.webSocketDebuggerUrl);

    const thumb = await cdp.evaluate(`(() => {
      const c = document.createElement('canvas'); c.width = 8; c.height = 8;
      const g = c.getContext('2d'); g.fillStyle = '#69c'; g.fillRect(0, 0, 8, 8);
      return c.toDataURL();
    })()`);
    await cdp.evaluate(`(() => {
      const mk = (name, captureSource, removedUploadPadding, cropped) => ({
        path: '/tmp/fake-' + name + '.png', name, selected: false, status: 'complete', message: '',
        width: 2560, height: 1696, bytes: 1234567, thumbnail: ${JSON.stringify(thumb)},
        outputPath: '/tmp/out-' + name + '.png', captureSource, removedUploadPadding, cropped, progress: 100
      });
      state.files = [
        mk('直取示例.png', 'api-raw', false, false),
        mk('降级示例.png', 'network', true, true),
        mk('页面采集示例.png', 'dom', false, false),
        ...state.files
      ];
      renderQueue();
      return state.files.length;
    })()`);
    await sleep(600);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    require('node:fs').writeFileSync(path.join(CWD, '.tmp-badge-check.png'), Buffer.from(shot.data, 'base64'));
    const flags = await cdp.evaluate(`[...document.querySelectorAll('.capture-flag')].map((f) => f.textContent + '|' + f.className)`);
    console.log('标记元素:', JSON.stringify(flags, null, 2));
    cdp.close();
  } finally {
    killApp();
  }
}

main().catch((error) => { console.error('探针失败:', error.message); process.exitCode = 1; });
