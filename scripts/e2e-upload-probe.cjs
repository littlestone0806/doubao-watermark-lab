'use strict';

/*
 * 上传链路诊断探针（一次性，排查"图片已选择，但豆包没有显示上传预览"）：
 * 启动应用 → 加入一张测试图并开始处理 → 在豆包页面每 2 秒采样一次 DOM：
 * file input 状态（files 数/是否有我们的标记）、页面上 ≥40px 的图片（位置/src 前缀）、
 * 视口高度、输入框文字。用于判断上传是否真的发生、预览长什么样、检测条件哪里失效。
 * 结束后恢复队列现场并关闭应用。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGE = path.join(CWD, 'e2e-test-images', 'e2e-1.png');
const PORT = 9341;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[probe ${new Date().toISOString().slice(11, 19)}] ${message}`);

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

async function waitForPortUp(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return true; } catch { /* wait */ }
    await sleep(500);
  }
  return false;
}

async function targets() {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    return [];
  }
}

async function connectRenderer() {
  const mainTarget = (await targets()).find((target) => target.url.includes('renderer/index.html'));
  if (!mainTarget) throw new Error('找不到渲染进程目标');
  return new CDP(mainTarget.webSocketDebuggerUrl);
}

async function connectDoubao() {
  const target = (await targets()).find((item) => item.url.includes('doubao.com'));
  return target ? new CDP(target.webSocketDebuggerUrl) : null;
}

const DUMP = `(() => {
  const inputs = [...document.querySelectorAll('input[type="file"]')].map((i) => ({
    files: i.files && i.files.length || 0,
    marked: i.hasAttribute('data-watermark-lab-upload'),
    accept: (i.getAttribute('accept') || '').slice(0, 30)
  }));
  const imgs = [...document.images]
    .map((im) => { const r = im.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), src: (im.currentSrc || im.src || '').slice(0, 70) }; })
    .filter((x) => x.w >= 40 && x.h >= 30)
    .slice(0, 8);
  const composer = document.querySelector('textarea, [contenteditable="true"]');
  const text = composer ? String(composer.value || composer.innerText || '').slice(0, 30) : '';
  return JSON.stringify({ href: location.href.slice(-30), vh: innerHeight, inputs, imgs, text });
})()`;

async function main() {
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: CWD, detached: true, stdio: 'ignore' });
  const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('SIGINT', () => { kill(); process.exit(130); });

  let cdp = null;
  let selectionSnapshot = null;
  try {
    if (!(await waitForPortUp(30_000))) throw new Error('应用启动超时');
    cdp = await connectRenderer();
    const login = await cdp.evaluate('(async () => await watermarkLab.getLoginStatus())()');
    log(`登录状态: ${login?.loggedIn ? '已登录' : '未登录'}`);
    if (!login?.loggedIn) return;

    await cdp.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');
    selectionSnapshot = await cdp.evaluate('state.files.map((file) => [file.path, file.selected !== false])');
    await cdp.evaluate('state.files.forEach((file) => { file.selected = false; }); renderQueue(); "ok"');
    await cdp.evaluate(`(async () => { await addFiles(await watermarkLab.validatePaths(${JSON.stringify([IMAGE])})); return state.files.length; })()`);
    await cdp.evaluate('document.querySelector("#startButton").click(); "started"');
    log('已开始任务，每 2 秒采样豆包页面 DOM（共 15 次）…');

    for (let i = 0; i < 15; i += 1) {
      await sleep(2000);
      const doubao = await connectDoubao();
      if (!doubao) { log(`#${i + 1} 无豆包页面目标`); continue; }
      const dump = await doubao.evaluate(DUMP).catch((error) => `采样失败: ${error.message}`);
      doubao.close();
      log(`#${i + 1} ${dump}`);
    }

    const status = await cdp.evaluate('JSON.stringify(state.files.map((f) => ({ name: f.name, status: f.status, error: f.error || "" })))');
    log(`任务最终状态: ${status}`);
  } finally {
    if (cdp && selectionSnapshot) {
      try {
        await cdp.evaluate(`(async () => {
          const testPaths = new Set(${JSON.stringify([IMAGE])});
          state.files = state.files.filter((file) => !testPaths.has(file.path));
          const selection = new Map(${JSON.stringify(selectionSnapshot)});
          state.files.forEach((file) => { if (selection.has(file.path)) file.selected = selection.get(file.path); });
          renderQueue();
          await persistQueueNow();
          return 'restored';
        })()`);
        log('已恢复队列现场');
      } catch (error) {
        console.error(`恢复现场失败: ${error.message}`);
      }
    }
    cdp?.close();
    kill();
  }
}

main().catch((error) => {
  console.error('探针失败:', error.message);
  process.exitCode = 3;
});
