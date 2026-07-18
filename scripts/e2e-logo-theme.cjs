'use strict';

/*
 * 主题色联动截图（开发用）：node scripts/e2e-logo-theme.cjs
 * 启动开发版应用，依次切换调色盘并截取主窗口，验证左上角 logo 随主题色变化。
 * 截图保存到 .qc-demo/shots/（该目录已 gitignore）。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const PORT = 9343;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const SHOTS = path.join(CWD, '.qc-demo', 'shots');

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
    console.log(`已截图: ${path.basename(filePath)}`);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: CWD, detached: true, stdio: 'ignore' });
  const killApp = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', killApp);

  let main = null;
  try {
    const boot = Date.now();
    while (Date.now() - boot < 30_000) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
      await sleep(500);
    }
    const targets = await (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
    main = new CDP(targets.find((target) => target.url.includes('renderer/index.html')).webSocketDebuggerUrl);
    await sleep(3000);

    for (const palette of ['ocean', 'sunset', 'forest']) {
      await main.evaluate(`document.querySelector('[data-palette="${palette}"]').click(); "ok"`);
      await sleep(600);
      const logoBg = await main.evaluate(`getComputedStyle(document.querySelector('.brand-mark')).backgroundImage`);
      console.log(`${palette}: logo 背景 = ${logoBg.match(/rgb[^)]*\)/g)?.slice(0, 2).join(' → ')}`);
      await main.screenshot(path.join(SHOTS, `主题联动-${palette}.png`));
    }
  } finally {
    main?.close();
    killApp();
    console.log('应用已关闭');
  }
}

main().catch((error) => {
  console.error('失败:', error.message);
  process.exitCode = 1;
});
