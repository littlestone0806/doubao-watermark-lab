'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, newerVersionFromRelease, pickReleaseAsset, portableAssetPattern } = require('../src/update-check');

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
