# 代码平台适配清单（openharmony）

主进程代码适配点。原则：所有平台相关调用收拢到一个 `IS_OHOS` 常量守卫，保持 mac/win 行为不变。

```js
const IS_OHOS = process.platform === 'openharmony';
```

## 主进程改动点

1. **自动更新**：electron-updater 在鸿蒙不可用。`setupAutoUpdater()` 顶部 `if (IS_OHOS) return;`。
2. **窗口**：无边框/隐藏标题栏样式在鸿蒙无意义（没有窗口三键），`titleBarStyle` 用 `'default'`。
3. **Tray**：鸿蒙上后台运行/隐藏工作窗口依赖 Tray 才能唤回，启动时创建（图标 + tooltip + 菜单：打开主窗口 / 退出），`will-quit` 时销毁。mac/win 若原本无 Tray，仅 IS_OHOS 时创建。
4. **路径**：`app.getPath('appData')` 等可能不可用，包 try 防御；用户输出目录默认值改为 `app.getPath('userData')` 下的应用名子目录（沙箱内可写）。
5. **权限**：启动时 `systemPreferences.requestSystemPermission?.('pasteboard')`（可选链，其他平台无此方法）。注意 `systemPreferences`、`Tray` 要在导入处加上。
6. **对话框选路径**：系统文件对话框选中的外部路径在鸿蒙沙箱下可能不可读。若读取失败，fallback：选中后复制进 userData"收件箱"再处理。
7. **API 版本审计**：模板引擎的 Electron 版本（如 34）通常落后于主项目 devDependency（如 43）。列出项目用到的全部 Electron API，确认在模板版本中存在；不存在的能力做降级。

## 验证

改完先在桌面系统跑 `node --check` + 原有单元测试全过（保证 mac/win 无回归）。ohos 分支本身只能在鸿蒙真机验证，属"语法过、运行时待验"，真机清单见 verification.md。
