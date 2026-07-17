'use strict';

/*
 * 端到端实测（重启场景）：任务记住豆包会话，重启应用后重跑能接回历史对话。
 *
 * 阶段 A（第一次启动）：跑一张测试图到完成 → 从豆包窗口 URL 拿到会话 ID →
 *   断言渲染进程状态与磁盘 queue-records.json 都写入了该 ID → 杀掉应用。
 * 阶段 B（第二次启动，模拟用户重新打开软件）：等队列加载 →
 *   断言加载到的记录仍带该会话 ID（磁盘链路）→ 只勾选它点开始 →
 *   轮询豆包窗口 URL 出现 /chat/<id>（重启后窗口初始是空新会话，
 *   URL 出现该 ID 只能来自 openConversation 导航，排除假阳性）→ 立即取消。
 * 最后恢复现场：移除测试图、恢复原有勾选、持久化、杀应用。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGE = path.join(CWD, 'e2e-test-images', 'e2e-1.png');
const PORT = 9336;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const USER_DATA_CANDIDATES = [
  path.join(os.homedir(), 'Library', 'Application Support', 'doubao-watermark-lab'),
  path.join(os.homedir(), 'Library', 'Application Support', 'Electron')
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);
const idFromUrl = (url) => (String(url || '').match(/\/chat\/([0-9a-zA-Z]{8,})(?:[/?#]|$)/) || [])[1] || '';

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

async function waitForPortDown(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/json/version`);
    } catch {
      return true;
    }
    await sleep(400);
  }
  return false;
}

async function doubaoTargets() {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return targets.filter((target) => target.url.includes('doubao.com'));
  } catch {
    return [];
  }
}

async function doubaoConversationId(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const target of await doubaoTargets()) {
      const id = idFromUrl(target.url);
      if (id) return id;
    }
    await sleep(1200);
  }
  return '';
}

async function waitForDoubaoUrl(urlFragment, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if ((await doubaoTargets()).some((target) => target.url.includes(urlFragment))) return true;
    await sleep(1000);
  }
  return false;
}

function readQueueRecords() {
  for (const dir of USER_DATA_CANDIDATES) {
    const file = path.join(dir, 'queue-records.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* try next */ }
  }
  return null;
}

function launchApp() {
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: CWD, detached: true, stdio: 'ignore'
  });
  const kill = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  return { child, kill };
}

async function connectRenderer() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const mainTarget = targets.find((target) => target.url.includes('renderer/index.html'));
  if (!mainTarget) throw new Error('找不到渲染进程目标');
  return new CDP(mainTarget.webSocketDebuggerUrl);
}

