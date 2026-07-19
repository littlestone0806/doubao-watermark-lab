'use strict';

// 半自动更新的纯函数部分（与 Electron 解耦，便于单元测试）：
// macOS 未签名包无法使用 Squirrel 自动更新，改为 GitHub API 检查新版本 + 引导用户下载安装包。

// 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0
function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

// 从 GitHub release JSON 中提取新版本号；不比当前版本新时返回空串
function newerVersionFromRelease(release, currentVersion) {
  const latest = String(release?.tag_name || '').replace(/^v/i, '').trim();
  if (!latest) return '';
  return compareVersions(latest, currentVersion) > 0 ? latest : '';
}

// 从 release 资产中挑选匹配的安装包（如 mac-arm64.dmg）
function pickReleaseAsset(release, pattern) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const asset = assets.find((item) => pattern.test(String(item?.name || '')));
  if (!asset?.browser_download_url || !asset.name) return null;
  return { name: asset.name, url: asset.browser_download_url };
}

// Windows 便携版更新包的匹配模式：按运行时架构挑选对应的 win-<arch>-portable.exe
function portableAssetPattern(arch) {
  return arch === 'arm64' ? /-win-arm64-portable\.exe$/i : /-win-x64-portable\.exe$/i;
}

module.exports = { compareVersions, newerVersionFromRelease, pickReleaseAsset, portableAssetPattern };
