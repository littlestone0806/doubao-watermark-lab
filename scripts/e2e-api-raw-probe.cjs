'use strict';

/*
 * 端到端实测：无水印原图直取（api-raw，集成自 doubao-no-watermark）。
 * 流程：启动应用（远程调试）→ 检查登录 → 加入 1 张测试图 → 开始批量处理 →
 *       全程收集该任务的进度消息 → 等待完成。
 * 断言：
 *   1. 任务完成且有输出文件；
 *   2. 处理过程中出现过「已拦截到豆包返回的无水印原图」进度消息，
 *      或完成记录的 captureSource 为 api-raw（证明接口拦截命中而非回退旧管线）；
 *   3. 输出文件真实存在于磁盘；
 *   4. 上传隔离带仍被裁掉（removedUploadPadding 为 true）。
 * 注意：api-raw 抓不到时任务会静默回退旧管线并成功，所以「任务成功」本身不算数，
 *       必须同时命中断言 2 才算通过。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGE = path.join(CWD, 'e2e-test-images', 'e2e-1.png');
const PORT = 9337;
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
  log('启动应用（远程调试端口 9337）…');
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

  const report = { assertions: {}, notes: [], progressSeen: [] };
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
    await cdp.evaluate('state.files.forEach((file) => { file.selected = false; }); renderQueue(); "ok"');

    await cdp.evaluate(`(async () => {
      await addFiles(await watermarkLab.validatePaths(${JSON.stringify([IMAGE])}));
      return state.files.length;
    })()`);
    log('已加入 1 张测试图并开始批量处理…');
    await cdp.evaluate('document.querySelector("#startButton").click(); "started"');

    const messages = new Set();
    const started = Date.now();
    let final = null;
    while (Date.now() - started < 240_000) {
      await sleep(2000);
      const file = await cdp.evaluate(`(() => {
        const f = state.files.find((file) => file.path === ${JSON.stringify(IMAGE)});
        return f ? {
          status: f.status, message: f.message, progress: f.progress,
          outputPath: f.outputPath || null, captureSource: f.captureSource || null,
          removedUploadPadding: f.removedUploadPadding === true,
          cropPercent: f.cropPercent ?? null, error: f.error || null
        } : null;
      })()`);
      if (file?.message && !messages.has(file.message)) {
        messages.add(file.message);
        log(`进度: ${file.message}`);
      }
      if (file && (file.status === 'complete' || file.status === 'failed')) {
        final = file;
        break;
      }
      if (!(await cdp.evaluate('state.running')) && Date.now() - started > 15_000) {
        final = file || { status: 'unknown' };
        break;
      }
    }
    report.progressSeen = [...messages];
    report.final = final;
    log(`最终状态: ${JSON.stringify(final)}`);

    const apiRawHit = [...messages].some((m) => m.includes('已拦截到豆包返回的无水印原图'))
      || final?.captureSource === 'api-raw';
    report.assertions['任务完成'] = final?.status === 'complete' && Boolean(final?.outputPath);
    report.assertions['api-raw 接口拦截命中（非回退旧管线）'] = apiRawHit;
    report.assertions['输出文件存在于磁盘'] = Boolean(final?.outputPath && fs.existsSync(final.outputPath));
    report.assertions['上传隔离带仍被裁掉'] = final?.removedUploadPadding === true;
    if (!apiRawHit) {
      report.notes.push('任务可能走了回退管线（api-raw 未命中）：检查 CDP getResponseBody 是否拿到了 SSE 响应体');
    }
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
