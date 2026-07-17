'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { conversationIdFromUrl, imageAssetKey, noImageGeneratedError, responseHeader } = require('../src/doubao-automation');

test('解析新版 Electron 的响应头对象', () => {
  assert.equal(responseHeader({
    'content-type': ['image/png'],
    'Content-Length': ['12345']
  }, 'content-type'), 'image/png');
  assert.equal(responseHeader({
    'content-type': ['image/png'],
    'Content-Length': ['12345']
  }, 'content-length'), '12345');
});

test('兼容旧版 Electron 的响应头数组', () => {
  assert.equal(responseHeader([
    { name: 'Content-Type', value: 'image/jpeg' }
  ], 'content-type'), 'image/jpeg');
});

test('兼容标准 Headers 对象和空响应头', () => {
  assert.equal(responseHeader(new Headers({ 'content-type': 'image/webp' }), 'CONTENT-TYPE'), 'image/webp');
  assert.equal(responseHeader(null, 'content-type'), '');
});

test('同一图片的不同 CDN 主机和签名会得到相同资源指纹', () => {
  const first = 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/source.png~tplv-a9rns2rl98-image.png?x-signature=one';
  const second = 'https://p26-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/source.png~tplv-a9rns2rl98-image.png?x-signature=two';
  assert.equal(imageAssetKey(first), imageAssetKey(second));
  assert.equal(imageAssetKey(first), '/tos-cn-i-a9rns2rl98/source.png');
});

test('上传原图与生成结果拥有不同资源指纹', () => {
  const source = 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/source.png~tplv-a9rns2rl98-image.png';
  const generated = 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/result.jpeg~tplv-a9rns2rl98-downsize_watermark.png';
  assert.notEqual(imageAssetKey(source), imageAssetKey(generated));
});

test('未生成图片的报错会提示调整提示词并附上豆包回复摘要', () => {
  const error = noImageGeneratedError('这个请求我暂时无法完成，建议你换个描述试试');
  assert.match(error.message, /提示词可能不合适/);
  assert.match(error.message, /换个描述/);
  assert.equal(error.code, 'NO_IMAGE_GENERATED');
  assert.equal(noImageGeneratedError('').message.includes('豆包回复：“'), false);
});

test('从豆包页面地址解析会话 ID', () => {
  assert.equal(conversationIdFromUrl('https://www.doubao.com/chat/7321987654321098'), '7321987654321098');
  assert.equal(conversationIdFromUrl('https://www.doubao.com/chat/7321987654321098?from=share'), '7321987654321098');
  assert.equal(conversationIdFromUrl('https://www.doubao.com/chat/'), '');
  assert.equal(conversationIdFromUrl('https://www.doubao.com/chat'), '');
  assert.equal(conversationIdFromUrl(''), '');
});

test('未生成图片的报错只保留豆包输出，剔除用户发送的内容', () => {
  const error = noImageGeneratedError('移除图片水印 抱歉，这个请求我无法完成，请换个描述', '移除图片水印');
  assert.equal(error.message.includes('移除图片水印'), false);
  assert.match(error.message, /抱歉，这个请求我无法完成/);
  const emptied = noImageGeneratedError('移除图片水印', '移除图片水印');
  assert.equal(emptied.message.includes('豆包回复：“'), false);
});

test('剔除发送内容时不误伤包含该词的豆包回复', () => {
  const error = noImageGeneratedError('你好呀，有什么我可以帮你的吗？', '你好');
  assert.match(error.message, /你好呀，有什么我可以帮你的吗？/);
});

test('未生成图片的报错截取豆包回复的开头部分', () => {
  const long = `开头内容${'中'.repeat(200)}结尾内容`;
  const error = noImageGeneratedError(long);
  assert.match(error.message, /开头内容/);
  assert.equal(error.message.includes('结尾内容'), false);
});
