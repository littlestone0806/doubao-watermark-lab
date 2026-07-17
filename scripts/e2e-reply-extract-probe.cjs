'use strict';

/*
 * 提取效果活体验证（不消耗豆包额度）：打开上次探测留下的“你好”会话，
 * 用与 pageImageSnapshot 完全相同的提取逻辑取最后一条豆包回复，
 * 断言只含豆包输出、不含用户发送内容和联想问题，并打印最终报错文案。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const { noImageGeneratedError } = require('../src/doubao-automation');

const CWD = path.resolve(__dirname, '..');
const PORT = 9339;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const CONVERSATION_URL = 'https://www.doubao.com/chat/38435185299563522';

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

// 与 src/doubao-automation.js 的 pageImageSnapshot 中 assistantTailText 提取逻辑保持一致
const EXTRACTION = `(() => {
  const messageRows = [...document.querySelectorAll('[class*="message-list-"]:not([class*="suggest"]) [class*="max-w-(--content-max-width)"]')];
  const lastAssistantRow = messageRows
    .filter((row) => !row.querySelector('[class*="send-msg-bubble-bg"]'))
    .filter((row) => String(row.innerText || '').trim())
    .at(-1);
  let assistantTailText = '';
  if (lastAssistantRow) {
    const clone = lastAssistantRow.cloneNode(true);
    clone.querySelectorAll('[class*="suggest"], [class*="message-action-bar"], [class*="send-msg-bubble-bg"], button, [role="button"], nav')
      .forEach((element) => element.remove());
    assistantTailText = String(clone.innerText || '').trim();
  }
  const bodyTail = (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(-220);
  return { assistantTailText, rowCount: messageRows.length, bodyTail };
})()`;

const DEBUG_ROWS = `(() => {
  const clip = (value, n) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const containers = [...document.querySelectorAll('[class*="message-list-"]:not([class*="suggest"])')];
  return containers.map((container) => ({
    cls: clip(container.className, 80),
    kids: container.children.length,
    rows: [...container.children].slice(0, 8).map((row) => ({
      cls: clip(row.className, 80),
      text: clip(row.innerText, 60),
      hasUserBubble: Boolean(row.querySelector('[class*="send-msg-bubble-bg"]')),
      kids: row.children.length
    }))
  }));
})()`;

async function main() {
  const report = { assertions: {}, notes: [] };
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: CWD, detached: true, stdio: 'ignore'
  });
  const killApp = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', killApp);

  let renderer = null;
  let doubao = null;
  try {
    const boot = Date.now();
    while (Date.now() - boot < 30_000) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
      await sleep(500);
    }
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    renderer = new CDP(targets.find((target) => target.url.includes('renderer/index.html')).webSocketDebuggerUrl);

    await renderer.evaluate('watermarkLab.openLogin(); "ok"');
    let doubaoTarget = null;
    const waitWin = Date.now();
    while (Date.now() - waitWin < 20_000) {
      await sleep(800);
      doubaoTarget = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
        .find((target) => target.url.includes('doubao.com') && target.type === 'page');
      if (doubaoTarget) break;
    }
    if (!doubaoTarget) throw new Error('豆包窗口未出现');
    doubao = new CDP(doubaoTarget.webSocketDebuggerUrl);

    log(`导航到“你好”会话: ${CONVERSATION_URL}`);
    await doubao.evaluate(`(() => { location.href = ${JSON.stringify(CONVERSATION_URL)}; return true; })()`);
    await sleep(6000);
    const landed = await doubao.evaluate('location.href').catch(() => '');
    log(`落地 URL: ${landed}`);
    if (!landed.includes('38435185299563522')) {
      report.aborted = true;
      report.notes.push('“你好”会话已被删除，无法复用；请重跑一次消息版探测');
      return report;
    }

    const debug = await doubao.evaluate(DEBUG_ROWS);
    console.log('\n===== 行结构调试 =====');
    console.log(JSON.stringify(debug, null, 2));

    const result = await doubao.evaluate(EXTRACTION);
    log(`提取结果: ${JSON.stringify(result.assistantTailText)}（消息行 ${result.rowCount}）`);
    log(`页面对照(尾部 220 字): ${result.bodyTail}`);
    report.extracted = result.assistantTailText;

    report.assertions['提取到豆包回复内容'] = result.assistantTailText.includes('你好呀');
    report.assertions['不包含联想问题'] = !result.assistantTailText.includes('如何被训练') && !result.assistantTailText.includes('什么功能');
    report.assertions['不包含页面杂项'] = !result.assistantTailText.includes('快速') && !result.assistantTailText.includes('重新生成');
    report.assertions['提取结果只有豆包这一条回复'] = result.assistantTailText.length > 0 && result.assistantTailText.length < 60;

    const finalMessage = noImageGeneratedError(result.assistantTailText, '你好').message;
    log(`最终报错文案: ${finalMessage}`);
    report.finalErrorMessage = finalMessage;
    report.assertions['报错文案不含用户发送内容'] = !finalMessage.includes('；“你好”') && !finalMessage.includes(' 你好 ');
  } finally {
    doubao?.close();
    renderer?.close();
    killApp();
    log('应用已关闭');
  }
  return report;
}

main().then((report) => {
  console.log('\n===== 验证结果 =====');
  console.log(JSON.stringify(report, null, 2));
  const failed = Object.entries(report.assertions || {}).filter(([, pass]) => !pass);
  if (report.aborted) {
    console.log('\n结论: 验证中止 -', report.notes.join('；'));
    process.exitCode = 2;
  } else if (failed.length) {
    console.log(`\n结论: ${failed.length} 项断言未通过: ${failed.map(([name]) => name).join('、')}`);
    process.exitCode = 1;
  } else {
    console.log('\n结论: 全部断言通过 ✔');
  }
}).catch((error) => {
  console.error('验证失败:', error.message);
  process.exitCode = 1;
});
