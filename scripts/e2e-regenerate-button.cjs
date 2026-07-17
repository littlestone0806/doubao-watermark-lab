'use strict';

/*
 * 重新生成按钮 E2E：
 *  1) 完成的任务项上，重置图标出现在预览按钮左侧
 *  2) 运行中时按钮禁用且点击无效（不会触发任何批处理）
 *  3) 截图留存
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGE = path.join(CWD, 'e2e-test-images', 'portrait-800x1800.png');
const PORT = 9345;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const OUT_DIR = path.join(CWD, 'docs', 'repro-regenerate');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[regen-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);
let failures = 0;
function assert(condition, label) {
  if (condition) log(`  ✔ ${label}`);
  else { failures += 1; log(`  ✘ ${label}`); }
}

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
  try {
    const boot = Date.now();
    while (Date.now() - boot < 30_000) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
      await sleep(500);
    }
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    renderer = new CDP(targets.find((target) => target.url.includes('renderer/index.html')).webSocketDebuggerUrl);
    const readyWait = Date.now();
    while (Date.now() - readyWait < 15_000) {
      const ready = await renderer.evaluate(`typeof state !== 'undefined' && typeof addFiles === 'function'`).catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    await renderer.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');
    await renderer.evaluate(`(() => {
      const index = state.files.findIndex((item) => item.path === ${JSON.stringify(IMAGE)});
      if (index >= 0) { state.files.splice(index, 1); renderQueue(); persistQueueNow(); }
      return index;
    })()`);
    await renderer.evaluate(`(async () => { await addFiles(await watermarkLab.validatePaths(${JSON.stringify([IMAGE])})); return true; })()`);

    // 标记为已完成并渲染结果操作区
    await renderer.evaluate(`(() => {
      const file = state.files.find((item) => item.path === ${JSON.stringify(IMAGE)});
      updateFile(file.path, { status: 'complete', outputPath: file.path, message: '' });
      renderQueue();
      return true;
    })()`);
    await sleep(400);

    const layout = await renderer.evaluate(`(() => {
      const item = document.querySelector('.queue-item');
      const actions = [...item.querySelectorAll('.result-action-button')];
      const regen = item.querySelector('.regenerate-result');
      return {
        classes: actions.map((button) => button.className.replace('result-action-button ', '')),
        hasSvg: !!regen?.querySelector('svg'),
        title: regen?.title || '',
        ariaLabel: regen?.getAttribute('aria-label') || '',
        disabled: regen?.disabled
      };
    })()`);
    log(`按钮布局: ${JSON.stringify(layout)}`);
    assert(layout.classes[0] === 'regenerate-result', '重置图标在预览按钮左侧（第一个）');
    assert(layout.classes[1] === 'preview-result', '预览按钮紧随其后');
    assert(layout.hasSvg && layout.ariaLabel === '重新生成', '重置按钮带图标和无障碍标签');
    assert(layout.disabled === false, '空闲时按钮可用');

    // 运行中禁用且点击无效
    await renderer.evaluate('state.running = true; renderQueue(); "r"');
    await sleep(300);
    const runningInfo = await renderer.evaluate(`(() => {
      const regen = document.querySelector('.regenerate-result');
      const before = regen.disabled;
      regen.click();
      return { disabled: before };
    })()`);
    assert(runningInfo.disabled === true, '运行中按钮禁用');
    await sleep(800);
    const targetsAfter = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    assert(!targetsAfter.some((target) => /doubao\.com/.test(target.url)), '运行中点击没有触发任何豆包页面');
    await renderer.evaluate('state.running = false; renderQueue(); "r"');
    await sleep(300);

    await renderer.screenshot(path.join(OUT_DIR, 'regenerate-button.png'));

    // 清理
    await renderer.evaluate(`(() => {
      const index = state.files.findIndex((item) => item.path === ${JSON.stringify(IMAGE)});
      if (index >= 0) state.files.splice(index, 1);
      renderQueue();
      persistQueueNow();
      return index;
    })()`);
    log('测试图已从队列移除');
  } finally {
    renderer?.close();
    killApp();
    log('应用已关闭');
  }
  if (failures) {
    console.error(`\n${failures} 项断言失败`);
    process.exitCode = 1;
  } else {
    log('全部断言通过');
  }
}

main().catch((error) => {
  console.error('E2E 失败:', error.message);
  process.exitCode = 1;
});
