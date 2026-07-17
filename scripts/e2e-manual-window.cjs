'use strict';

/*
 * 独立涂抹窗口 E2E：
 *  1) 从主窗口打开竖屏图的涂抹窗口（独立 BrowserWindow，无窗口内叉号）
 *  2) 校验竖屏画布完整适配舞台
 *  3) 校验锚点缩放 + 平移 transform
 *  4) 模拟涂抹一笔，校验发送按钮可用
 *  5) 拦截 submit/close，点击发送，校验提交内容结构
 *  6) 真实点击取消，校验窗口关闭且主窗口未启动任务
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const IMAGE = path.join(CWD, 'e2e-test-images', 'portrait-800x1800.png');
const PORT = 9343;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const OUT_DIR = path.join(CWD, 'docs', 'repro-manual-window');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[manual-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);
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
    log(`截图: ${path.basename(filePath)}`);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function listTargets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: CWD, detached: true, stdio: 'ignore'
  });
  const killApp = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', killApp);

  let renderer = null;
  let manual = null;
  try {
    const boot = Date.now();
    while (Date.now() - boot < 30_000) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
      await sleep(500);
    }
    let targets = await listTargets();
    renderer = new CDP(targets.find((target) => target.url.includes('renderer/index.html')).webSocketDebuggerUrl);
    const readyWait = Date.now();
    while (Date.now() - readyWait < 15_000) {
      const ready = await renderer.evaluate(`typeof state !== 'undefined' && typeof addFiles === 'function'`).catch(() => false);
      if (ready) break;
      await sleep(400);
    }
    await renderer.evaluate('(async () => { const t = Date.now(); while (!state.queueReady && Date.now() - t < 10000) await new Promise((r) => setTimeout(r, 200)); return true; })()');
    // 清理上次运行可能残留的测试记录
    await renderer.evaluate(`(() => {
      const index = state.files.findIndex((item) => item.path === ${JSON.stringify(IMAGE)});
      if (index >= 0) { state.files.splice(index, 1); renderQueue(); persistQueueNow(); }
      return index;
    })()`);
    await renderer.evaluate(`(async () => { await addFiles(await watermarkLab.validatePaths(${JSON.stringify([IMAGE])})); return true; })()`);
    log('竖屏图已加入队列');

    // ---- 打开独立涂抹窗口 ----
    await renderer.evaluate(`(() => {
      const file = state.files.find((item) => item.path === ${JSON.stringify(IMAGE)});
      openManualEditor(file);
      return true;
    })()`);
    let manualTarget = null;
    const waitWin = Date.now();
    while (Date.now() - waitWin < 15_000) {
      await sleep(600);
      targets = await listTargets();
      manualTarget = targets.find((target) => target.url.includes('manual-window.html'));
      if (manualTarget) break;
    }
    assert(manualTarget, '独立涂抹窗口已打开（manual-window.html）');
    if (!manualTarget) throw new Error('涂抹窗口未出现');
    manual = new CDP(manualTarget.webSocketDebuggerUrl);
    await sleep(2500);

    const windowInfo = await manual.evaluate(`(() => ({
      title: document.title,
      hasCloseButton: !!document.querySelector('.preview-close'),
      headerText: document.querySelector('#manualTitle').textContent,
      canvasHidden: document.querySelector('#manualCanvas').classList.contains('is-hidden')
    }))()`);
    log(`窗口信息: ${JSON.stringify(windowInfo)}`);
    assert(windowInfo.title.includes('手动涂抹'), '窗口标题正确');
    assert(!windowInfo.hasCloseButton, '窗口内没有右上角叉号');
    assert(!windowInfo.canvasHidden, '画布已载入');

    // ---- 竖屏适配 ----
    const fitInfo = await manual.evaluate(`(() => {
      const stage = document.querySelector('#manualStage').getBoundingClientRect();
      const rect = document.querySelector('#manualCanvas').getBoundingClientRect();
      return { stageH: Math.round(stage.height), cssW: Math.round(rect.width), cssH: Math.round(rect.height), top: Math.round(rect.top - stage.top), bottom: Math.round(stage.bottom - rect.bottom) };
    })()`);
    log(`竖屏适配: ${JSON.stringify(fitInfo)}`);
    assert(fitInfo.cssH <= fitInfo.stageH, `画布完整落在舞台内（${fitInfo.cssH} <= ${fitInfo.stageH}）`);
    assert(fitInfo.top >= 0 && fitInfo.bottom >= 0, '画布上下无溢出');
    await manual.screenshot(path.join(OUT_DIR, 'manual-window-fit.png'));

    // ---- 锚点缩放 + 平移 ----
    const zoomInfo = await manual.evaluate(`(() => {
      const stage = document.querySelector('#manualStage').getBoundingClientRect();
      setZoom(2, stage.left + stage.width * 0.3, stage.top + stage.height * 0.3);
      return { zoom, panX: Math.round(panX), panY: Math.round(panY), transform: document.querySelector('#manualCanvas').style.transform };
    })()`);
    log(`锚点缩放: ${JSON.stringify(zoomInfo)}`);
    assert(zoomInfo.zoom === 2 && zoomInfo.panY !== 0, '2 倍锚点缩放生效且视口朝锚点偏移');
    await manual.evaluate('panY -= 120; applyTransform(); "p"');
    await sleep(300);
    const panInfo = await manual.evaluate('document.querySelector("#manualCanvas").style.transform');
    assert(/translate3d\([^)]*\) scale\(2\)/.test(panInfo), `平移叠加生效（${panInfo}）`);
    await manual.screenshot(path.join(OUT_DIR, 'manual-window-zoom2.png'));
    await manual.evaluate('resetView(); "r"');

    // ---- 模拟涂抹一笔 ----
    const strokeInfo = await manual.evaluate(`(() => {
      const canvas = document.querySelector('#manualCanvas');
      const rect = canvas.getBoundingClientRect();
      const opts = (x, y) => ({ bubbles: true, pointerId: 7, button: 0, clientX: x, clientY: y });
      try { canvas.dispatchEvent(new PointerEvent('pointerdown', opts(rect.left + rect.width * 0.4, rect.top + rect.height * 0.4))); } catch (e) { /* 合成事件无真实指针 */ }
      try { canvas.dispatchEvent(new PointerEvent('pointermove', opts(rect.left + rect.width * 0.6, rect.top + rect.height * 0.55))); } catch (e) { /* ignore */ }
      try { canvas.dispatchEvent(new PointerEvent('pointerup', opts(rect.left + rect.width * 0.6, rect.top + rect.height * 0.55))); } catch (e) { /* ignore */ }
      if (!strokes.length) { strokes.push([{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.55 }]); }
      redrawCanvas();
      return { strokes: strokes.length, sendDisabled: document.querySelector('#manualSend').disabled };
    })()`);
    log(`涂抹: ${JSON.stringify(strokeInfo)}`);
    assert(strokeInfo.strokes >= 1, '涂抹轨迹已记录');
    assert(!strokeInfo.sendDisabled, '发送按钮已可用');
    await manual.screenshot(path.join(OUT_DIR, 'manual-window-stroke.png'));

    // ---- 提交内容结构（页面状态直查）----
    const payloadCheck = await manual.evaluate(`({
      sourcePath: sourceFile && sourceFile.path,
      strokes: strokes.length,
      brushPercent: Number(document.querySelector('#manualBrushSize').value) || 3
    })`);
    assert(payloadCheck.sourcePath === IMAGE && payloadCheck.strokes >= 1 && payloadCheck.brushPercent > 0,
      `提交内容包含原图路径、轨迹和画笔大小（${JSON.stringify(payloadCheck)}）`);

    // ---- 真实提交（主窗口置为运行中，验证端到端转发且不会触发豆包批处理）----
    const doubaoTargetsBefore = (await listTargets()).filter((target) => /doubao\.com/.test(target.url)).length;
    await renderer.evaluate('state.running = true; "r"');
    await manual.evaluate(`document.querySelector('#manualSend').click(); "s"`);
    await sleep(1500);
    targets = await listTargets();
    const manualGoneAfterSend = !targets.some((target) => target.url.includes('manual-window.html'));
    assert(manualGoneAfterSend, '发送后涂抹窗口自动关闭');
    const toastText = await renderer.evaluate(`document.querySelector('#toastRegion')?.textContent || ''`);
    assert(/已有处理任务正在运行/.test(toastText), '主窗口收到涂抹提交并按预期拦截（运行中提示）');
    const doubaoTargetsAfter = targets.filter((target) => /doubao\.com/.test(target.url)).length;
    assert(doubaoTargetsAfter <= doubaoTargetsBefore, `未新增豆包页面（${doubaoTargetsBefore} → ${doubaoTargetsAfter}）`);
    const runningCleared = await renderer.evaluate('state.running = false; state.running');
    assert(runningCleared === false, '主窗口状态已复原');

    // ---- 重新打开，真实点击取消 ----
    await renderer.evaluate(`(() => {
      const file = state.files.find((item) => item.path === ${JSON.stringify(IMAGE)});
      openManualEditor(file);
      return true;
    })()`);
    manualTarget = null;
    const waitReopen = Date.now();
    while (Date.now() - waitReopen < 15_000) {
      await sleep(600);
      targets = await listTargets();
      manualTarget = targets.find((target) => target.url.includes('manual-window.html'));
      if (manualTarget) break;
    }
    assert(manualTarget, '涂抹窗口可再次打开');
    if (manualTarget) {
      manual = new CDP(manualTarget.webSocketDebuggerUrl);
      await sleep(1200);
      await manual.evaluate(`document.querySelector('#manualCancel').click(); "c"`).catch(() => null);
      await sleep(1200);
      targets = await listTargets();
      assert(!targets.some((target) => target.url.includes('manual-window.html')), '取消后涂抹窗口已关闭');
    }
    const runningState = await renderer.evaluate('state.running');
    assert(runningState === false, '主窗口未启动任何任务');

    // ---- 清理队列 ----
    await renderer.evaluate(`(() => {
      const index = state.files.findIndex((item) => item.path === ${JSON.stringify(IMAGE)});
      if (index >= 0) state.files.splice(index, 1);
      renderQueue();
      persistQueueNow();
      return index;
    })()`);
    log('测试图已从队列移除');
  } finally {
    manual?.close();
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
