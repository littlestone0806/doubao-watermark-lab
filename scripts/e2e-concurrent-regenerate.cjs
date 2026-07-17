'use strict';

/*
 * 真实并发端到端测试：
 *  阶段 1：两个已完成任务同时点“重新生成”，验证主进程并发链路——
 *    两个批次真正同时跑豆包生成（不是排队）、各自独占豆包窗口、都成功导出。
 *  阶段 2：一个任务“重新生成”与另一个任务“涂抹重绘”同时发起，验证涂抹与批次真并发。
 *
 * 关键并发判据：第二个任务的 job-start 时间戳 < 第一个任务的 job-complete 时间戳。
 * 若实现退化为排队/串行，该判据必然失败。
 *
 * 需要已登录豆包；会产生 4 次真实图片生成，输出文件保留在输出目录。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGES = [path.join(CWD, 'e2e-test-images', 'e2e-1.png'), path.join(CWD, 'e2e-test-images', 'e2e-2.png')];
const MANUAL_IMAGE = path.join(CWD, 'e2e-test-images', 'e2e-3.png');
const PORT = 9347;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const OVERALL_TIMEOUT_MS = 270_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[concurrent-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);
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

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function doubaoTargetCount() {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return targets.filter((target) => target.url.includes('doubao.com')).length;
  } catch {
    return 0;
  }
}

async function main() {
  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
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
      const ready = await renderer.evaluate(`typeof state !== 'undefined' && typeof regenerateFile === 'function'`).catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    await renderer.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');

    const login = await renderer.evaluate('watermarkLab.getLoginStatus()');
    if (!login?.loggedIn) {
      log('豆包未登录，跳过真实并发测试（请先登录后再运行）');
      return;
    }
    log('豆包已登录，开始真实并发测试');

    // 备份真实队列，结束后还原
    await renderer.evaluate(`(async () => {
      window.__origFilesJson = JSON.stringify(state.files);
      window.__origRecords = await watermarkLab.getQueueRecords();
      return true;
    })()`);

    // 加入两张真实测试图并标记为“已完成”，制造两个可重新生成的任务
    await renderer.evaluate(`(async () => {
      await addFiles(await watermarkLab.validatePaths(${JSON.stringify(IMAGES)}));
      for (const file of state.files) {
        if (${JSON.stringify(IMAGES)}.includes(file.path)) {
          Object.assign(file, { status: 'complete', outputPath: file.path, message: '', selected: false, progress: 100 });
        }
      }
      renderQueue();
      return state.files.length;
    })()`);
    await sleep(300);

    // 记录所有批次事件（额外挂一个监听器，不影响应用自身处理）
    await renderer.evaluate(`window.__events = []; watermarkLab.onBatchEvent((event) => {
      window.__events.push({ type: event.type, path: event.path || event.sourcePath || '', batchId: event.batchId || '', mode: event.mode || '', outputPath: event.outputPath || '', ts: Date.now() });
    }); 'ok'`);

    // 诊断：包装 startBatchForFiles 记录发起与错误；观察 toast 文本
    await renderer.evaluate(`(() => {
      window.__diag = { starts: [], errors: [], toasts: [] };
      const original = startBatchForFiles;
      window.startBatchForFiles = async (files) => {
        window.__diag.starts.push(files.map((file) => file.path));
        try { await original(files); } catch (error) { window.__diag.errors.push(error.message || String(error)); }
      };
      const region = document.querySelector('.toast-region');
      if (region) {
        new MutationObserver(() => {
          window.__diag.toasts.push(region.textContent.trim().slice(0, 300));
        }).observe(region, { childList: true, subtree: true, characterData: true });
      }
      return true;
    })()`);

    // 同时点击两个任务的“重新生成”
    log('同时点击两个任务的重新生成按钮…');
    await renderer.evaluate(`(() => {
      for (const row of document.querySelectorAll('.queue-item')) {
        if (${JSON.stringify(IMAGES)}.includes(row.dataset.path)) row.querySelector('.regenerate-result')?.click();
      }
      return true;
    })()`);

    // 轮询直到两个批次都结束
    let maxDoubaoTargets = 0;
    let finalState = null;
    while (Date.now() < deadline) {
      await sleep(1500);
      maxDoubaoTargets = Math.max(maxDoubaoTargets, await doubaoTargetCount());
      finalState = await renderer.evaluate(`(() => ({
        running: state.running,
        batches: state.activeBatches.size,
        events: window.__events.length,
        completes: window.__events.filter((event) => event.type === 'batch-complete').length
      }))()`).catch(() => null);
      if (finalState && finalState.completes >= 2 && !finalState.running) break;
    }
    log(`  结束状态: ${JSON.stringify(finalState)}, 豆包页面峰值: ${maxDoubaoTargets}`);
    const diag = await renderer.evaluate('window.__diag').catch(() => null);
    log(`  诊断: ${JSON.stringify(diag)}`);

    const events = await renderer.evaluate('window.__events');
    const batchStarts = events.filter((event) => event.type === 'batch-start');
    const jobStarts = events.filter((event) => event.type === 'job-start' && IMAGES.includes(event.path));
    const jobCompletes = events.filter((event) => event.type === 'job-complete' && IMAGES.includes(event.path));
    const jobErrors = events.filter((event) => event.type === 'job-error' && IMAGES.includes(event.path));
    const batchCompletes = events.filter((event) => event.type === 'batch-complete');

    assert(batchStarts.length === 2 && new Set(batchStarts.map((event) => event.batchId)).size === 2,
      '两个独立批次先后启动，batchId 各不相同');
    assert(jobStarts.length === 2, '两张图都开始处理');
    if (jobStarts.length === 2 && jobCompletes.length >= 1) {
      const secondStart = Math.max(...jobStarts.map((event) => event.ts));
      const firstComplete = Math.min(...jobCompletes.map((event) => event.ts));
      assert(secondStart < firstComplete, '第二张图开始时第一张图仍在处理（真并发，非排队）');
    }
    assert(jobErrors.length === 0, `没有任务失败${jobErrors.length ? `：${JSON.stringify(jobErrors)}` : ''}`);
    assert(jobCompletes.length === 2, '两张图都处理完成');
    for (const event of jobCompletes) {
      assert(Boolean(event.outputPath) && fs.existsSync(event.outputPath), `输出文件已生成: ${event.outputPath || '(缺失)'}`);
    }
    assert(batchCompletes.length === 2, '两个批次都发出 batch-complete');
    assert(maxDoubaoTargets >= 2, '并发期间使用了至少 2 个豆包窗口（窗口分配无冲突）');
    assert(finalState && finalState.running === false && finalState.batches === 0, '全部结束后恢复空闲状态');

    const buttons = await renderer.evaluate(`[...document.querySelectorAll('.regenerate-result')].map((button) => button.disabled)`);
    assert(buttons.length >= 2 && buttons.every((disabled) => disabled === false), '结束后重新生成按钮均可点击');

    // ---- 阶段 2：重新生成 + 涂抹重绘 真实并发 ----
    log('阶段 2：重新生成与涂抹重绘真实并发');
    await renderer.evaluate(`(async () => {
      await addFiles(await watermarkLab.validatePaths(${JSON.stringify([MANUAL_IMAGE])}));
      for (const file of state.files) {
        if (file.path === ${JSON.stringify(MANUAL_IMAGE)}) {
          Object.assign(file, { status: 'complete', outputPath: file.path, message: '', selected: false, progress: 100 });
        }
      }
      renderQueue();
      return true;
    })()`);
    await renderer.evaluate(`window.__events = []; 'ok'`);

    // 同时发起：e2e-1 重新生成 + e2e-3 涂抹重绘
    await renderer.evaluate(`(() => {
      const row = [...document.querySelectorAll('.queue-item')].find((item) => item.dataset.path === ${JSON.stringify(IMAGES[0])});
      row?.querySelector('.regenerate-result')?.click();
      return true;
    })()`);
    await renderer.evaluate(`handleManualSubmitted({ sourcePath: ${JSON.stringify(MANUAL_IMAGE)}, strokes: [[{ x: 0.5, y: 0.5 }, { x: 0.56, y: 0.56 }]], brushPercent: 3 }); 'ok'`);

    let phase2State = null;
    while (Date.now() < deadline) {
      await sleep(1500);
      phase2State = await renderer.evaluate(`(() => ({
        running: state.running,
        completes: window.__events.filter((event) => event.type === 'batch-complete').length
      }))()`).catch(() => null);
      if (phase2State && phase2State.completes >= 2 && !phase2State.running) break;
    }
    log(`  阶段 2 结束状态: ${JSON.stringify(phase2State)}`);

    const events2 = await renderer.evaluate('window.__events');
    const watchPaths = [...IMAGES, MANUAL_IMAGE];
    const starts2 = events2.filter((event) => event.type === 'batch-start');
    const jobStarts2 = events2.filter((event) => event.type === 'job-start' && watchPaths.includes(event.path));
    const jobCompletes2 = events2.filter((event) => event.type === 'job-complete' && watchPaths.includes(event.path));
    const jobErrors2 = events2.filter((event) => event.type === 'job-error');
    const completes2 = events2.filter((event) => event.type === 'batch-complete');

    assert(starts2.length === 2 && starts2.some((event) => event.mode === 'manual'), '重新生成批次与涂抹批次都启动');
    assert(jobStarts2.length === 2, '两个任务都开始处理');
    if (jobStarts2.length === 2 && jobCompletes2.length >= 1) {
      const secondStart = Math.max(...jobStarts2.map((event) => event.ts));
      const firstComplete = Math.min(...jobCompletes2.map((event) => event.ts));
      assert(secondStart < firstComplete, '涂抹与重新生成同时处于处理中（真并发）');
    }
    assert(jobErrors2.length === 0, `没有任务失败${jobErrors2.length ? `：${JSON.stringify(jobErrors2)}` : ''}`);
    assert(jobCompletes2.length === 2, '两个任务都处理完成');
    for (const event of jobCompletes2) {
      assert(Boolean(event.outputPath) && fs.existsSync(event.outputPath), `输出文件已生成: ${event.outputPath || '(缺失)'}`);
    }
    assert(completes2.length === 2 && completes2.some((event) => event.mode === 'manual'), '两个批次都正常结束（含涂抹批次）');
    assert(phase2State && phase2State.running === false, '全部结束后恢复空闲状态');
  } finally {
    await renderer?.evaluate(`(async () => {
      try {
        state.files = JSON.parse(window.__origFilesJson);
        renderQueue();
        await watermarkLab.saveQueueRecords(window.__origRecords);
      } catch (error) { console.error(error); }
      return true;
    })()`).catch(() => {});
    renderer?.close();
    killApp();
    log('队列已还原，应用已关闭');
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
