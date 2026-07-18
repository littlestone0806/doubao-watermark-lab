'use strict';

// 安全验证中断生成后的自动恢复测试：
// 利用 runInPage 会把页面函数序列化后交给 webContents.executeJavaScript 的特点，
// 用假 webContents 按函数名分发预设的页面状态，在 Node 里模拟整个等待流程。
const test = require('node:test');
const assert = require('node:assert/strict');
const { DoubaoAutomation } = require('../src/doubao-automation');

const GENERATED_IMAGE = {
  url: 'https://p3-flow-imagex-sign.byteimg.com/tos-cn-i-a9rns2rl98/rc_gen_image/result.jpeg~tplv-a9rns2rl98-downsize_watermark.png',
  width: 1024,
  height: 1024,
  displayWidth: 512,
  displayHeight: 512,
  pending: false,
  baseline: false,
  userMessage: false,
  alt: '',
  generatedContainer: true
};

function createHarness({ verificationPlan, snapshotPlan, onRegenerate }) {
  const state = { verificationChecks: 0, snapshotCalls: 0, regenerateClicks: 0 };
  const progress = [];
  const webContents = {
    session: {},
    async executeJavaScript(source) {
      if (source.includes('pageVerificationState')) {
        state.verificationChecks += 1;
        return verificationPlan(state);
      }
      if (source.includes('clickRegenerateReply')) {
        state.regenerateClicks += 1;
        return onRegenerate ? onRegenerate(state) : false;
      }
      if (source.includes('pageImageSnapshot')) {
        state.snapshotCalls += 1;
        return snapshotPlan(state);
      }
      throw new Error(`未预期的页面调用: ${source.slice(0, 120)}`);
    }
  };
  const windowStub = {
    webContents,
    isVisible: () => true,
    isMinimized: () => false,
    isDestroyed: () => false,
    show() {},
    moveTop() {},
    focus() {},
    restore() {},
    hide() {}
  };
  const automation = new DoubaoAutomation(windowStub, {
    isCancelled: () => false,
    onProgress: (message) => progress.push(message)
  });
  const capture = { candidates: new Map(), stop() {} };
  return { automation, capture, state, progress };
}

// 验证只出现一次（进入 waitForVerificationIfNeeded 时检测到，轮询时已消失）
const verificationOnce = (state) => ({ detected: state.verificationChecks === 1 });
const noVerification = () => ({ detected: false });
const finishedReplyWithoutImage = {
  images: [],
  generating: false,
  finishedReplies: 1,
  followUps: 0,
  tailText: '好的',
  assistantTailText: '好的'
};

test('安全验证中断生成后：自动重新发送并等到图片', async () => {
  let postRetrySnapshots = 0;
  const harness = createHarness({
    verificationPlan: verificationOnce,
    onRegenerate: () => true,
    snapshotPlan: (state) => {
      if (!state.regenerateClicks) return finishedReplyWithoutImage;
      postRetrySnapshots += 1;
      if (postRetrySnapshots <= 2) {
        return { images: [], generating: true, finishedReplies: 1, followUps: 0, tailText: '正在生成', assistantTailText: '' };
      }
      return { images: [GENERATED_IMAGE], generating: false, finishedReplies: 1, followUps: 0, tailText: '图片已生成', assistantTailText: '图片已生成' };
    }
  });
  const result = await harness.automation.waitForGeneratedImage(new Set(), harness.capture, 90_000, {
    baselineFinishedReplies: 0,
    noImageGraceMs: 8_000
  });
  assert.equal(harness.state.regenerateClicks, 1);
  assert.ok(result.some((item) => item.url === GENERATED_IMAGE.url && item.source === 'dom'));
  assert.ok(harness.progress.some((message) => message.includes('已自动重新发送（第 1 次）')));
});

test('安全验证中断后找不到重新生成按钮：宽限到期仍报 NO_IMAGE_GENERATED', async () => {
  const harness = createHarness({
    verificationPlan: verificationOnce,
    onRegenerate: () => false,
    snapshotPlan: () => finishedReplyWithoutImage
  });
  await assert.rejects(
    harness.automation.waitForGeneratedImage(new Set(), harness.capture, 90_000, {
      baselineFinishedReplies: 0,
      noImageGraceMs: 3_000
    }),
    (error) => {
      assert.equal(error.code, 'NO_IMAGE_GENERATED');
      assert.match(error.message, /提示词可能不合适/);
      return true;
    }
  );
  assert.ok(harness.state.regenerateClicks >= 1);
});

test('无安全验证时正常等待图片出现，不触发重新发送', async () => {
  const harness = createHarness({
    verificationPlan: noVerification,
    snapshotPlan: () => ({
      images: [GENERATED_IMAGE],
      generating: false,
      finishedReplies: 0,
      followUps: 0,
      tailText: '图片已生成',
      assistantTailText: '图片已生成'
    })
  });
  const result = await harness.automation.waitForGeneratedImage(new Set(), harness.capture, 60_000, {
    baselineFinishedReplies: 0,
    noImageGraceMs: 5_000
  });
  assert.equal(harness.state.regenerateClicks, 0);
  assert.ok(result.some((item) => item.url === GENERATED_IMAGE.url));
});

test('自动重新发送最多尝试两次，之后仍报错', async () => {
  const harness = createHarness({
    verificationPlan: verificationOnce,
    onRegenerate: () => true,
    snapshotPlan: () => finishedReplyWithoutImage
  });
  await assert.rejects(
    harness.automation.waitForGeneratedImage(new Set(), harness.capture, 90_000, {
      baselineFinishedReplies: 0,
      noImageGraceMs: 3_000
    }),
    (error) => {
      assert.equal(error.code, 'NO_IMAGE_GENERATED');
      return true;
    }
  );
  assert.equal(harness.state.regenerateClicks, 2);
});
