'use strict';

// 鸿蒙引擎容器占位应用：直接 Run 仓库根目录 ohos/ 工程时显示。
// 真实应用代码由 npm run dist:ohos 打包时注入为 app.asar，此占位页仅用于提示。

const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({ width: 860, height: 620, title: '水印清理工作台' });
  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
