'use strict';

/*
 * 退出残留回归测试：启动应用 → 打开豆包窗口（模拟后台窗口存在）→
 * 关闭主窗口 → 断言整个 Electron 进程在限定时间内完全退出。
 * 修复前：主窗口关闭后豆包窗口仍在，window-all-closed 不触发，进程残留。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const CWD = path.resolve(__dirname, '..');
const PORT = 9347;
const ELECTRON = path.join(CWD, 'node_modules', '.bin', 'electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.log(`[quit-e2e ${new Date().toISOString().slice(11, 19)}] ${message}`);

async function main() {
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: CWD, detached: true, stdio: 'ignore'
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  const killApp = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
  process.on('exit', killApp);

  const boot = Date.now();
  while (Date.now() - boot < 30_000) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { /* wait */ }
    await sleep(500);
  }
  log('应用已启动');

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const mainTarget = targets.find((target) => target.url.includes('renderer/index.html'));
  if (!mainTarget) throw new Error('没有找到主窗口目标');

  // 通过 CDP 让主窗口调用 openLogin，制造一个后台豆包窗口（登录窗口重复调用会被去重）
  const ws = new WebSocket(mainTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = 1;
    const onMessage = (event) => {
      const packet = JSON.parse(event.data);
      if (packet.id === id) {
        ws.removeEventListener('message', onMessage);
        packet.error ? reject(new Error(packet.error.message)) : resolve(packet.result);
      }
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.evaluate', { expression: 'watermarkLab.openLogin()', awaitPromise: false });
  await sleep(2500);
  const withDoubao = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const doubaoOpen = withDoubao.some((target) => target.url.includes('doubao.com'));
  log(`豆包窗口已打开: ${doubaoOpen}`);

  log('关闭主窗口…');
  await send('Runtime.evaluate', { expression: 'window.close()', awaitPromise: false });

  const deadline = Date.now() + 12_000;
  while (!exited && Date.now() < deadline) await sleep(300);
  if (!exited) throw new Error('主窗口关闭 12 秒后应用进程仍未退出（存在残留）');

  // 调试端口也应随之断开
  let portAlive = true;
  try { await fetch(`http://127.0.0.1:${PORT}/json/version`); } catch { portAlive = false; }
  if (portAlive) throw new Error('应用退出后调试端口仍在响应（存在残留进程）');

  log('主窗口关闭后应用已完全退出，无残留进程 ✔');
  try { ws.close(); } catch { /* ignore */ }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(`退出残留测试失败: ${error.message}`);
  process.exit(1);
});
