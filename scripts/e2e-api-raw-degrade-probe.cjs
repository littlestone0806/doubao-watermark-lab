'use strict';

/*
 * 端到端实测：api-raw 拦截失败时的「隔离带降级重发」链路。
 * 通过环境变量 DWL_DISABLE_API_RAW=1 关掉接口拦截（测试钩子），
 * 强制任务走「原图直发未命中 → 加临时隔离带在同会话重发 → 白边裁切」的降级管线。
 * 断言：
 *   1. 任务完成且有输出文件；
 *   2. 降级重发确实发生：removedUploadPadding 为 true 且 cropped 为 true
 *      （隔离带只可能在降级分支创建，这是比瞬时进度文字更可靠的持久证据）；
 *   3. 完成记录 captureSource 不是 api-raw（确实没走直取）；
 *   4. 输出文件真实存在于磁盘。
 * 注：降级提示文字「未能拦截到无水印原图…」是瞬时进度，可能被后续进度快速覆盖，
 *     仅作参考记录，不作为硬断言。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGE = path.join(CWD, 'e2e-test-images', 'e2e-2.png');
const PORT = 9338;
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
  log('启动应用（DWL_DISABLE_API_RAW=1，强制走降级链路）…');
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: CWD,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DWL_DISABLE_API_RAW: '1' }
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
    log('已加入 1 张测试图并开始批量处理（预期：直取未命中 → 隔离带重发）…');
    await cdp.evaluate('document.querySelector("#startButton").click(); "started"');

    const messages = new Set();
    const started = Date.now();
    let final = null;
    while (Date.now() - started < 250_000) {
      await sleep(800);
      const file = await cdp.evaluate(`(() => {
        const f = state.files.find((file) => file.path === ${JSON.stringify(IMAGE)});
        return f ? {
          status: f.status, message: f.message, progress: f.progress,
          outputPath: f.outputPath || null, captureSource: f.captureSource || null,
          removedUploadPadding: f.removedUploadPadding === true,
          cropped: f.cropped === true,
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

    const degradeHintSeen = [...messages].some((m) => m.includes('未能拦截到无水印原图'));
    report.notes.push(`降级提示文字${degradeHintSeen ? '已' : '未'}在轮询中捕获（瞬时消息，仅供参考）`);
    report.assertions['任务完成'] = final?.status === 'complete' && Boolean(final?.outputPath);
    report.assertions['降级重发已发生（隔离带上传并被裁掉）'] = final?.removedUploadPadding === true && final?.cropped === true;
    report.assertions['未走 api-raw 直取'] = final?.captureSource !== 'api-raw';
    report.assertions['输出文件存在于磁盘'] = Boolean(final?.outputPath && fs.existsSync(final.outputPath));
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
