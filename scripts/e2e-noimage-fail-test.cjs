'use strict';

/*
 * 注定失败案例实测：批处理正常上传图片后，在它把固定提示词写入输入框的瞬间，
 * 把输入框内容替换成一道算术题（“1+1等于几？只回答数字”）。豆包只会回文字、
 * 必然不生成图片，从而 100% 触发“没有生成图片”报错（不消耗生图额度）。
 * 断言：任务报错、报错不含用户发送的内容、摘要只含豆包回复、不含页面杂质。
 * “无图等待”临时调到 5 秒加快判定，结束后恢复现场。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGE = path.join(CWD, 'e2e-test-images', 'e2e-1.png');
const PORT = 9340;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const HIJACK_QUESTION = '1+1等于几？只回答数字';

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
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`页面脚本异常: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// 与 src/doubao-automation.js 的 setComposerText 相同的页面逻辑
const SET_COMPOSER_TEXT = `(text) => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 80 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const elements = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .filter(visible)
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const hint = \`\${element.getAttribute('placeholder') || ''} \${element.getAttribute('aria-label') || ''}\`;
      let score = rect.top / Math.max(innerHeight, 1);
      if (/发送|消息|输入|问问|描述|prompt|message/i.test(hint)) score += 10;
      if (rect.top > innerHeight * 0.45) score += 4;
      return { element, score };
    })
    .sort((a, b) => b.score - a.score);
  const target = elements[0]?.element;
  if (!target) return { ok: false };
  target.focus();
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const prototype = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(target, text);
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    target.innerHTML = '';
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('insertText', false, text);
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  return { ok: true };
}`;

const COMPOSER_STATE = `(() => {
  const boxes = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
    .map((el) => (el.value || el.innerText || '').trim())
    .filter(Boolean);
  const bubbles = [...document.querySelectorAll('[class*="send-msg-bubble-bg"]')]
    .map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim())
    .filter(Boolean);
  return { composer: boxes.join(' '), lastBubble: bubbles.at(-1) || '', url: location.href };
})()`;

async function main() {
  const report = { assertions: {}, notes: [] };
  let selectionSnapshot = null;
  let settingsSnapshot = null;

  log('启动应用…');
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: CWD, detached: true, stdio: 'ignore'
  });
  const killApp = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', killApp);
  process.on('SIGINT', () => { killApp(); process.exit(130); });
  process.on('SIGTERM', () => { killApp(); process.exit(143); });

  let cdp = null;
  let dcdp = null;
  try {
    const boot = Date.now();
    while (Date.now() - boot < 30_000) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
      await sleep(500);
    }
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    cdp = new CDP(targets.find((target) => target.url.includes('renderer/index.html')).webSocketDebuggerUrl);

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
      interval: document.querySelector('#intervalSeconds').value,
      imageWait: document.querySelector('#imageWaitSeconds').value
    })`);

    await cdp.evaluate(`(() => {
      const parallel = document.querySelector('#parallelProcessing');
      parallel.checked = false;
      parallel.dispatchEvent(new Event('change'));
      const interval = document.querySelector('#intervalSeconds');
      interval.value = '3';
      interval.dispatchEvent(new Event('change'));
      const wait = document.querySelector('#imageWaitSeconds');
      wait.value = '5';
      wait.dispatchEvent(new Event('change'));
      state.files.forEach((file) => { file.selected = false; });
      renderQueue();
      return true;
    })()`);
    await sleep(1200);
    await cdp.evaluate(`(async () => { await addFiles(await watermarkLab.validatePaths(${JSON.stringify([IMAGE])})); return true; })()`);
    log('已加入 1 张测试图，开始批处理（随后劫持提示词为算术题）…');
    await cdp.evaluate('document.querySelector("#startButton").click(); "started"');

    let doubaoTarget = null;
    const waitWin = Date.now();
    while (Date.now() - waitWin < 30_000) {
      await sleep(600);
      doubaoTarget = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
        .find((target) => target.url.includes('doubao.com') && target.type === 'page');
      if (doubaoTarget) break;
    }
    if (!doubaoTarget) throw new Error('豆包窗口未出现');
    dcdp = new CDP(doubaoTarget.webSocketDebuggerUrl);

    log('监听输入框，准备劫持…');
    let sentBubble = '';
    let hijacked = false;
    const hijackDeadline = Date.now() + 60_000;
    while (Date.now() < hijackDeadline) {
      const snapshot = await dcdp.evaluate(COMPOSER_STATE).catch(() => null);
      if (!snapshot) { await sleep(80); continue; }
      if (/\/chat\/[0-9a-zA-Z]{8,}/.test(snapshot.url)) {
        sentBubble = snapshot.lastBubble;
        break;
      }
      if (snapshot.composer.includes('水印') && !snapshot.composer.includes('1+1')) {
        await dcdp.evaluate(`(${SET_COMPOSER_TEXT})(${JSON.stringify(HIJACK_QUESTION)})`).catch(() => {});
        hijacked = true;
      }
      await sleep(60);
    }
    log(`劫持结果: ${hijacked ? '已替换提示词' : '（未抓到替换时机）'} | 实际发送内容: ${sentBubble || '（未读到）'}`);
    report.sentContent = sentBubble;
    report.assertions['劫持成功：实际发送的是算术题'] = sentBubble.includes('1+1');

    if (!sentBubble.includes('1+1')) {
      report.notes.push('提示词替换未赶上发送，本次不算；可重跑一次');
      await cdp.evaluate('document.querySelector("#cancelButton")?.click(); "x"').catch(() => {});
      report.aborted = true;
      return report;
    }

    const failWait = Date.now();
    let final = null;
    while (Date.now() - failWait < 120_000) {
      await sleep(2500);
      final = await cdp.evaluate(`(() => {
        const file = state.files.find((item) => item.name === 'e2e-1.png');
        return { status: file?.status || '', message: file?.message || '', running: state.running };
      })()`);
      if (final.status && final.status !== 'active') break;
    }
    log(`任务最终状态: ${final?.status}`);
    log(`任务消息: ${final?.message}`);
    report.taskMessage = final?.message || '';

    const toasts = await cdp.evaluate(`[...document.querySelectorAll('[class*="toast"]')].map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim()).filter(Boolean)`).catch(() => []);
    log(`界面提示气泡: ${JSON.stringify(toasts)}`);
    report.toasts = toasts;

    report.assertions['任务以错误结束（注定失败）'] = final?.status === 'error';
    report.assertions['报错是“没有生成图片”'] = (final?.message || '').includes('没有生成图片');
    report.assertions['报错不包含用户发送的内容'] = !(final?.message || '').includes('1+1')
      && !(final?.message || '').includes('只对这张图片中原本存在的水印');
    report.assertions['报错包含豆包回复摘要'] = /豆包回复：“.+”/.test(final?.message || '');
    report.assertions['摘要不含页面杂质'] = !(final?.message || '').includes('快速')
      && !(final?.message || '').includes('视频生成')
      && !(final?.message || '').includes('PPT');

    await cdp.evaluate('document.querySelector("#cancelButton")?.click(); "x"').catch(() => {});
    await sleep(1500);
  } finally {
    if (cdp && selectionSnapshot) {
      try {
        await cdp.evaluate(`(async () => {
          const testPaths = new Set(${JSON.stringify([IMAGE])});
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
            const wait = document.querySelector('#imageWaitSeconds');
            wait.value = snapshot.imageWait;
            wait.dispatchEvent(new Event('change'));
          }
          renderQueue();
          await persistQueueNow();
          return 'restored';
        })()`);
        await sleep(1500);
        log('已恢复设置、队列与勾选状态');
      } catch (error) {
        console.error(`恢复现场失败: ${error.message}`);
      }
    }
    dcdp?.close();
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
