'use strict';

// 质检演示种子（开发用，不进包）：npx electron scripts/qc-demo-seed.js
// 在 .qc-demo/ 生成两组演示图片，并向队列记录注入两条带真实质检结论的已完成任务，
// 打开应用即可看到黄标效果，点预览可查看差异热力图。

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { computeDiffStats, verdictForStats } = require('../src/qc-check');

const WIDTH = 600;
const HEIGHT = 400;

function makePhotoPixels(seedOffset = 0) {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      pixels[offset] = Math.round(128 + 100 * Math.sin((x + seedOffset) / 47) * Math.cos(y / 31));
      pixels[offset + 1] = Math.round(128 + 90 * Math.sin((x + y + seedOffset) / 53));
      pixels[offset + 2] = Math.round(128 + 110 * Math.cos(x / 29) * Math.sin((y + seedOffset) / 43));
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

function invertPixels(pixels) {
  const copy = Buffer.from(pixels);
  for (let offset = 0; offset < copy.length; offset += 4) {
    copy[offset] = 255 - copy[offset];
    copy[offset + 1] = 255 - copy[offset + 1];
    copy[offset + 2] = 255 - copy[offset + 2];
  }
  return copy;
}

// 与 main.js runQcCheck 相同的归一化与判定路径
function qcOf(sourcePath, outputPath) {
  const sourceImage = nativeImage.createFromPath(sourcePath);
  const outputImage = nativeImage.createFromPath(outputPath);
  const normalize = (image) => {
    const size = image.getSize();
    const scale = Math.min(1, 512 / Math.max(size.width, size.height));
    return image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good'
    }).toBitmap();
  };
  const stats = computeDiffStats(normalize(sourceImage), normalize(outputImage));
  return { verdict: verdictForStats(stats), ...stats };
}

app.whenReady().then(() => {
  const directory = path.join(__dirname, '..', '.qc-demo');
  fs.mkdirSync(directory, { recursive: true });
  const toPng = (pixels) => nativeImage.createFromBitmap(pixels, { width: WIDTH, height: HEIGHT }).toPNG();
  const write = (name, pixels) => {
    const filePath = path.join(directory, name);
    fs.writeFileSync(filePath, toPng(pixels));
    return filePath;
  };

  const photoA = makePhotoPixels(0);
  const sourceA = write('演示-疑似未处理.png', photoA);
  const outputA = write('演示-疑似未处理-输出.png', Buffer.from(photoA));
  const photoB = makePhotoPixels(200);
  const sourceB = write('演示-差异过大.png', photoB);
  const outputB = write('演示-差异过大-输出.png', invertPixels(photoB));

  const makeRecord = (sourcePath, outputPath) => {
    const stat = fs.statSync(sourcePath);
    return {
      path: sourcePath,
      name: path.basename(sourcePath),
      bytes: stat.size,
      width: WIDTH,
      height: HEIGHT,
      thumbnail: '',
      status: 'complete',
      message: '',
      selected: false,
      conversationId: '',
      outputPath,
      outputWidth: WIDTH,
      outputHeight: HEIGHT,
      cropped: false,
      cropPercent: 0,
      cropEdge: 'top',
      removedUploadPadding: false,
      qc: qcOf(sourcePath, outputPath)
    };
  };

  const records = [makeRecord(sourceA, outputA), makeRecord(sourceB, outputB)];
  for (const record of records) {
    console.log(`${record.name} → 质检判定 ${record.qc.verdict}（变化像素 ${(record.qc.changedRatio * 100).toFixed(2)}%）`);
  }

  const queuePath = path.join(os.homedir(), 'Library', 'Application Support', 'doubao-watermark-lab', 'queue-records.json');
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync(queuePath, 'utf8')); } catch { /* 没有记录就从空开始 */ }
  // 幂等：先移除旧的演示记录再追加
  const kept = (Array.isArray(existing) ? existing : [])
    .filter((record) => !String(record.path || '').includes(`${path.sep}.qc-demo${path.sep}`));
  fs.writeFileSync(queuePath, JSON.stringify([...kept, ...records], null, 2), 'utf8');
  console.log(`队列记录已写入（保留现有 ${kept.length} 条 + 演示 2 条）: ${queuePath}`);
  app.exit(0);
});
