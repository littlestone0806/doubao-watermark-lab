'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, newerVersionFromRelease, pickReleaseAsset, portableAssetPattern, summarizeReleaseNotes } = require('../src/update-check');

test('版本号比较：忽略 v 前缀按段比较', () => {
  assert.equal(compareVersions('1.0.6', '1.0.5'), 1);
  assert.equal(compareVersions('v1.0.5', '1.0.5'), 0);
  assert.equal(compareVersions('1.0.5', 'v1.0.6'), -1);
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
});

test('只有更新的版本才会被提取', () => {
  assert.equal(newerVersionFromRelease({ tag_name: 'v1.0.7' }, '1.0.6'), '1.0.7');
  assert.equal(newerVersionFromRelease({ tag_name: 'v1.0.6' }, '1.0.6'), '');
  assert.equal(newerVersionFromRelease({ tag_name: 'v1.0.5' }, '1.0.6'), '');
  assert.equal(newerVersionFromRelease({}, '1.0.6'), '');
});

test('按文件名模式挑选安装包资产', () => {
  const release = {
    assets: [
      { name: 'doubao-watermark-lab-1.0.7-win-x64-setup.exe', browser_download_url: 'https://example.com/win.exe' },
      { name: 'doubao-watermark-lab-1.0.7-mac-arm64.dmg', browser_download_url: 'https://example.com/mac.dmg' },
      { name: 'latest-mac.yml', browser_download_url: 'https://example.com/latest-mac.yml' }
    ]
  };
  assert.deepEqual(pickReleaseAsset(release, /mac-arm64\.dmg$/i), {
    name: 'doubao-watermark-lab-1.0.7-mac-arm64.dmg',
    url: 'https://example.com/mac.dmg'
  });
  assert.equal(pickReleaseAsset(release, /linux\.AppImage$/i), null);
  assert.equal(pickReleaseAsset(null, /mac-arm64\.dmg$/i), null);
});

test('便携版更新包按运行时架构匹配', () => {
  const release = {
    assets: [
      { name: 'doubao-watermark-lab-1.1.0-win-x64-portable.exe', browser_download_url: 'https://example.com/x64.exe' },
      { name: 'doubao-watermark-lab-1.1.0-win-arm64-portable.exe', browser_download_url: 'https://example.com/arm64.exe' },
      { name: 'doubao-watermark-lab-1.1.0-win-x64-setup.exe', browser_download_url: 'https://example.com/setup.exe' }
    ]
  };
  assert.deepEqual(pickReleaseAsset(release, portableAssetPattern('x64')), {
    name: 'doubao-watermark-lab-1.1.0-win-x64-portable.exe',
    url: 'https://example.com/x64.exe'
  });
  assert.deepEqual(pickReleaseAsset(release, portableAssetPattern('arm64')), {
    name: 'doubao-watermark-lab-1.1.0-win-arm64-portable.exe',
    url: 'https://example.com/arm64.exe'
  });
  // ia32 等未知架构回退到 x64；且不会误中 setup 安装包
  assert.equal(pickReleaseAsset(release, portableAssetPattern('ia32')).name, 'doubao-watermark-lab-1.1.0-win-x64-portable.exe');
});

test('更新要点摘要：只取第一节的条目、最多 3 条、去掉 markdown 标记', () => {
  const body = [
    '## 更新内容',
    '',
    '- **中英双语界面**：默认中文，一键切换 `English`',
    '- **验证只弹一个窗口**：完成一次后自动重跑',
    '- 第三条要点',
    '- 第四条不应出现',
    '',
    '## 下载说明',
    '',
    '- macOS 下载 dmg（不属于更新要点）'
  ].join('\n');
  const summary = summarizeReleaseNotes(body);
  const lines = summary.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '· 中英双语界面：默认中文，一键切换 English');
  assert.match(lines[1], /^· 验证只弹一个窗口/);
  assert.ok(!summary.includes('第四条'));
  assert.ok(!summary.includes('dmg'));
});

test('更新要点摘要：HTML 输入（electron-updater releaseNotes）先剥标签再提取', () => {
  const html = '<h2>更新内容</h2><ul><li><strong>双语界面</strong>：一键切换</li><li>验证只弹一窗</li></ul><h2>下载说明</h2><ul><li>不要这条</li></ul>';
  const summary = summarizeReleaseNotes(html);
  const lines = summary.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '· 双语界面：一键切换');
  assert.equal(lines[1], '· 验证只弹一窗');
  assert.ok(!summary.includes('不要这条'));
});

test('更新要点摘要：超长条目截断、空输入返回空串', () => {
  const long = `## 更新内容\n- ${'很'.repeat(80)}长的条目`;
  const summary = summarizeReleaseNotes(long);
  assert.ok(summary.endsWith('…'));
  assert.ok(summary.length <= 66);
  assert.equal(summarizeReleaseNotes(''), '');
  assert.equal(summarizeReleaseNotes(null), '');
  assert.equal(summarizeReleaseNotes('没有条目的普通文本'), '');
});
