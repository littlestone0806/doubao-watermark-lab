'use strict';

/*
 * 重新生成按钮状态的 E2E 验证：
 *  场景 1：批处理全部完成后，未勾选的任务其“重新生成”按钮应可直接点击
 *  场景 2：一个任务重跑期间，点击其他任务的按钮应立即并发执行（不排队），
 *          两个任务同时处理、运行状态保持，全部结束后按钮恢复可点击
 *  附带验证：3 个并发上限的拦截、重复点击防护、原图缺失的按钮保持禁用
 *
 * 通过 CDP 驱动真实渲染进程，全程调用页面里的 handleBatchEvent 生产代码路径，
 * 不会真正发起豆包批处理；结束时还原队列记录。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const PORT = 9346;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const OUT_DIR = path.join(CWD, 'docs', 'repro-regenerate');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[regen-fix-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);
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
    log(`截图: ${path.relative(CWD, filePath)}`);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const FILE_A = '/tmp/regen-fix-a.png';
const FILE_B = '/tmp/regen-fix-b.png';

// 页面端辅助脚本片段
const injectTwoCompleted = `(() => {
  state.files = [
    { path: ${JSON.stringify(FILE_A)}, name: 'regen-a.png', thumbnail: '', width: 800, height: 600, bytes: 1024, status: 'complete', outputPath: '/tmp/regen-a-out.png', selected: false, progress: 100 },
    { path: ${JSON.stringify(FILE_B)}, name: 'regen-b.png', thumbnail: '', width: 900, height: 700, bytes: 2048, status: 'complete', outputPath: '/tmp/regen-b-out.png', selected: false, progress: 100 }
  ];
  renderQueue();
  return state.files.length;
})()`;

const buttonStates = `(() => {
  const rows = [...document.querySelectorAll('.queue-item')];
  return rows.map((row) => ({
    path: row.dataset.path,
    unchecked: row.classList.contains('is-unchecked'),
    regenDisabled: row.querySelector('.regenerate-result')?.disabled ?? null
  }));
})()`;

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
      const ready = await renderer.evaluate(`typeof state !== 'undefined' && typeof handleBatchEvent === 'function'`).catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    await renderer.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');

    // 备份真实队列，测试结束后还原
    await renderer.evaluate(`window.__origFilesJson = JSON.stringify(state.files); window.__origRecords = null; 'ok'`);
    await renderer.evaluate(`(async () => { window.__origRecords = await watermarkLab.getQueueRecords(); return true; })()`);

    log('注入两个“已完成”任务（未勾选状态）');
    await renderer.evaluate(injectTwoCompleted);
    await sleep(300);

    // ---- 场景 1：模拟一轮完整批处理的生命周期 ----
    log('场景 1：批处理全部完成后，未勾选任务的重新生成按钮应可点击');
    await renderer.evaluate(`handleBatchEvent({ type: 'batch-start' }); 'ok'`);
    await sleep(200);
    let states = await renderer.evaluate(buttonStates);
    assert(states.every((s) => s.regenDisabled === false), '运行中：其他已完成任务的按钮保持可点击（点击即并发执行）');

    await renderer.evaluate(`handleBatchEvent({ type: 'job-complete', sourcePath: ${JSON.stringify(FILE_A)}, outputPath: '/tmp/regen-a-out.png', conversationId: 'cid-a' }); 'ok'`);
    await renderer.evaluate(`handleBatchEvent({ type: 'job-complete', sourcePath: ${JSON.stringify(FILE_B)}, outputPath: '/tmp/regen-b-out.png', conversationId: 'cid-b' }); 'ok'`);
    await renderer.evaluate(`handleBatchEvent({ type: 'batch-complete', completed: 2 }); 'ok'`);
    await sleep(300);
    states = await renderer.evaluate(buttonStates);
    log(`  完成后状态: ${JSON.stringify(states)}`);
    assert(states.length === 2 && states.every((s) => s.regenDisabled === false), '批处理结束后：两个按钮均可点击（bug 1 修复点）');
    assert(states.every((s) => s.unchecked === true), '任务保持未勾选状态——不选中也能点');

    // ---- 场景 2：A 重跑期间点击 B，B 立即并发执行（不排队） ----
    log('场景 2：A 重跑期间点击 B 的重新生成，B 应立即并发执行');
    // 拦截 startBatchForFiles：记录调用、避免触发真实豆包批处理
    await renderer.evaluate(`window.__origStartBatchForFiles = startBatchForFiles; window.__calls = [];
      window.startBatchForFiles = async (files) => { window.__calls.push(files.map((file) => file.path)); }; 'ok'`);
    await renderer.evaluate(`handleBatchEvent({ type: 'batch-start', batchId: 'b1' }); 'ok'`);
    await renderer.evaluate(`handleBatchEvent({ type: 'job-start', path: ${JSON.stringify(FILE_A)}, batchId: 'b1' }); 'ok'`);
    await sleep(200);
    states = await renderer.evaluate(buttonStates);
    assert(states.find((s) => s.path === FILE_A)?.regenDisabled === null
      && states.find((s) => s.path === FILE_B)?.regenDisabled === false,
      'A 重跑期间：A 显示进度无按钮，B 的按钮可点击');

    // 真实点击 B 的按钮 → 应立即发起，而不是排队等待
    await renderer.evaluate(`(() => {
      const row = [...document.querySelectorAll('.queue-item')].find((item) => item.dataset.path === ${JSON.stringify(FILE_B)});
      row.querySelector('.regenerate-result').click();
      return true;
    })()`);
    await sleep(200);
    const afterClick = await renderer.evaluate(`(() => {
      const row = [...document.querySelectorAll('.queue-item')].find((item) => item.dataset.path === ${JSON.stringify(FILE_B)});
      const button = row?.querySelector('.regenerate-result');
      return {
        calls: window.__calls,
        requested: state.files.find((file) => file.path === ${JSON.stringify(FILE_B)})?.regenRequested ?? null,
        disabled: button?.disabled ?? null,
        isPending: button?.classList.contains('is-pending') ?? null
      };
    })()`);
    log(`  点击 B 后: ${JSON.stringify(afterClick)}`);
    assert(afterClick.calls.length === 1 && afterClick.calls[0][0] === FILE_B, '点击后 B 立即发起重新生成（并发执行，不排队）');
    assert(afterClick.requested === true && afterClick.disabled === true && afterClick.isPending === true, 'B 的按钮进入“正在发起”状态，防止重复点击');

    // B 的批次启动：A、B 两个任务同时处于处理中
    await renderer.evaluate(`handleBatchEvent({ type: 'batch-start', batchId: 'b2' }); 'ok'`);
    await renderer.evaluate(`handleBatchEvent({ type: 'job-start', path: ${JSON.stringify(FILE_B)}, batchId: 'b2' }); 'ok'`);
    await sleep(200);
    const concurrent = await renderer.evaluate(`(() => ({
      running: state.running,
      batches: state.activeBatches.size,
      aActive: [...document.querySelectorAll('.queue-item')].find((item) => item.dataset.path === ${JSON.stringify(FILE_A)})?.classList.contains('is-active') ?? null,
      bActive: [...document.querySelectorAll('.queue-item')].find((item) => item.dataset.path === ${JSON.stringify(FILE_B)})?.classList.contains('is-active') ?? null
    }))()`);
    log(`  并发中: ${JSON.stringify(concurrent)}`);
    assert(concurrent.running === true && concurrent.batches === 2 && concurrent.aActive === true && concurrent.bActive === true,
      'A 和 B 两个任务同时处于处理中');

    // A 先完成：b1 批次结束，但 B 还在处理 → 运行状态必须保持
    await renderer.evaluate(`handleBatchEvent({ type: 'job-complete', sourcePath: ${JSON.stringify(FILE_A)}, outputPath: '/tmp/regen-a-out2.png', conversationId: 'cid-a2', batchId: 'b1' }); 'ok'`);
    await renderer.evaluate(`handleBatchEvent({ type: 'batch-complete', batchId: 'b1', completed: 1 }); 'ok'`);
    await sleep(300);
    const midway = await renderer.evaluate(`(() => ({ running: state.running, batches: state.activeBatches.size }))()`);
    assert(midway.running === true && midway.batches === 1, 'A 完成后 B 仍在处理，运行状态保持');
    states = await renderer.evaluate(buttonStates);
    assert(states.find((s) => s.path === FILE_B)?.regenDisabled === null
      && states.find((s) => s.path === FILE_A)?.regenDisabled === false,
      'A 完成后：A 的按钮可点击，B 仍显示处理中');

    // B 完成 → 全部空闲
    await renderer.evaluate(`handleBatchEvent({ type: 'job-complete', sourcePath: ${JSON.stringify(FILE_B)}, outputPath: '/tmp/regen-b-out2.png', conversationId: 'cid-b2', batchId: 'b2' }); 'ok'`);
    await renderer.evaluate(`handleBatchEvent({ type: 'batch-complete', batchId: 'b2', completed: 1 }); 'ok'`);
    await sleep(300);
    const done = await renderer.evaluate(`(() => ({ running: state.running, batches: state.activeBatches.size }))()`);
    assert(done.running === false && done.batches === 0, 'B 完成后恢复空闲状态');
    states = await renderer.evaluate(buttonStates);
    log(`  全部结束后状态: ${JSON.stringify(states)}`);
    assert(states.length === 2 && states.every((s) => s.regenDisabled === false), '全部结束后：两个按钮均可点击');

    // 并发上限：已有 3 个批次时点击应被拒绝，不会发起
    await renderer.evaluate(`state.activeBatches = new Set(['x1', 'x2', 'x3']); state.running = true; renderQueue(); 'ok'`);
    await renderer.evaluate(`(() => {
      const row = [...document.querySelectorAll('.queue-item')].find((item) => item.dataset.path === ${JSON.stringify(FILE_B)});
      row.querySelector('.regenerate-result').click();
      return true;
    })()`);
    await sleep(200);
    const capped = await renderer.evaluate('window.__calls.length');
    assert(capped === 1, '达到 3 个并发上限时拒绝新的重新生成');
    await renderer.evaluate(`state.activeBatches = new Set(); state.running = false; renderQueue(); 'ok'`);
    await renderer.evaluate(`window.startBatchForFiles = window.__origStartBatchForFiles; 'ok'`);

    // ---- 场景 3：运行中提交涂抹重绘，与批次并发 ----
    log('场景 3：A 重跑期间提交 B 的涂抹重绘，应正常进入处理流程');
    await renderer.evaluate(`window.__toasts = [];
      new MutationObserver(() => window.__toasts.push(document.querySelector('.toast-region')?.textContent || ''))
        .observe(document.querySelector('.toast-region'), { childList: true, subtree: true, characterData: true }); 'ok'`);
    await renderer.evaluate(`handleBatchEvent({ type: 'batch-start', batchId: 'm1' }); 'ok'`);
    await renderer.evaluate(`handleBatchEvent({ type: 'job-start', path: ${JSON.stringify(FILE_A)}, batchId: 'm1' }); 'ok'`);
    await sleep(200);
    const manualBtn = await renderer.evaluate(`(() => {
      const row = [...document.querySelectorAll('.queue-item')].find((item) => item.dataset.path === ${JSON.stringify(FILE_B)});
      const button = row?.querySelector('.manual-result');
      return { disabled: button?.disabled ?? null };
    })()`);
    assert(manualBtn.disabled === false, 'A 运行期间：B 的涂抹重绘按钮可点击');

    // 提交涂抹（假原图会被主进程校验拦截，但足以证明不再被“已有任务运行”拒绝）
    await renderer.evaluate(`handleManualSubmitted({ sourcePath: ${JSON.stringify(FILE_B)}, strokes: [[{ x: 0.5, y: 0.5 }, { x: 0.55, y: 0.55 }]], brushPercent: 3 }); 'ok'`);
    await sleep(600);
    const manual = await renderer.evaluate(`(() => ({
      running: state.running,
      batches: state.activeBatches.size,
      bStatus: state.files.find((file) => file.path === ${JSON.stringify(FILE_B)})?.status,
      toasts: window.__toasts.join('|')
    }))()`);
    log(`  涂抹提交后: ${JSON.stringify(manual)}`);
    assert(!/请等待完成后再发送涂抹/.test(manual.toasts), '运行中提交涂抹不再被“已有任务运行”拒绝');
    assert(/原图不存在或格式不受支持/.test(manual.toasts), '涂抹请求实际进入主进程处理（假原图被校验拦截）');
    assert(manual.running === true && manual.batches === 1, '涂抹流程结束后 A 的运行状态不受影响');
    assert(manual.bStatus === 'complete', 'B 被安全回退为完成状态');
    await renderer.evaluate(`handleBatchEvent({ type: 'job-complete', sourcePath: ${JSON.stringify(FILE_A)}, outputPath: '/tmp/regen-a-out3.png', conversationId: 'cid-a3', batchId: 'm1' }); 'ok'`);
    await renderer.evaluate(`handleBatchEvent({ type: 'batch-complete', batchId: 'm1', completed: 1 }); 'ok'`);
    await sleep(200);

    // 并发上限对涂抹同样生效
    await renderer.evaluate(`state.activeBatches = new Set(['x1', 'x2', 'x3']); state.running = true; renderQueue(); 'ok'`);
    await renderer.evaluate(`handleManualSubmitted({ sourcePath: ${JSON.stringify(FILE_B)}, strokes: [[{ x: 0.5, y: 0.5 }]], brushPercent: 3 }); 'ok'`);
    await sleep(300);
    const manualCap = await renderer.evaluate(`(() => ({
      bActive: state.files.find((file) => file.path === ${JSON.stringify(FILE_B)})?.status === 'active',
      toasts: window.__toasts.join('|')
    }))()`);
    assert(/最多同时处理 3 张图片/.test(manualCap.toasts) && manualCap.bActive === false, '达到并发上限时涂抹提交被拦截');
    await renderer.evaluate(`state.activeBatches = new Set(); state.running = false; renderQueue(); 'ok'`);

    // ---- 附带：原图缺失的按钮应保持禁用 ----
    await renderer.evaluate(`updateFile(${JSON.stringify(FILE_B)}, { missing: true }); 'ok'`);
    await sleep(200);
    states = await renderer.evaluate(buttonStates);
    assert(states.find((s) => s.path === FILE_B)?.regenDisabled === true
      && states.find((s) => s.path === FILE_A)?.regenDisabled === false,
      '原图缺失的任务按钮保持禁用，其他任务不受影响');
    await renderer.evaluate(`updateFile(${JSON.stringify(FILE_B)}, { missing: false }); 'ok'`);

    await renderer.screenshot(path.join(OUT_DIR, 'regenerate-enable-fix.png'));

    // 还原真实队列
    await renderer.evaluate(`(async () => {
      state.files = JSON.parse(window.__origFilesJson);
      renderQueue();
      await watermarkLab.saveQueueRecords(window.__origRecords);
      return true;
    })()`);
    log('队列已还原为测试前状态');
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
