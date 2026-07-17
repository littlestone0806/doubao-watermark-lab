'use strict';

/*
 * 端到端实测：手动停止任务后，队列条目的进度条和状态是否恢复默认。
 * 流程：启动应用（远程调试）→ 检查登录 → 加入 3 张测试图（只勾选它们）→
 *       点击开始 → 等待批处理启动 → 等待任务进入处理中 → 点击停止 →
 *       断言状态复位 → 恢复现场（无论成败）。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGES = [1, 2, 3].map((i) => path.join(CWD, 'e2e-test-images', `e2e-${i}.png`));
const PORT = 9333;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);

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
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`页面脚本异常: ${detail}`);
    }
    return result.result?.value;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function waitForDebugger(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (response.ok) return true;
    } catch { /* not ready */ }
    await sleep(500);
  }
  throw new Error('等待远程调试端口超时');
}

async function main() {
  log('启动应用（远程调试端口 9333）…');
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: CWD,
    detached: true,
    stdio: 'ignore'
  });
  const killApp = () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  };
  process.on('exit', killApp);
  process.on('SIGINT', () => { killApp(); process.exit(130); });
  process.on('SIGTERM', () => { killApp(); process.exit(143); });

  const report = { assertions: {}, notes: [] };
  let cdp = null;
  let selectionSnapshot = null;
  try {
    await waitForDebugger(30_000);
    log('应用已启动，连接主窗口…');
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const mainTarget = targets.find((target) => target.url.includes('renderer/index.html'));
    if (!mainTarget) throw new Error('没有找到主窗口调试目标');
    cdp = new CDP(mainTarget.webSocketDebuggerUrl);

    const login = await cdp.evaluate('(async () => await watermarkLab.getLoginStatus())()');
    log(`豆包登录状态: ${login?.loggedIn ? '已登录' : '未登录'}`);
    if (!login?.loggedIn) {
      report.notes.push('豆包未登录，无法实测；请先登录');
      report.aborted = true;
      return report;
    }

    selectionSnapshot = await cdp.evaluate('state.files.map((file) => [file.path, file.selected !== false])');
    log(`现有队列 ${selectionSnapshot.length} 项，先全部取消勾选（测完恢复）`);
    await cdp.evaluate('state.files.forEach((file) => { file.selected = false; }); renderQueue(); "ok"');

    const total = await cdp.evaluate(`(async () => {
      await addFiles(await watermarkLab.validatePaths(${JSON.stringify(IMAGES)}));
      return state.files.length;
    })()`);
    log(`已加入 3 张测试图，队列共 ${total} 项（仅测试图处于勾选状态）`);

    await cdp.evaluate('document.querySelector("#startButton").click(); "started"');
    log('已点击「开始批量处理」，等待批处理启动…');

    const startWaitStart = Date.now();
    let batchStarted = false;
    while (Date.now() - startWaitStart < 40_000) {
      await sleep(1200);
      if (await cdp.evaluate('state.running')) { batchStarted = true; break; }
    }
    if (!batchStarted) {
      const toasts = await cdp.evaluate('[...document.querySelectorAll(".toast")].map((item) => item.textContent)').catch(() => []);
      report.notes.push(`点击开始后 40 秒内批处理未启动${toasts?.length ? `；界面提示：${toasts.join(' | ')}` : ''}`);
      report.aborted = true;
      return report;
    }
    log('批处理已启动，等待任务进入处理中…');

    let activeSeen = null;
    const activeWaitStart = Date.now();
    while (Date.now() - activeWaitStart < 100_000) {
      await sleep(2000);
      const active = await cdp.evaluate('state.files.filter((file) => file.status === "active").map((file) => ({ name: file.name, message: file.message, progress: file.progress }))');
      if (active?.length) {
        activeSeen = active;
        log(`检测到 ${active.length} 个任务处理中: ${JSON.stringify(active)}`);
        break;
      }
      if (!(await cdp.evaluate('state.running'))) break;
    }
    if (!activeSeen) {
      const toasts = await cdp.evaluate('[...document.querySelectorAll(".toast")].map((item) => item.textContent)').catch(() => []);
      report.notes.push(`等待 100 秒仍无任务进入处理中（可能卡在上传或安全验证）${toasts?.length ? `；界面提示：${toasts.join(' | ')}` : ''}`);
      report.aborted = true;
      await cdp.evaluate('document.querySelector("#cancelButton")?.click(); "x"').catch(() => {});
      return report;
    }

    await sleep(3000);
    log('点击「停止任务」…');
    await cdp.evaluate('document.querySelector("#cancelButton").click(); "cancel-clicked"');

    const stopWaitStart = Date.now();
    while (Date.now() - stopWaitStart < 60_000) {
      await sleep(1500);
      if (await cdp.evaluate('!state.running')) break;
    }

    const summary = await cdp.evaluate(`({
      running: state.running,
      files: state.files.map((file) => ({
        name: file.name, status: file.status, message: file.message,
        progress: file.progress, selected: file.selected !== false, hasOutput: Boolean(file.outputPath)
      })),
      activeRows: document.querySelectorAll('.queue-item.is-active').length,
      progressBars: document.querySelectorAll('.task-progress').length,
      cancelHidden: document.querySelector('#cancelButton').classList.contains('is-hidden'),
      startVisible: !document.querySelector('#startButton').classList.contains('is-hidden'),
      toasts: [...document.querySelectorAll('.toast')].map((item) => item.textContent)
    })`);
    report.summary = summary;
    log(`停止后状态: ${JSON.stringify(summary)}`);

    report.assertions['没有 running 任务'] = summary.running === false;
    report.assertions['没有 active 状态的条目'] = !summary.files.some((file) => file.status === 'active');
    report.assertions['界面上没有 is-active 行'] = summary.activeRows === 0;
    report.assertions['界面上没有残留进度条'] = summary.progressBars === 0;
    report.assertions['停止按钮已隐藏、开始按钮恢复'] = summary.cancelHidden && summary.startVisible;
    const testFiles = summary.files.filter((file) => /^e2e-\d\.png$/.test(file.name));
    report.assertions['被停止的测试图状态恢复默认（或保留完成态）'] = testFiles.every((file) =>
      (file.status === '' && !file.message && !(file.progress > 0)) || (file.status === 'complete' && file.hasOutput)
    );
  } finally {
    if (cdp && selectionSnapshot) {
      try {
        await cdp.evaluate(`(async () => {
          const testPaths = new Set(${JSON.stringify(IMAGES)});
          state.files = state.files.filter((file) => !testPaths.has(file.path));
          const selection = new Map(${JSON.stringify(selectionSnapshot)});
          state.files.forEach((file) => { if (selection.has(file.path)) file.selected = selection.get(file.path); });
          renderQueue();
          await persistQueueNow();
          return 'restored';
        })()`);
        log('已恢复原有队列与勾选状态');
      } catch (error) {
        console.error(`恢复现场失败（请检查队列）: ${error.message}`);
      }
    }
    cdp?.close();
    killApp();
    log('应用已关闭');
  }
  return report;
}

main().then((report) => {
  console.log('\n===== 实测结果 =====');
  console.log(JSON.stringify(report, null, 2));
  const failed = Object.entries(report.assertions || {}).filter(([, pass]) => !pass);
  if (report.aborted) {
    console.log('\n结论: 测试中止 -', report.notes.join('；'));
    process.exitCode = 2;
  } else if (failed.length) {
    console.log(`\n结论: ${failed.length} 项断言未通过: ${failed.map(([name]) => name).join('、')}`);
    process.exitCode = 1;
  } else {
    console.log('\n结论: 全部断言通过 ✔');
  }
}).catch((error) => {
  console.error('实测脚本失败:', error.message);
  process.exitCode = 3;
});
