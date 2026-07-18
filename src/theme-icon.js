'use strict';

// 主题图标换色：把应用图标中的"绿色系"像素（图标底渐变、高光）旋转到主题色色相，
// 饱和度与亮度保持不变——白色条纹、金色条纹、透明背景均不动，渐变质感天然保留。
// 纯函数实现，便于单元测试；主进程负责用 nativeImage 解码/回写像素。

// 判定为"绿色系"的色相区间（品牌绿的渐变与高光都落在其中，金色条纹 hue≈35 不受影响）
const GREEN_HUE_MIN = 100;
const GREEN_HUE_MAX = 200;
// 饱和度低于该值视为无彩色（白条纹、透明边缘），不做旋转
const MIN_SATURATION = 0.08;

/** #rrggbb → 色相（0-360 度）；非法输入返回 null */
function hueOfColor(hex) {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return rgbToHsl(r, g, b).h;
}

/** r,g,b ∈ [0,1] → { h: 0-360, s: 0-1, l: 0-1 } */
function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) h = ((b - r) / d + 2) * 60;
  else h = ((r - g) / d + 4) * 60;
  return { h, s, l };
}

/** h ∈ [0,360), s,l ∈ [0,1] → [r, g, b]（0-255 整数） */
function hslToRgb(h, s, l) {
  if (s === 0) {
    const gray = Math.round(l * 255);
    return [gray, gray, gray];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t) => {
    let v = t;
    if (v < 0) v += 1;
    if (v > 1) v -= 1;
    if (v < 1 / 6) return p + (q - p) * 6 * v;
    if (v < 1 / 2) return q;
    if (v < 2 / 3) return p + (q - p) * (2 / 3 - v) * 6;
    return p;
  };
  const hNorm = (((h % 360) + 360) % 360) / 360;
  return [
    Math.round(hue2rgb(hNorm + 1 / 3) * 255),
    Math.round(hue2rgb(hNorm) * 255),
    Math.round(hue2rgb(hNorm - 1 / 3) * 255)
  ];
}

/**
 * 把 BGRA 像素缓冲中的绿色系像素旋转到目标色相（其余像素原样保留）。
 * @param {Buffer|Uint8Array} pixels BGRA 缓冲（nativeImage.toBitmap 的输出）
 * @param {number} targetHue 目标色相（0-360 度）
 * @returns {Buffer} 新缓冲，不改动入参
 */
function retintPixels(pixels, targetHue) {
  const output = Buffer.from(pixels);
  for (let offset = 0; offset + 3 < output.length; offset += 4) {
    if (output[offset + 3] === 0) continue; // 透明像素跳过
    const blue = output[offset] / 255;
    const green = output[offset + 1] / 255;
    const red = output[offset + 2] / 255;
    const { h, s, l } = rgbToHsl(red, green, blue);
    if (s < MIN_SATURATION || h < GREEN_HUE_MIN || h > GREEN_HUE_MAX) continue;
    const [r, g, b] = hslToRgb(targetHue, s, l);
    output[offset] = b;
    output[offset + 1] = g;
    output[offset + 2] = r;
  }
  return output;
}

module.exports = {
  GREEN_HUE_MIN,
  GREEN_HUE_MAX,
  MIN_SATURATION,
  hueOfColor,
  rgbToHsl,
  hslToRgb,
  retintPixels
};
