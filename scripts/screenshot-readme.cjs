'use strict';

/*
 * README 截图工具：启动应用，把队列临时替换为示例图片（不写盘、不持久化），
 * 遮住输出目录的真实路径，然后用 CDP 截取主窗口 PNG 到 docs/screenshot-main.png。
 * 结束后恢复真实队列（仅内存态）并关闭应用。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const PORT = 9341;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const DEMO_DIR = path.join(CWD, 'scripts', '.demo-tmp');
const OUTPUT = path.join(CWD, 'docs', 'screenshot-main.png');
const DEMO_NAMES = ['示例-风景照片.png', '示例-产品宣传图.png', '示例-人物写真.png'];
const DEMO_SOURCES = ['e2e-1.png', 'e2e-2.png', 'e2e-3.png'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[shot ${new Date().toISOString().slice(11, 19)}] ${message}`);

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

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function main() {
  fs.mkdirSync(DEMO_DIR, { recursive: true });
  const demoPaths = DEMO_NAMES.map((name, index) => {
    const target = path.join(DEMO_DIR, name);
    fs.copyFileSync(path.join(CWD, 'e2e-test-images', DEMO_SOURCES[index]), target);
    return target;
  });
  log('示例图片已就绪');

  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: CWD, detached: true, stdio: 'ignore'
  });
  const killApp = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', killApp);

  let cdp = null;
  try {
    const boot = Date.now();
    while (Date.now() - boot < 30_000) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
      await sleep(500);
    }
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    cdp = new CDP(targets.find((target) => target.url.includes('renderer/index.html')).webSocketDebuggerUrl);
    await cdp.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');

    log('临时替换队列为示例图片（仅内存态，不写盘）…');
    await cdp.evaluate(`(async () => {
      window.__realFiles = state.files;
      const demo = await watermarkLab.validatePaths(${JSON.stringify(demoPaths)});
      state.files = demo.map((file, index) => ({
        ...file,
        selected: true,
        status: index === 0 ? 'complete' : '',
        progress: index === 0 ? 100 : 0,
        message: index === 0 ? '已完成，已导出' : ''
      }));
      const output = document.querySelector('#outputPath');
      if (output) {
        output.textContent = '~/Pictures/水印清理输出';
        output.title = '~/Pictures/水印清理输出';
      }
      renderQueue();
      return state.files.length;
    })()`);
    await sleep(1200);

    log('截取主窗口…');
    await cdp.send('Page.enable').catch(() => {});
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, Buffer.from(shot.data, 'base64'));
    const kb = Math.round(fs.statSync(OUTPUT).size / 1024);
    log(`截图已保存: ${OUTPUT}（${kb} KB）`);

    log('恢复真实队列…');
    await cdp.evaluate(`(() => {
      if (window.__realFiles) {
        state.files = window.__realFiles;
        delete window.__realFiles;
      }
      renderQueue();
      return true;
    })()`);
  } finally {
    cdp?.close();
    killApp();
    fs.rmSync(DEMO_DIR, { recursive: true, force: true });
    log('应用已关闭，临时目录已清理');
  }
}

main().catch((error) => {
  console.error('截图失败:', error.message);
  process.exitCode = 1;
});
