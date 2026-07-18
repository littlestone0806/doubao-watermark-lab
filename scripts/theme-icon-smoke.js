'use strict';

// 主题图标效果预览（开发用）：npx electron scripts/theme-icon-smoke.js
// 用真实 app-icon.png 生成各主题色的换色图标，保存到 .qc-demo/shots/ 供目检。

const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { hueOfColor, retintPixels } = require('../src/theme-icon');

const COLORS = {
  forest: '#246b55',
  ocean: '#28739a',
  violet: '#745ca7',
  sunset: '#b9663e',
  graphite: '#53636a',
  'custom-pink': '#d63384'
};

app.whenReady().then(() => {
  const image = nativeImage.createFromPath(path.join(__dirname, '..', 'src', 'assets', 'app-icon.png'));
  const resized = image.resize({ width: 512, height: 512, quality: 'good' });
  const { width, height } = resized.getSize();
  const base = resized.toBitmap();
  const directory = path.join(__dirname, '..', '.qc-demo', 'shots');
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, hex] of Object.entries(COLORS)) {
    const tinted = retintPixels(base, hueOfColor(hex));
    const icon = nativeImage.createFromBitmap(tinted, { width, height });
    const file = path.join(directory, `图标-${name}.png`);
    fs.writeFileSync(file, icon.toPNG());
    console.log(`已生成: ${path.basename(file)}`);
  }
  app.exit(0);
});
