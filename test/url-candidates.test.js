'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createUrlVariants, expandUrlCandidates } = require('../src/url-candidates');
const { buildManualEditPrompt, buildPrompt, DEFAULT_PROMPT } = require('../src/prompt');

test('为可信图片 CDN 的水印处理参数生成无查询参数候选', () => {
  const variants = createUrlVariants({
    url: 'https://example.tos-cn-beijing.volces.com/a.png?x-tos-process=image/watermark,text_abc',
    source: 'dom'
  });
  assert.equal(variants[0].kind, 'queryless-original');
  assert.equal(variants[0].url, 'https://example.tos-cn-beijing.volces.com/a.png');
  assert.equal(variants[1].kind, 'processed');
});

test('不会修改不可信域名的链接', () => {
  const variants = createUrlVariants('https://example.com/a.png?watermark=1');
  assert.equal(variants.length, 1);
  assert.equal(variants[0].url, 'https://example.com/a.png?watermark=1');
});

test('识别豆包路径中的缩略水印模板，不把缩略图误判为原图', () => {
  const variants = createUrlVariants({
    url: 'https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/a.jpeg~tplv-a9rns2rl98-downsize_watermark_1_6_b.png?x-signature=abc',
    source: 'dom'
  });
  assert.equal(variants[0].kind, 'doubao-generated-path');
  assert.equal(variants[0].url, 'https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/a.jpeg');
  assert.equal(variants[0].likelyOriginal, false);
  assert.equal(variants[1].kind, 'doubao-generated-queryless');
  assert.equal(variants[1].likelyOriginal, false);
});

test('豆包生成图即使没有缩略模板也不能当作无水印原图', () => {
  const variants = createUrlVariants({
    url: 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/result.png?x-signature=abc',
    source: 'network'
  });
  assert.equal(variants[0].kind, 'doubao-generated-watermarked');
  assert.equal(variants[0].likelyOriginal, false);
});

test('候选链接会去重', () => {
  const values = expandUrlCandidates([
    'https://example.com/a.png',
    'https://example.com/a.png'
  ]);
  assert.equal(values.length, 1);
});

test('提示词不再追加顶部或底部预留要求', () => {
  assert.equal(buildPrompt({ cropMode: 'never' }), DEFAULT_PROMPT);
  assert.equal(buildPrompt({
    prompt: '只修复水印区域',
    cropMode: 'fallback',
    cropEdge: 'top',
    cropPercent: 10,
    addPaddingBeforeUpload: true
  }), '只修复水印区域');
});

test('手动涂抹使用独立的局部重绘提示词', () => {
  const prompt = buildManualEditPrompt();
  assert.match(prompt, /亮粉色半透明笔刷/);
  assert.match(prompt, /只修复标记覆盖的局部区域/);
});
