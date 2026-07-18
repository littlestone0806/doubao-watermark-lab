'use strict';

/*
 * 自动质检 E2E（不依赖豆包）：用夹具图片驱动真实应用，
 * 验证「预览窗口附带质检差异热力图」全链路——
 * 主进程 runQcCheck → 热力图文件 → preview:load 负载 → 预览窗差异开关与警示色。
 * 运行：node scripts/e2e-qc-preview.cjs（会先执行 qc-fixture.js 生成图片）
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const PORT = 9341;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');
const FIXTURE = path.join(CWD, '.qc-fixture');

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

const checks = [];
function check(label, condition) {
  checks.push(`${condition ? '✅' : '❌'} ${label}`);
  return condition;
}

async function listTargets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json());
}

async function waitForPreviewWindow(timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(500);
    const target = (await listTargets())
      .find((item) => item.url.includes('preview-window.html') && item.type === 'page');
    if (target) return new CDP(target.webSocketDebuggerUrl);
  }
  throw new Error('预览窗口未出现');
}

async function openPreview(renderer, targetName) {
  const targetPath = path.join(FIXTURE, targetName).replace(/\\/g, '\\\\');
  const sourcePath = path.join(FIXTURE, 'source.png').replace(/\\/g, '\\\\');
  await renderer.evaluate(`watermarkLab.openPreviewWindow({ targetPath: ${JSON.stringify(targetPath)}, sourcePath: ${JSON.stringify(sourcePath)} }); "ok"`);
}

async function main() {
  const fixture = spawnSync(ELECTRON, [path.join('scripts', 'qc-fixture.js')], { cwd: CWD, encoding: 'utf8' });
  if (fixture.status !== 0) throw new Error(`夹具生成失败: ${fixture.stderr || fixture.stdout}`);
  log('夹具图片已生成');

  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], { cwd: CWD, detached: true, stdio: 'ignore' });
  const killApp = () => { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ } };
  process.on('exit', killApp);

  let renderer = null;
  let preview = null;
  try {
    const boot = Date.now();
    while (Date.now() - boot < 30_000) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
      await sleep(500);
    }
    renderer = new CDP((await listTargets()).find((target) => target.url.includes('renderer/index.html')).webSocketDebuggerUrl);

    // 场景一：局部修改的结果 → 差异开关可用、无警示色，点开显示热力图与统计
    log('场景一：正常处理结果（局部差异）');
    await openPreview(renderer, 'result-ok.png');
    preview = await waitForPreviewWindow();
    await sleep(1500);
    const okScene = await preview.evaluate(`(() => {
      const toggle = document.querySelector('#diffToggle');
      const hidden = toggle.classList.contains('is-hidden');
      const warning = toggle.classList.contains('is-warning');
      toggle.click();
      const heatVisible = !document.querySelector('#heatmapImage').classList.contains('is-hidden');
      const badgeVisible = !document.querySelector('#diffBadge').classList.contains('is-hidden');
      const meta = document.querySelector('#previewMeta').textContent;
      toggle.click();
      const heatHiddenAfter = document.querySelector('#heatmapImage').classList.contains('is-hidden');
      return { hidden, warning, heatVisible, badgeVisible, meta, heatHiddenAfter };
    })()`);
    check('差异热力开关已显示', !okScene.hidden);
    check('正常结果无警示色', !okScene.warning);
    check('点击后热力图显示', okScene.heatVisible && okScene.badgeVisible);
    check(`副标题显示统计（${okScene.meta}）`, /变化像素 [\d.]+%/.test(okScene.meta));
    check('再次点击热力图隐藏', okScene.heatHiddenAfter);

    // 场景二：与原图一致的结果 → 警示色（unchanged 判定）
    log('场景二：未处理结果（与原图一致）');
    await openPreview(renderer, 'result-unchanged.png');
    preview.close();
    preview = await waitForPreviewWindow();
    await sleep(1500);
    const unchangedScene = await preview.evaluate(`(() => {
      const toggle = document.querySelector('#diffToggle');
      return { hidden: toggle.classList.contains('is-hidden'), warning: toggle.classList.contains('is-warning') };
    })()`);
    check('差异开关仍显示', !unchangedScene.hidden);
    check('疑似未处理带警示色', unchangedScene.warning);
  } finally {
    preview?.close();
    renderer?.close();
    killApp();
    fs.rmSync(FIXTURE, { recursive: true, force: true });
    log('应用已关闭，夹具已清理');
  }

  checks.forEach((line) => console.log(line));
  const failed = checks.filter((line) => line.startsWith('❌')).length;
  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error('E2E 失败:', error.message);
  process.exitCode = 1;
});
