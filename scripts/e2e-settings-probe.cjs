'use strict';

/*
 * 轻量冒烟实测（不消耗豆包额度）：验证“无图等待”设置链路。
 * 断言：输入框存在且默认为 30 → 改为 61 后 state.settings 与磁盘 settings.json 都更新 → 恢复为 30。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const PORT = 9338;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const SETTINGS_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'doubao-watermark-lab', 'settings.json');

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

const readDiskWaitSeconds = () => {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')).imageWaitSeconds;
  } catch {
    return undefined;
  }
};

async function main() {
  const report = { assertions: {}, notes: [] };
  const before = readDiskWaitSeconds();
  log(`磁盘现有 imageWaitSeconds: ${before}`);

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
    const mainTarget = targets.find((target) => target.url.includes('renderer/index.html'));
    cdp = new CDP(mainTarget.webSocketDebuggerUrl);
    await cdp.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');

    const initial = await cdp.evaluate(`(() => {
      const input = document.querySelector('#imageWaitSeconds');
      return { exists: Boolean(input), value: input?.value || '', disabled: input?.disabled };
    })()`);
    log(`输入框: exists=${initial.exists} value=${initial.value} disabled=${initial.disabled}`);
    report.assertions['无图等待输入框存在'] = initial.exists;
    report.assertions['默认值为 30 秒'] = initial.value === '30';

    await cdp.evaluate(`(() => {
      const input = document.querySelector('#imageWaitSeconds');
      input.value = '61';
      input.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(1500);
    const inMemory = await cdp.evaluate('state.settings?.imageWaitSeconds');
    const onDisk = readDiskWaitSeconds();
    log(`改为 61 后: 内存=${inMemory} 磁盘=${onDisk}`);
    report.assertions['修改后渲染进程设置生效'] = inMemory === 61;
    report.assertions['修改后磁盘 settings.json 持久化'] = onDisk === 61;

    await cdp.evaluate(`(() => {
      const input = document.querySelector('#imageWaitSeconds');
      input.value = '30';
      input.dispatchEvent(new Event('change'));
      return true;
    })()`);
    await sleep(1500);
    const restored = readDiskWaitSeconds();
    log(`恢复为 30 后磁盘值: ${restored}`);
    report.assertions['恢复默认值成功'] = restored === 30;
  } finally {
    cdp?.close();
    killApp();
    log('应用已关闭');
  }
  return report;
}

main().then((report) => {
  console.log('\n===== 冒烟结果 =====');
  console.log(JSON.stringify(report, null, 2));
  const failed = Object.entries(report.assertions || {}).filter(([, pass]) => !pass);
  if (failed.length) {
    console.log(`\n结论: ${failed.length} 项断言未通过: ${failed.map(([name]) => name).join('、')}`);
    process.exitCode = 1;
  } else {
    console.log('\n结论: 全部断言通过 ✔');
  }
}).catch((error) => {
  console.error('冒烟脚本失败:', error.message);
  process.exitCode = 3;
});
