'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { harvestSseText, harvestImageRawUrls } = require('../src/doubao-automation');
const { createUrlVariants } = require('../src/url-candidates');

function sseOf(...payloads) {
  return payloads.map((p) => `data: ${JSON.stringify(p)}`).join('\n\n') + '\n\n';
}

test('harvestSseText 从 SSE 流中递归提取 image_ori_raw 原图', () => {
  const rawUrl = 'https://imagex-sign.bytecdn.cn/rc_gen_image/tos-cn-i-xxxx-test-obj?x-expires=123&x-signature=abc';
  const thumbUrl = 'https://imagex-sign.bytecdn.cn/rc_gen_image/tos-cn-i-xxxx-test-obj?lk3s=1&format=webp';
  const found = new Map();
  harvestSseText(sseOf(
    { event: 'CHAT_DELTA', message: {} },
    {
      event: 'IMAGE_FINISHED',
      message: {
        content: {
          creations: [{
            image_ori_raw: { url: rawUrl, width: 1024, height: 768 },
            image_thumb: { url: thumbUrl, width: 512, height: 384 },
          }],
        },
      },
    }
  ), found);
  assert.equal(found.size, 1);
  const c = found.get('tos-cn-i-xxxx-test-obj');
  assert.equal(c.source, 'api-raw');
  assert.equal(c.url.includes('x-signature=abc'), true);
  assert.equal(c.width, 1024);
  assert.equal(c.height, 768);
  assert.equal(c.watermarkUrl.includes('lk3s=1'), true);
  assert.equal(c.likelyOriginal, true);
});

test('harvestSseText 按对象 key 去重并容错非 JSON 行', () => {
  const found = new Map();
  const sse = [
    'data: not-json{',
    '',
    'data: {"a":{"image_ori_raw":{"url":"https://x/rc_gen_image/k1?sig=1"}}}',
    '',
    'data: {"b":{"image_ori_raw":{"url":"https://x/rc_gen_image/k1?sig=2"}}}',
    '',
    'data: {"b":{"image_ori_raw":{"url":"https://x/rc_gen_image/k2?sig=3"}}}',
    '',
  ].join('\n');
  harvestSseText(sse, found);
  assert.equal(found.size, 2);
  assert.equal(found.get('k1').url.includes('sig=1'), true);
  assert.equal(found.get('k2').url.includes('sig=3'), true);
});

test('harvestSseText 空输入与非 image_ori_raw 内容不产生候选', () => {
  const found = new Map();
  harvestSseText('', found);
  harvestSseText(null, found);
  harvestSseText(sseOf({ image: { url: 'https://x/rc_gen_image/k9?lk3s=1' } }), found);
  assert.equal(found.size, 0);
});

test('harvestImageRawUrls 超深嵌套与非法 url 不产生候选', () => {
  const found = new Map();
  harvestImageRawUrls({ a: { b: { image_ori_raw: { url: 'ftp://bad' } } } }, found);
  harvestImageRawUrls({ a: { b: { image_ori_raw: { url: 123 } } } }, found);
  assert.equal(found.size, 0);
});

test('api-raw 候选不做签名 URL 改写', () => {
  const variants = createUrlVariants({
    url: 'https://imagex-sign.bytecdn.cn/rc_gen_image/k1?x-expires=123&x-signature=abc',
    source: 'api-raw',
  });
  assert.equal(variants.length, 1);
  assert.equal(variants[0].kind, 'api-raw-original');
  assert.equal(variants[0].likelyOriginal, true);
  assert.equal(variants[0].url.includes('x-signature=abc'), true);
});
