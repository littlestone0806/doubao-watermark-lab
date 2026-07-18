'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hueOfColor, rgbToHsl, hslToRgb, retintPixels } = require('../src/theme-icon');

function makeBgra(b, g, r, a = 255) {
  return Buffer.from([b, g, r, a]);
}

test('hueOfColor：品牌绿与非法输入', () => {
  const hue = hueOfColor('#246b55');
  assert.ok(hue > 140 && hue < 175, `品牌绿色相应在 140-175 之间，实际 ${hue}`);
  assert.equal(hueOfColor('不是颜色'), null);
  assert.equal(hueOfColor('#fff'), null);
});

test('rgbToHsl / hslToRgb 往返一致', () => {
  const { h, s, l } = rgbToHsl(0.14, 0.42, 0.33);
  const [r, g, b] = hslToRgb(h, s, l);
  assert.ok(Math.abs(r - 36) <= 2 && Math.abs(g - 107) <= 2 && Math.abs(b - 85) <= 2);
});

test('绿色系像素旋转到目标色相，饱和度亮度保持', () => {
  const pixels = makeBgra(85, 107, 36); // BGRA 顺序的品牌绿 #246b55
  const output = retintPixels(pixels, 210); // 旋到蓝色
  const { h, s, l } = rgbToHsl(output[2] / 255, output[1] / 255, output[0] / 255);
  assert.ok(Math.abs(h - 210) < 2, `色相应为 210，实际 ${h}`);
  assert.ok(Math.abs(s - 0.497) < 0.05, '饱和度应保持');
  assert.ok(Math.abs(l - 0.28) < 0.05, '亮度应保持');
  assert.equal(output[3], 255);
});

test('白条纹、金条纹、透明像素不受影响', () => {
  const white = makeBgra(243, 251, 247);
  const gold = makeBgra(101, 179, 224); // #e0b365（BGRA）
  const transparent = makeBgra(85, 107, 36, 0);
  const pixels = Buffer.concat([white, gold, transparent]);
  const output = retintPixels(pixels, 300);
  assert.deepEqual([...output.subarray(0, 4)], [...white]);
  assert.deepEqual([...output.subarray(4, 8)], [...gold]);
  assert.deepEqual([...output.subarray(8, 12)], [...transparent]);
});

test('低饱和绿色高光（带白光的绿）也会被旋转', () => {
  // 模拟图标顶部高光：很浅的绿（S≈0.2，h≈150）
  const [r, g, b] = hslToRgb(150, 0.2, 0.85);
  const pixels = makeBgra(b, g, r);
  const output = retintPixels(pixels, 30);
  const { h } = rgbToHsl(output[2] / 255, output[1] / 255, output[0] / 255);
  assert.ok(Math.abs(h - 30) < 3, `高光色相应旋到 30，实际 ${h}`);
});
