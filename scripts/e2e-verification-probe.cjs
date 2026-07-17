'use strict';

/*
 * 验证状态探针：在真实豆包页面上运行 pageVerificationState 的各分支，
 * 打印是哪个条件（iframe / 容器 / 文案 / 正则）判定为"验证中"，用于定位
 * "手动完成验证后仍被判定为验证中"的误报来源。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const PORT = 9344;
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

const PROBE = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 30 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const successPattern = /验证(?:成功|通过|已完成)|已(?:完成|通过)验证|congratulations|verification (?:successful|succeeded|passed|complete)/i;
  const pattern = /请选择所有符合(?:上|下)文描述|拖拽到下方|安全验证|完成验证|人机验证|验证码|滑动验证|请先验证|verify you are human/i;
  const candidates = [...document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], iframe, [class*="captcha" i], [class*="verify" i], [id*="captcha" i], [id*="verify" i]'
  )].filter(visible);
  const text = candidates
    .filter((element) => element.tagName !== 'IFRAME')
    .map((element) => element.innerText || element.textContent || '')
    .join('\\n')
    .trim();
  const bodyText = document.body?.innerText || '';
  const hasSpecificChallengeCopy = /请选择所有符合(?:上|下)文描述的图片|拖拽到下方|verify you are human/i.test(bodyText);
  const hasChallengeFrame = candidates.some((element) => element.tagName === 'IFRAME'
    && /captcha|verify|challenge|secsdk|geetest/i.test(\`\${element.src || ''} \${element.name || ''} \${element.title || ''}\`));
  const hasChallengeContainer = candidates.some((element) => element.tagName !== 'IFRAME'
    && /captcha|verify|challenge|secsdk|geetest/i.test(\`\${element.id || ''} \${element.className || ''}\`));
  const successZones = \`\${document.title || ''}\\n\${text}\\n\${bodyText.slice(0, 1500)}\`;
  const instructionText = text.replace(successPattern, '');
  const patternHit = pattern.test(instructionText);
  const hasComposer = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .some((element) => visible(element) && !element.disabled);
  let detected = hasChallengeFrame || hasChallengeContainer || hasSpecificChallengeCopy || patternHit;
  let reason = 'challenge-elements';
  if (successPattern.test(successZones)) { detected = false; reason = 'success-copy'; }
  else if (!hasChallengeFrame && !hasSpecificChallengeCopy && !patternHit && hasComposer) { detected = false; reason = 'composer-ready'; }
  return {
    url: location.href,
    candidateCount: candidates.length,
    hasChallengeFrame,
    hasChallengeContainer,
    hasSpecificChallengeCopy,
    patternHit,
    successCopy: successPattern.test(successZones),
    hasComposer,
    detected,
    reason
  };
})()`;

async function main() {
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
    let targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    renderer = new CDP(targets.find((target) => target.url.includes('renderer/index.html')).webSocketDebuggerUrl);
    const readyWait = Date.now();
    while (Date.now() - readyWait < 15_000) {
      const ready = await renderer.evaluate(`typeof watermarkLab !== 'undefined'`).catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    const login = await renderer.evaluate('watermarkLab.getLoginStatus()');
    log(`登录状态: ${JSON.stringify(login)}`);
    if (!login?.loggedIn) {
      log('未登录，请先在应用里登录豆包后再运行探针');
      return;
    }
    // 打开豆包窗口，复用真实登录会话
    await renderer.evaluate('watermarkLab.openLogin()');
    let doubaoTarget = null;
    const waitWin = Date.now();
    while (Date.now() - waitWin < 20_000) {
      await sleep(800);
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      doubaoTarget = targets.find((target) => /doubao\.com/.test(target.url));
      if (doubaoTarget) break;
    }
    if (!doubaoTarget) throw new Error('豆包窗口未出现');
    log(`豆包页面: ${doubaoTarget.url}`);
    await sleep(4000);
    const doubao = new CDP(doubaoTarget.webSocketDebuggerUrl);
    const report = await doubao.evaluate(PROBE);
    log(`探针结果:\n${JSON.stringify(report, null, 2)}`);
    doubao.close();
  } finally {
    renderer?.close();
    killApp();
    log('应用已关闭');
  }
}

main().catch((error) => {
  console.error('探针失败:', error.message);
  process.exitCode = 1;
});
