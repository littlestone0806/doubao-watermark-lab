'use strict';

/*
 * 端到端实测：多任务会话管理 5 条规则。
 *
 * 阶段 1（规则 1）：串行模式跑 2 张无历史的测试图 → 断言两张图各自记录了
 *   【不同】的会话 ID，且磁盘 queue-records.json 一致。
 * 阶段 2（规则 3）：把豆包窗口导航到一个不存在的会话 URL → 观察豆包是否把
 *   URL 重定向走（决定 openConversation 能否识别"会话已被删除"并回退新对话）。
 * 阶段 3（规则 2）：并行模式跑"有历史的 e2e-1 + 无历史的 e2e-3" → 断言一个窗口
 *   接回 e2e-1 的历史会话、另一个窗口创建了【不同】的新会话 → 断言成立立即取消。
 * 规则 4、5 已由 scripts/e2e-conversation-resume.cjs 的重启场景覆盖，不重复消耗额度。
 * 最后恢复现场：还原设置、移除测试图、恢复原有勾选、持久化、杀应用。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGE_1 = path.join(CWD, 'e2e-test-images', 'e2e-1.png');
const IMAGE_2 = path.join(CWD, 'e2e-test-images', 'e2e-2.png');
const IMAGE_3 = path.join(CWD, 'e2e-test-images', 'e2e-3.png');
const TEST_IMAGES = [IMAGE_1, IMAGE_2, IMAGE_3];
const PORT = 9337;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const BOGUS_CONVERSATION_ID = '999999999999999999';
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

async function doubaoTargets() {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return targets.filter((target) => target.url.includes('doubao.com'));
  } catch {
    return [];
  }
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

async function main() {
  const report = { assertions: {}, notes: [] };
  let selectionSnapshot = null;
  let settingsSnapshot = null;
  let conv1 = '';

  log('启动应用…');
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: CWD, detached: true, stdio: 'ignore'
  });
  const killApp = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', killApp);
  process.on('SIGINT', () => { killApp(); process.exit(130); });
  process.on('SIGTERM', () => { killApp(); process.exit(143); });

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

    const login = await cdp.evaluate('(async () => await watermarkLab.getLoginStatus())()');
    log(`豆包登录状态: ${login?.loggedIn ? '已登录' : '未登录'}`);
    if (!login?.loggedIn) {
      report.aborted = true;
      report.notes.push('豆包未登录');
      return report;
    }

    await cdp.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');
    selectionSnapshot = await cdp.evaluate('state.files.map((file) => [file.path, file.selected !== false])');
    settingsSnapshot = await cdp.evaluate(`({
      parallel: document.querySelector('#parallelProcessing').checked,
      interval: document.querySelector('#intervalSeconds').value
    })`);
    log(`现场快照: ${selectionSnapshot.length} 条队列记录, parallel=${settingsSnapshot.parallel}, interval=${settingsSnapshot.interval}`);

    // ============ 阶段 1：串行模式，2 张无历史的图应各自独占新会话 ============
    log('阶段 1（规则 1）：串行跑 2 张图，期望各自得到不同的会话 ID …');
    await cdp.evaluate(`(() => {
      const parallel = document.querySelector('#parallelProcessing');
      parallel.checked = false;
      parallel.dispatchEvent(new Event('change'));
      const interval = document.querySelector('#intervalSeconds');
      interval.value = '3';
      interval.dispatchEvent(new Event('change'));
      state.files.forEach((file) => { file.selected = false; });
      renderQueue();
      return true;
    })()`);
    await sleep(1200);
    await cdp.evaluate(`(async () => { await addFiles(await watermarkLab.validatePaths(${JSON.stringify([IMAGE_1, IMAGE_2])})); return state.files.length; })()`);
    await cdp.evaluate('document.querySelector("#startButton").click(); "started"');

    const phase1Wait = Date.now();
    let phase1 = [];
    while (Date.now() - phase1Wait < 240_000) {
      await sleep(3000);
      phase1 = await cdp.evaluate(`(() => state.files
        .filter((item) => ${JSON.stringify([IMAGE_1, IMAGE_2])}.includes(item.path))
        .map((item) => ({ name: item.name, status: item.status, conversationId: item.conversationId || '', message: item.message || '' })))()`);
      const done = phase1.length === 2 && phase1.every((item) => item.status === 'complete');
      const broken = !phase1.every((item) => ['complete', 'active', ''].includes(item.status))
        || (phase1.length === 2 && phase1.every((item) => item.status !== 'active') && !(await cdp.evaluate('state.running')));
      if (done || broken) break;
    }
    log(`阶段 1 结果: ${JSON.stringify(phase1)}`);
    conv1 = phase1.find((item) => item.name === 'e2e-1.png')?.conversationId || '';
    const conv2 = phase1.find((item) => item.name === 'e2e-2.png')?.conversationId || '';
    report.phase1 = { conv1, conv2 };
    report.assertions['规则1: 串行的两张图都处理完成'] = phase1.length === 2 && phase1.every((item) => item.status === 'complete');
    report.assertions['规则1: 两张图各自记录了会话 ID'] = Boolean(conv1) && Boolean(conv2);
    report.assertions['规则1: 两张图的会话 ID 不同（各自独占会话）'] = Boolean(conv1) && Boolean(conv2) && conv1 !== conv2;

    await sleep(800);
    const records = readQueueRecords();
    const disk1 = Array.isArray(records) ? records.find((item) => item.path === IMAGE_1)?.conversationId || '' : '';
    const disk2 = Array.isArray(records) ? records.find((item) => item.path === IMAGE_2)?.conversationId || '' : '';
    report.assertions['规则1: 磁盘记录与内存一致'] = disk1 === conv1 && disk2 === conv2;

    // ============ 阶段 2：不存在的会话 URL，观察豆包的重定向行为 ============
    log(`阶段 2（规则 3）：把豆包窗口导航到不存在的会话 ${BOGUS_CONVERSATION_ID} …`);
    const doubao = (await doubaoTargets()).find((target) => target.type === 'page');
    if (!doubao) {
      report.notes.push('阶段 2 找不到豆包窗口目标，跳过');
      report.assertions['规则3: 不存在的会话会被豆包重定向（可识别）'] = false;
    } else {
      const dcdp = new CDP(doubao.webSocketDebuggerUrl);
      try {
        await dcdp.evaluate(`(() => { location.href = 'https://www.doubao.com/chat/${BOGUS_CONVERSATION_ID}'; return true; })()`);
        let landed = '';
        const navWait = Date.now();
        while (Date.now() - navWait < 15_000) {
          await sleep(1000);
          landed = await dcdp.evaluate('location.href').catch(() => '');
          if (landed && !landed.includes(BOGUS_CONVERSATION_ID)) break;
        }
        await sleep(2500);
        landed = await dcdp.evaluate('location.href').catch(() => '');
        const title = await dcdp.evaluate('document.title').catch(() => '');
        const bodyText = await dcdp.evaluate('(document.body?.innerText || "").replace(/\\s+/g, " ").slice(0, 160)').catch(() => '');
        log(`落地 URL: ${landed} | 标题: ${title} | 页面片段: ${bodyText}`);
        report.phase2 = { landed, title, bodyText };
        report.assertions['规则3: 不存在的会话会被豆包重定向（openConversation 可识别并回退新对话）'] = Boolean(landed) && !landed.includes(BOGUS_CONVERSATION_ID);
      } finally {
        dcdp.close();
      }
    }

    // ============ 阶段 3：并行混合——有历史的接回，无历史的新建 ============
    if (!conv1) {
      report.notes.push('阶段 1 未拿到 e2e-1 的会话 ID，跳过阶段 3');
      report.assertions['规则2: 并行时有历史的任务接回历史会话'] = false;
      report.assertions['规则2: 并行时无历史的任务创建新会话'] = false;
    } else {
      log(`阶段 3（规则 2）：并行跑 e2e-1（有历史 ${conv1}）+ e2e-3（无历史）…`);
      await cdp.evaluate(`(async () => {
        await addFiles(await watermarkLab.validatePaths(${JSON.stringify([IMAGE_3])}));
        state.files.forEach((file) => { file.selected = file.path === ${JSON.stringify(IMAGE_1)} || file.path === ${JSON.stringify(IMAGE_3)}; });
        renderQueue();
        const parallel = document.querySelector('#parallelProcessing');
        parallel.checked = true;
        parallel.dispatchEvent(new Event('change'));
        return true;
      })()`);
      await sleep(1200);
      await cdp.evaluate('document.querySelector("#startButton").click(); "started"');

      let resumedSeen = false;
      let newConvSeen = '';
      const phase3Wait = Date.now();
      while (Date.now() - phase3Wait < 45_000 && !(resumedSeen && newConvSeen)) {
        await sleep(1000);
        for (const target of await doubaoTargets()) {
          const id = idFromUrl(target.url);
          if (id === conv1) resumedSeen = true;
          else if (id && id !== conv1) newConvSeen = id;
        }
      }
      log(`并行观察: 接回历史会话=${resumedSeen ? '✔' : '✘'} 新会话 ID=${newConvSeen || '（未出现）'}`);
      report.phase3 = { resumedSeen, newConvSeen };
      report.assertions['规则2: 并行时有历史的任务接回历史会话'] = resumedSeen;
      report.assertions['规则2: 并行时无历史的任务创建新会话（ID 不同）'] = Boolean(newConvSeen) && newConvSeen !== conv1;

      await cdp.evaluate('document.querySelector("#cancelButton")?.click(); "x"').catch(() => {});
      await sleep(2000);
      log('已取消并行批处理');
    }
  } finally {
    if (cdp && selectionSnapshot) {
      try {
        await cdp.evaluate(`(async () => {
          const testPaths = new Set(${JSON.stringify(TEST_IMAGES)});
          state.files = state.files.filter((file) => !testPaths.has(file.path));
          const selection = new Map(${JSON.stringify(selectionSnapshot)});
          state.files.forEach((file) => { if (selection.has(file.path)) file.selected = selection.get(file.path); });
          const snapshot = ${JSON.stringify(settingsSnapshot)};
          if (snapshot) {
            const parallel = document.querySelector('#parallelProcessing');
            parallel.checked = snapshot.parallel;
            parallel.dispatchEvent(new Event('change'));
            const interval = document.querySelector('#intervalSeconds');
            interval.value = snapshot.interval;
            interval.dispatchEvent(new Event('change'));
          }
          renderQueue();
          await persistQueueNow();
          return 'restored';
        })()`);
        log('已恢复设置、队列与勾选状态');
      } catch (error) {
        console.error(`恢复现场失败: ${error.message}`);
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
