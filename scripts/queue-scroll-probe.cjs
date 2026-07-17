'use strict';

/* 队列滚动行为测量：注入 20 个虚拟任务，测量列表是否可滚动、条目是否被压扁。
 * 不写入任何磁盘数据（注入前关闭 queueReady，阻止持久化）。 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const PORT = 9335;
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

async function main() {
  log('启动应用…');
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: CWD, detached: true, stdio: 'ignore'
  });
  const killApp = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', killApp);
  process.on('SIGINT', () => { killApp(); process.exit(130); });
  process.on('SIGTERM', () => { killApp(); process.exit(143); });

  try {
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
      await sleep(500);
    }
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const mainTarget = targets.find((target) => target.url.includes('renderer/index.html'));
    const cdp = new CDP(mainTarget.webSocketDebuggerUrl);

    await cdp.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');

    const metrics = await cdp.evaluate(`(() => {
      state.queueReady = false; // 阻止把虚拟数据写盘
      const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      state.files = Array.from({ length: 20 }, (_, i) => ({
        path: '/fake/probe-' + i + '.png',
        name: '测量用测试图片-' + String(i + 1).padStart(2, '0') + '.png',
        bytes: 1234567, width: 1920, height: 1080, thumbnail: pixel,
        status: '', message: '', selected: true
      }));
      renderQueue();
      const list = document.querySelector('#queueList');
      const panel = document.querySelector('.queue-panel');
      const items = [...document.querySelectorAll('.queue-item')];
      const before = list.scrollTop;
      list.scrollTop = 120;
      const after = list.scrollTop;
      return {
        面板高度: Math.round(panel.getBoundingClientRect().height),
        列表可见高度: Math.round(list.getBoundingClientRect().height),
        列表内容高度: list.scrollHeight,
        内容超出可见: list.scrollHeight - Math.round(list.getBoundingClientRect().height),
        可以滚动: after > before,
        列表flex: getComputedStyle(list).flex,
        条目数量: items.length,
        条目前5个高度: items.slice(0, 5).map((el) => Math.round(el.getBoundingClientRect().height)),
        条目末5个高度: items.slice(-5).map((el) => Math.round(el.getBoundingClientRect().height)),
        条目间缝隙: getComputedStyle(list).gap
      };
    })()`);
    cdp.close();
    console.log('\n===== 测量结果 =====');
    console.log(JSON.stringify(metrics, null, 2));
    return metrics;
  } finally {
    killApp();
    log('应用已关闭');
  }
}

main().catch((error) => { console.error('测量失败:', error.message); process.exitCode = 3; });
