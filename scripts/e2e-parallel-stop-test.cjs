'use strict';

/*
 * 端到端实测（多线程模式）：并行处理中手动停止任务后，
 * 所有并行任务的进度条和状态是否都恢复默认。
 * 流程：启动应用 → 检查登录 → 开启「多线程」→ 加入 3 张测试图并只勾选它们 →
 *       开始 → 等待至少 2 个任务同时处理中 → 停止 → 断言 → 恢复现场（设置与队列）。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGES = [1, 2, 3].map((i) => path.join(CWD, 'e2e-test-images', `e2e-${i}.png`));
const PORT = 9334;
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
  log('启动应用（远程调试端口 9334）…');
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
  let originalParallel = null;
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

    // 等待队列记录加载完成，避免与初始化竞争
    await cdp.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return state.queueReady; })()');
    selectionSnapshot = await cdp.evaluate('state.files.map((file) => [file.path, file.selected !== false])');
    originalParallel = await cdp.evaluate('state.settings?.parallelProcessing === true');
    log(`现有队列 ${selectionSnapshot.length} 项；多线程原设置: ${originalParallel ? '开' : '关'}`);

    // 模拟用户开启「多线程」
    await cdp.evaluate(`(() => {
      const box = document.querySelector('#parallelProcessing');
      if (!box.checked) box.click();
      return box.checked;
    })()`).then((checked) => {
      if (!checked) throw new Error('无法勾选多线程');
    });
    const intervalDisabled = await cdp.evaluate('document.querySelector("#intervalSeconds").disabled');
    log(`多线程已勾选；任务间隔输入框已置灰: ${intervalDisabled}`);

    await cdp.evaluate('state.files.forEach((file) => { file.selected = false; }); renderQueue(); "ok"');
    const total = await cdp.evaluate(`(async () => {
      await addFiles(await watermarkLab.validatePaths(${JSON.stringify(IMAGES)}));
      return state.files.length;
    })()`);
    log(`已加入 3 张测试图，队列共 ${total} 项（仅测试图勾选）`);

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
    log('批处理已启动，等待并行任务进入处理中…');

    let maxConcurrent = 0;
    let activeSeen = null;
    const activeWaitStart = Date.now();
    while (Date.now() - activeWaitStart < 120_000) {
      await sleep(2000);
      const active = await cdp.evaluate('state.files.filter((file) => file.status === "active").map((file) => ({ name: file.name, message: file.message, progress: file.progress }))');
      if (active?.length) {
        maxConcurrent = Math.max(maxConcurrent, active.length);
        activeSeen = active;
        if (active.length >= 2) {
          log(`检测到 ${active.length} 个任务同时处理中: ${JSON.stringify(active)}`);
          break;
        }
      }
      if (!(await cdp.evaluate('state.running'))) break;
    }
    report.maxConcurrentActive = maxConcurrent;
    if (maxConcurrent < 2) {
      const toasts = await cdp.evaluate('[...document.querySelectorAll(".toast")].map((item) => item.textContent)').catch(() => []);
      report.notes.push(`多线程未真正并行（最大并发 ${maxConcurrent}）${toasts?.length ? `；界面提示：${toasts.join(' | ')}` : ''}`);
      report.aborted = true;
      await cdp.evaluate('document.querySelector("#cancelButton")?.click(); "x"').catch(() => {});
      await sleep(3000);
      return report;
    }

    await sleep(2000);
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

    report.assertions['多线程确实并行（最大并发 ≥ 2）'] = maxConcurrent >= 2;
    report.assertions['没有 running 任务'] = summary.running === false;
    report.assertions['没有 active 状态的条目'] = !summary.files.some((file) => file.status === 'active');
    report.assertions['界面上没有 is-active 行'] = summary.activeRows === 0;
    report.assertions['界面上没有残留进度条'] = summary.progressBars === 0;
    report.assertions['停止按钮已隐藏、开始按钮恢复'] = summary.cancelHidden && summary.startVisible;
    const testFiles = summary.files.filter((file) => /^e2e-\d\.png$/.test(file.name));
    report.assertions['被停止的测试图状态全部恢复默认（或保留完成态）'] = testFiles.every((file) =>
      (file.status === '' && !file.message && !(file.progress > 0)) || (file.status === 'complete' && file.hasOutput)
    );
    report.assertions['多线程开启时间隔输入框置灰'] = intervalDisabled === true;
  } finally {
    if (cdp) {
      try {
        if (originalParallel !== null) {
          await cdp.evaluate(`(async () => {
            await watermarkLab.saveSettings({ ...state.settings, parallelProcessing: ${originalParallel} });
            const box = document.querySelector('#parallelProcessing');
            box.checked = ${originalParallel};
            syncProcessingControls();
            return 'settings-restored';
          })()`);
          log(`多线程设置已恢复为: ${originalParallel ? '开' : '关'}`);
        }
        if (selectionSnapshot) {
          await cdp.evaluate(`(async () => {
            const testPaths = new Set(${JSON.stringify(IMAGES)});
            state.files = state.files.filter((file) => !testPaths.has(file.path));
            const selection = new Map(${JSON.stringify(selectionSnapshot)});
            state.files.forEach((file) => { if (selection.has(file.path)) file.selected = selection.get(file.path); });
            renderQueue();
            await persistQueueNow();
            return 'queue-restored';
          })()`);
          log('已恢复原有队列与勾选状态');
        }
      } catch (error) {
        console.error(`恢复现场失败（请检查设置与队列）: ${error.message}`);
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
