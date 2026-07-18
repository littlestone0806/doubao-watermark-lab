'use strict';

// 质检链路真机自检（开发用，不进包）：npx electron scripts/qc-smoke.js
// 在真实 Electron 环境验证 runQcCheck 依赖的原语：nativeImage 解码/缩放/toBitmap(BGRA)/createFromBitmap，
// 以及阈值对真实 JPEG 重编码噪声的判定。

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { computeDiffStats, verdictForStats, buildHeatmap } = require('../src/qc-check');

const WIDTH = 600;
const HEIGHT = 400;

// 生成带平滑渐变与柔和纹理的 BGRA 图（接近真实照片的频率分布）
function makePhotoPixels() {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      pixels[offset] = Math.round(128 + 100 * Math.sin(x / 47) * Math.cos(y / 31)); // B
      pixels[offset + 1] = Math.round(128 + 90 * Math.sin((x + y) / 53)); // G
      pixels[offset + 2] = Math.round(128 + 110 * Math.cos(x / 29) * Math.sin(y / 43)); // R
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function patchRegion(pixels, x0, y0, w, h) {
  const copy = Buffer.from(pixels);
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      copy[offset] = 255 - copy[offset];
      copy[offset + 1] = 255 - copy[offset + 1];
      copy[offset + 2] = 255 - copy[offset + 2];
    }
  }
  return copy;
}

function normalize(image) {
  const size = image.getSize();
  const scale = Math.min(1, 512 / Math.max(size.width, size.height));
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  return image.resize({ width, height, quality: 'good' }).toBitmap();
}

const results = [];
function check(label, actual, expected) {
  const pass = actual === expected;
  results.push(`${pass ? '✅' : '❌'} ${label}：判定 ${actual}（预期 ${expected}）`);
  return pass;
}
function fmtStats(stats) {
  return `变化像素 ${(stats.changedRatio * 100).toFixed(2)}% · 平均差 ${stats.meanDiff.toFixed(2)}`;
}

app.whenReady().then(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-smoke-'));
  try {
    const photo = makePhotoPixels();
    const imageA = nativeImage.createFromBitmap(photo, { width: WIDTH, height: HEIGHT });
    const fileA = path.join(directory, 'a.png');
    const fileJpeg = path.join(directory, 'a-q90.jpg');
    const fileB = path.join(directory, 'b.png');
    const fileD = path.join(directory, 'd.png');
    fs.writeFileSync(fileA, imageA.toPNG());
    fs.writeFileSync(fileJpeg, imageA.toJPEG(90));
    // 局部"去水印"：反转 60x40 区域（2.2% 像素）
    fs.writeFileSync(fileB, nativeImage.createFromBitmap(patchRegion(photo, 270, 180, 60, 40), { width: WIDTH, height: HEIGHT }).toPNG());
    // 全图反色：完全不同
    fs.writeFileSync(fileD, nativeImage.createFromBitmap(patchRegion(photo, 0, 0, WIDTH, HEIGHT), { width: WIDTH, height: HEIGHT }).toPNG());

    const pixelsA = normalize(nativeImage.createFromPath(fileA));
    const pixelsJpeg = normalize(nativeImage.createFromPath(fileJpeg));
    const pixelsB = normalize(nativeImage.createFromPath(fileB));
    const pixelsD = normalize(nativeImage.createFromPath(fileD));

    const statsSelf = computeDiffStats(pixelsA, pixelsA);
    const statsJpeg = computeDiffStats(pixelsA, pixelsJpeg);
    const statsB = computeDiffStats(pixelsA, pixelsB);
    const statsD = computeDiffStats(pixelsA, pixelsD);
    check('PNG 原图 vs 自身', verdictForStats(statsSelf), 'unchanged');
    check('PNG 原图 vs JPEG(q90) 重编码', verdictForStats(statsJpeg), 'unchanged');
    check('局部修改 2.2%', verdictForStats(statsB), 'ok');
    check('全图反色', verdictForStats(statsD), 'different');
    console.log(`  [统计] 自身: ${fmtStats(statsSelf)} | JPEG: ${fmtStats(statsJpeg)} | 局部: ${fmtStats(statsB)} | 反色: ${fmtStats(statsD)}`);

    // 热力图红色通道验证：BGRA 缓冲下红在下标 2
    const width = Math.round(WIDTH * Math.min(1, 512 / WIDTH));
    const height = Math.round(HEIGHT * Math.min(1, 512 / WIDTH));
    const heatmap = nativeImage.createFromBitmap(buildHeatmap(pixelsA, pixelsB, width, height, 2), { width, height });
    const heatmapPath = path.join(directory, 'heatmap.png');
    fs.writeFileSync(heatmapPath, heatmap.toPNG());
    const decoded = nativeImage.createFromPath(heatmapPath);
    const heatPixels = decoded.resize({ width, height, quality: 'good' }).toBitmap();
    const insideOffset = (Math.round(200 * height / HEIGHT) * width + Math.round(300 * width / WIDTH)) * 4;
    const outsideOffset = 4 * 4;
    const redInside = heatPixels[insideOffset + 2];
    const redOutside = heatPixels[outsideOffset + 2];
    check(`热力图修改区内红色增强（R=${redInside}）`, redInside > 150 ? 'pass' : 'fail', 'pass');
    check(`热力图未修改区无红色（R=${redOutside}）`, redOutside < 80 ? 'pass' : 'fail', 'pass');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  results.forEach((line) => console.log(line));
  const failed = results.filter((line) => line.startsWith('❌')).length;
  console.log(failed ? `\n${failed} 项未通过` : '\n全部通过');
  app.exit(failed ? 1 : 0);
});
