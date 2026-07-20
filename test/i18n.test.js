'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../src/renderer/i18n');

test('默认中文：t 原样返回并完成占位符替换', () => {
  i18n.init('zh');
  assert.equal(i18n.t('处理队列'), '处理队列');
  assert.equal(i18n.t('{n} 张', { n: 3 }), '3 张');
  assert.equal(i18n.t('随便一句没有词条的话'), '随便一句没有词条的话');
});

test('英文：静态词条精确翻译', () => {
  i18n.init('en');
  assert.equal(i18n.t('处理队列'), 'Processing queue');
  assert.equal(i18n.t('批量处理'), 'Start batch');
  assert.equal(i18n.t('{n} 张', { n: 3 }), '3 image(s)');
});

test('英文：后端动态消息按正则翻译（含参数提取）', () => {
  i18n.init('en');
  assert.equal(
    i18n.t('安全验证已中断任务，正在重新开始（第 1/2 次）'),
    'Verification interrupted the task — restarting (attempt 1/2)'
  );
  assert.equal(
    i18n.t('豆包回复已结束，继续等待图片出现（最长 60 秒）'),
    "Doubao's reply ended — still waiting for the image (up to 60s)"
  );
  assert.match(
    i18n.t('未能拦截到无水印原图，改用隔离带方案：给原图顶部添加 10% 临时空白带后重发'),
    /10% temporary strip at the top/
  );
});

test('英文：ipc invoke 错误包装会被剥掉前缀后翻译', () => {
  i18n.init('en');
  assert.equal(
    i18n.t("Error invoking remote method 'batch:start': Error: 请先选择要处理的图片"),
    'Select images to process first'
  );
});

test('英文：嵌套错误消息递归翻译', () => {
  i18n.init('en');
  assert.equal(
    i18n.t('等待豆包生成图片超时；高清画布兜底也失败：无法读取豆包高清画布'),
    'Timed out waiting for Doubao to generate the image; the HD canvas fallback also failed: Could not read Doubao\'s HD canvas'
  );
});

test('英文：没有词条的文本原样返回（不产生 undefined）', () => {
  i18n.init('en');
  assert.equal(i18n.t('某个未知的新消息'), '某个未知的新消息');
  assert.equal(i18n.t(''), '');
});
