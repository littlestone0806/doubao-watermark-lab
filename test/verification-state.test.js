'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pageVerificationState } = require('../src/doubao-automation');

// 与 src/doubao-automation.js 中的 VERIFICATION_PATTERN 保持一致
const PATTERN_SOURCE = /请选择所有符合(?:上|下)文描述|拖拽到下方|安全验证|完成验证|人机验证|验证码|滑动验证|请先验证|verify you are human/i.source;

function fakeElement({
  tag = 'DIV', id = '', cls = '', text = '', src = '', name = '', title = '',
  width = 120, height = 60, display = 'block', visibility = 'visible', disabled = false
}) {
  return {
    tagName: tag,
    id,
    className: cls,
    innerText: text,
    textContent: text,
    src,
    name,
    title,
    disabled,
    getBoundingClientRect: () => ({ width, height }),
    __display: display,
    __visibility: visibility
  };
}

function withDom({ candidates = [], composers = [], title = '', bodyText = '' }, fn) {
  const previousDocument = global.document;
  const previousGetComputedStyle = global.getComputedStyle;
  global.getComputedStyle = (element) => ({
    display: element.__display || 'block',
    visibility: element.__visibility || 'visible'
  });
  global.document = {
    title,
    body: { innerText: bodyText },
    querySelectorAll: (selector) => (selector.includes('textarea') ? composers : candidates)
  };
  try {
    return fn();
  } finally {
    global.document = previousDocument;
    global.getComputedStyle = previousGetComputedStyle;
  }
}

const state = (dom) => withDom(dom, () => pageVerificationState(PATTERN_SOURCE));

test('正常聊天页（无任何验证元素，输入框可用）不判定为验证中', () => {
  const result = state({
    composers: [fakeElement({ tag: 'TEXTAREA' })],
    bodyText: '豆包聊天界面'
  });
  assert.equal(result.detected, false);
});

test('进行中的挑战：验证容器 + 指令文案 → 判定为验证中', () => {
  const result = state({
    candidates: [fakeElement({ cls: 'captcha-verify-modal', text: '安全验证：请完成验证' })],
    composers: [fakeElement({ tag: 'TEXTAREA' })]
  });
  assert.equal(result.detected, true);
});

test('进行中的挑战：跨域 iframe 即使读不到文案也判定为验证中', () => {
  const result = state({
    candidates: [fakeElement({ tag: 'IFRAME', src: 'https://secsdk.example.com/captcha/challenge' })],
    composers: [fakeElement({ tag: 'TEXTAREA' })]
  });
  assert.equal(result.detected, true);
});

test('验证成功页：残留 verify 容器 + “已完成验证” → 判定为验证已结束', () => {
  const result = state({
    candidates: [fakeElement({ cls: 'verify-result-panel', text: '已完成验证' })],
    composers: [fakeElement({ tag: 'TEXTAREA' })]
  });
  assert.equal(result.detected, false);
});

test('验证成功文案在页面顶部区域时同样判定为验证已结束', () => {
  const result = state({
    candidates: [fakeElement({ cls: 'secsdk-captcha-container', text: '' })],
    bodyText: '验证成功\n正在返回对话…'
  });
  assert.equal(result.detected, false);
});

test('挑战消失后残留的 verify 空容器 + 输入框可用 → 判定为验证已结束', () => {
  const result = state({
    candidates: [fakeElement({ cls: 'secsdk-captcha-placeholder', text: '' })],
    composers: [fakeElement({ tag: 'TEXTAREA' })]
  });
  assert.equal(result.detected, false);
});

test('残留的 verify 空容器但输入框不可用时仍判定为验证中', () => {
  const result = state({
    candidates: [fakeElement({ cls: 'secsdk-captcha-placeholder', text: '' })]
  });
  assert.equal(result.detected, true);
});

test('指令文案含“请完成验证”（无成功字样）时仍判定为验证中', () => {
  const result = state({
    candidates: [fakeElement({ cls: 'secsdk-captcha', text: '请完成验证后继续' })]
  });
  assert.equal(result.detected, true);
});
