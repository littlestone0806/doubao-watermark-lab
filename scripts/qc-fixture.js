'use strict';

// 生成质检 E2E 用的测试图片（开发用，不进包）：npx electron scripts/qc-fixture.js
// 输出到 .qc-fixture/：source.png（原图）、result-ok.png（局部修改）、result-unchanged.png（与原图一致）

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const WIDTH = 600;
const HEIGHT = 400;

function makePhotoPixels() {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = (y * WIDTH + x) * 4;
      pixels[offset] = Math.round(128 + 100 * Math.sin(x / 47) * Math.cos(y / 31));
      pixels[offset + 1] = Math.round(128 + 90 * Math.sin((x + y) / 53));
      pixels[offset + 2] = Math.round(128 + 110 * Math.cos(x / 29) * Math.sin(y / 43));
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

app.whenReady().then(() => {
  const directory = path.join(__dirname, '..', '.qc-fixture');
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: true });
  const photo = makePhotoPixels();
  const toPng = (pixels) => nativeImage.createFromBitmap(pixels, { width: WIDTH, height: HEIGHT }).toPNG();
  fs.writeFileSync(path.join(directory, 'source.png'), toPng(photo));
  fs.writeFileSync(path.join(directory, 'result-ok.png'), toPng(patchRegion(photo, 270, 180, 60, 40)));
  fs.writeFileSync(path.join(directory, 'result-unchanged.png'), toPng(Buffer.from(photo)));
  console.log(`夹具已生成: ${directory}`);
  app.exit(0);
});