async function main() {
  const report = { assertions: {}, notes: [] };
  let selectionSnapshot = null;
  let convId = '';

  // ============ 阶段 A：第一次启动，跑一轮到完成 ============
  log('阶段 A：启动应用（第一次）…');
  const first = launchApp();
  process.on('SIGINT', () => { first.kill(); process.exit(130); });
  process.on('SIGTERM', () => { first.kill(); process.exit(143); });

  let cdp = null;
  try {
    if (!(await waitForPortUp(30_000))) throw new Error('应用启动超时');
    cdp = await connectRenderer();

    const login = await cdp.evaluate('(async () => await watermarkLab.getLoginStatus())()');
    log(`豆包登录状态: ${login?.loggedIn ? '已登录' : '未登录'}`);
    if (!login?.loggedIn) {
      report.aborted = true;
      report.notes.push('豆包未登录');
      first.kill();
      return report;
    }

    await cdp.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');
    selectionSnapshot = await cdp.evaluate('state.files.map((file) => [file.path, file.selected !== false])');
    await cdp.evaluate('state.files.forEach((file) => { file.selected = false; }); renderQueue(); "ok"');
    await cdp.evaluate(`(async () => { await addFiles(await watermarkLab.validatePaths(${JSON.stringify([IMAGE])})); return state.files.length; })()`);
    log('已加入 1 张测试图，开始第一轮处理（等待豆包生成，约 1~2 分钟）…');

    await cdp.evaluate('document.querySelector("#startButton").click(); "started"');

    convId = await doubaoConversationId(60_000);
    log(`豆包窗口出现的会话 ID: ${convId || '（未捕获到）'}`);
    report.assertions['豆包窗口 URL 出现会话 ID'] = Boolean(convId);

    const doneWait = Date.now();
    let completed = false;
    let recordedConvId = '';
    while (Date.now() - doneWait < 130_000) {
      await sleep(2500);
      const status = await cdp.evaluate(`(() => {
        const file = state.files.find((item) => item.name === 'e2e-1.png');
        return { status: file?.status, conversationId: file?.conversationId || '', running: state.running, message: file?.message || '' };
      })()`);
      if (status.status === 'complete') {
        completed = true;
        recordedConvId = status.conversationId;
        log(`第一轮完成，队列记录中的会话 ID: ${recordedConvId || '（空）'}`);
        break;
      }
      if (!status.running && status.status !== 'active') {
        report.notes.push(`第一轮任务异常结束：${status.status} ${status.message}`);
        break;
      }
    }

    report.assertions['第一轮处理完成'] = completed;
    report.assertions['渲染进程记录会话 ID 且与 URL 一致'] = Boolean(recordedConvId) && recordedConvId === convId;

    await sleep(800);
    const records = readQueueRecords();
    const diskRecord = Array.isArray(records) ? records.find((item) => item.path === IMAGE) : null;
    report.diskConversationId = diskRecord?.conversationId || '';
    log(`磁盘 queue-records.json 中的会话 ID: ${report.diskConversationId || '（空）'}`);
    report.assertions['磁盘队列记录写入会话 ID'] = Boolean(convId) && report.diskConversationId === convId;
  } finally {
    cdp?.close();
  }

  if (!convId || report.assertions['第一轮处理完成'] === false) {
    report.notes.push('阶段 A 未拿到可用会话 ID，无法进行重启验证');
    report.aborted = true;
    first.kill();
    return report;
  }

  // ============ 杀掉应用，模拟用户关闭软件 ============
  log('关闭应用（模拟用户退出软件）…');
  first.kill();
  const portDown = await waitForPortDown(15_000);
  log(`调试端口已断开: ${portDown ? '是' : '否（继续，可能有残留）'}`);
  await sleep(1500);

  // ============ 阶段 B：第二次启动，模拟用户重新打开软件 ============
  log('阶段 B：重新启动应用（模拟用户重新打开软件）…');
  const second = launchApp();
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.on('SIGINT', () => { second.kill(); process.exit(130); });
  process.on('SIGTERM', () => { second.kill(); process.exit(143); });

  let cdp2 = null;
  try {
    if (!(await waitForPortUp(30_000))) throw new Error('第二次启动超时');
    cdp2 = await connectRenderer();
    await cdp2.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');

    const loaded = await cdp2.evaluate(`(() => {
      const file = state.files.find((item) => item.path === ${JSON.stringify(IMAGE)});
      return { found: Boolean(file), conversationId: file?.conversationId || '', status: file?.status || '' };
    })()`);
    log(`重启后加载到的测试图记录: found=${loaded.found} conversationId=${loaded.conversationId || '（空）'} status=${loaded.status}`);
    report.loadedConversationId = loaded.conversationId;
    report.assertions['重启后队列记录仍带会话 ID'] = loaded.found && loaded.conversationId === convId;

    const initialUrls = (await doubaoTargets()).map((target) => target.url);
    log(`重启后豆包窗口初始 URL: ${initialUrls.join(' , ') || '（无豆包窗口）'}`);
    report.assertions['重启后豆包窗口不在历史会话上'] = !initialUrls.some((url) => url.includes(`/chat/${convId}`));

    log(`只勾选测试图并重新开始，期望窗口导航回会话 ${convId} …`);
    await cdp2.evaluate(`(() => {
      state.files.forEach((file) => { file.selected = file.path === ${JSON.stringify(IMAGE)}; });
      renderQueue();
      document.querySelector('#startButton').click();
      return 'restarted';
    })()`);

    const navigated = await waitForDoubaoUrl(`doubao.com/chat/${convId}`, 40_000);
    log(`导航结果: ${navigated ? '已回到历史会话 ✔' : '未观察到回到历史会话 ✘'}`);
    report.assertions['重跑时窗口导航回该任务的历史会话'] = navigated;

    await cdp2.evaluate('document.querySelector("#cancelButton")?.click(); "x"').catch(() => {});
    await sleep(2000);
    const stopped = await cdp2.evaluate('!state.running').catch(() => false);
    log(`已取消重跑任务: ${stopped ? '是' : '（取消状态未知）'}`);
  } finally {
    if (cdp2 && selectionSnapshot) {
      try {
        await cdp2.evaluate(`(async () => {
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
        console.error(`恢复现场失败: ${error.message}`);
      }
    }
    cdp2?.close();
    second.kill();
    await waitForPortDown(10_000);
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
