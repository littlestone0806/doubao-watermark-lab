'use strict';

/*
 * 只读 DOM 探测（发一条文本消息，不生成图片）：在豆包登录窗口发一句“你好”，
 * 等文字回复完成后转储消息区 DOM 结构，为“报错只显示豆包回复、不显示用户发送内容”
 * 提供选择器依据。会在用户的豆包历史里留下一条“你好”测试对话（结束后告知用户）。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const PORT = 9339;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');

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

// 与 src/doubao-automation.js 中 setComposerText / clickSendButton 相同的页面逻辑
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
  return { ok: true, value: (target.value || target.innerText || target.textContent || '').trim().slice(0, 120) };
}`;

const CLICK_SEND = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 4 && rect.height > 4 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const controls = [...document.querySelectorAll('button, [role="button"]')]
    .filter((element) => visible(element) && !element.disabled && element.getAttribute('aria-disabled') !== 'true')
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const label = \`\${element.innerText || ''} \${element.getAttribute('aria-label') || ''} \${element.title || ''} \${element.getAttribute('data-testid') || ''}\`;
      let score = 0;
      if (/发送|send/i.test(label)) score += 12;
      if (rect.top > innerHeight * 0.55) score += 3;
      if (rect.left > innerWidth * 0.45) score += 2;
      return { element, score, label };
    })
    .filter((item) => item.score >= 12)
    .sort((a, b) => b.score - a.score);
  if (!controls[0]) return { clicked: false };
  controls[0].element.click();
  return { clicked: true, label: controls[0].label };
})()`;

const REPLY_STATE = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const controls = [...document.querySelectorAll('button, [role="button"]')]
    .filter(visible)
    .map((element) => \`\${element.innerText || ''} \${element.getAttribute('aria-label') || ''}\`);
  return {
    generating: controls.some((text) => /停止生成|停止回答|停止创作|正在生成|生成中/i.test(text)),
    finished: controls.some((text) => /重新生成|重新回答|换一换/.test(text)),
    url: location.href
  };
})()`;

const INSPECT = `(() => {
  const clip = (value, n) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const main = document.querySelector('main') || document.body;
  const all = [...main.querySelectorAll('*')];

  const roleInfo = all
    .filter((el) => el.getAttribute('data-message-role') || el.getAttribute('data-role') || el.getAttribute('data-author'))
    .slice(0, 15)
    .map((el) => ({
      tag: el.tagName,
      role: [el.getAttribute('data-message-role'), el.getAttribute('data-role'), el.getAttribute('data-author')].filter(Boolean).join('|'),
      cls: clip(el.className, 90),
      text: clip(el.innerText, 50)
    }));

  const msgish = all
    .filter((el) => /message|bubble|chat-item|conversation|receive|send/i.test(String(el.className)))
    .slice(0, 25)
    .map((el) => ({
      tag: el.tagName,
      cls: clip(el.className, 110),
      text: clip(el.innerText, 40),
      kids: el.children.length
    }));

  const justifyEnd = all
    .filter((el) => /(?:^|\\s)(?:justify-end|items-end)(?:\\s|$)/.test(String(el.className)))
    .filter((el) => clip(el.innerText, 60))
    .slice(0, 10)
    .map((el) => ({ tag: el.tagName, cls: clip(el.className, 110), text: clip(el.innerText, 60) }));

  // 找到包含“你好”的用户消息节点，向上列出其祖先链
  const helloNode = all
    .filter((el) => el.children.length <= 2 && clip(el.innerText, 30) === '你好')
    .pop();
  const helloAncestry = [];
  if (helloNode) {
    let node = helloNode;
    for (let depth = 0; node && node !== main && depth < 10; depth += 1, node = node.parentElement) {
      helloAncestry.push({ tag: node.tagName, cls: clip(node.className, 100) });
    }
  }
  return { url: location.href, roleInfo, msgish, justifyEnd, helloFound: Boolean(helloNode), helloAncestry };
})()`;

async function main() {
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

    log('打开豆包登录窗口…');
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
    await sleep(3000);

    log('在输入框写入“你好”…');
    const setResult = await doubao.evaluate(`(${SET_COMPOSER_TEXT})('你好')`);
    log(`写入结果: ${JSON.stringify(setResult)}`);
    if (!setResult?.ok) throw new Error('没找到输入框（可能未登录）');

    await sleep(600);
    // 与应用一致：发送按钮是纯图标时匹配不到，回退到回车键（用 CDP 产生可信按键事件）
    const sendResult = await doubao.evaluate(CLICK_SEND);
    log(`发送按钮点击: ${JSON.stringify(sendResult)}`);
    if (!sendResult?.clicked) {
      log('回退：通过 CDP 发送回车键…');
      for (const type of ['keyDown', 'keyUp']) {
        await doubao.send('Input.dispatchKeyEvent', {
          type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r'
        });
      }
    }

    log('等待文字回复完成…');
    let state = { generating: false, finished: false };
    const waitReply = Date.now();
    while (Date.now() - waitReply < 60_000) {
      await sleep(2000);
      state = await doubao.evaluate(REPLY_STATE).catch(() => state);
      if (state.finished) break;
    }
    log(`回复状态: ${JSON.stringify(state)}`);
    await sleep(1500);

    const structure = await doubao.evaluate(INSPECT);
    console.log('\n===== DOM 结构 =====');
    console.log(JSON.stringify(structure, null, 2));
  } finally {
    doubao?.close();
    renderer?.close();
    killApp();
    log('应用已关闭');
  }
}

main().catch((error) => {
  console.error('探测失败:', error.message);
  process.exitCode = 1;
});
