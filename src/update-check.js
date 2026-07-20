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

// 从 release 正文提取精简更新要点，用于更新弹窗展示。
// 兼容 markdown（GitHub API 的 body）与 HTML（electron-updater 的 releaseNotes）：
// 只取第一个小节（通常是「更新内容」）里的条目，跳过「下载说明」等后续小节；
// 去掉加粗/行内代码等标记，每条截断到 maxLength，最多 maxItems 条
function summarizeReleaseNotes(notes, maxItems = 3, maxLength = 60) {
  let text = String(notes || '');
  if (!text.trim()) return '';
  // HTML → 伪 markdown：<li> 转为条目行，其余标签剥掉
  if (/<[a-z][^>]*>/i.test(text)) {
    text = text
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(?:h[1-6]|p|ul|ol|div)>/gi, '\n')
      .replace(/<h[1-6][^>]*>/gi, '\n## ')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  const lines = text.split(/\r?\n/);
  const items = [];
  let sectionCount = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^#{1,6}\s/.test(trimmed)) {
      sectionCount += 1;
      // 第二个小节起是下载说明等附加信息，不属于更新要点
      if (sectionCount > 1) break;
      continue;
    }
    const bullet = trimmed.match(/^[-*•]\s+(.+)$/);
    if (!bullet) continue;
    let item = bullet[1]
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .trim();
    if (!item) continue;
    if (item.length > maxLength) item = `${item.slice(0, maxLength)}…`;
    items.push(`· ${item}`);
    if (items.length >= maxItems) break;
  }
  return items.join('\n');
}

module.exports = { compareVersions, newerVersionFromRelease, pickReleaseAsset, portableAssetPattern, summarizeReleaseNotes };
