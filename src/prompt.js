'use strict';

const DEFAULT_PROMPT = '只对这张图片中原本存在的水印、文字标记或半透明 Logo 覆盖区域进行局部修复，并使用紧邻区域的原有纹理自然补全。除水印实际覆盖的局部区域外，其他内容必须保持与输入原图一致：不得改变背景、主体、构图、位置、大小、色彩、光影、清晰度、画幅比例和分辨率；不得扩图、裁切、重新构图、移动或缩放主体，也不得重绘未被水印遮挡的区域。只输出一张处理后的图片，不要添加任何新文字、Logo、边框或说明。';
const MANUAL_EDIT_PROMPT = '这张图上覆盖了用户临时绘制的亮粉色半透明笔刷标记。亮粉色笔刷只是编辑区域指示，不是原图内容。请彻底移除所有亮粉色标记，并且只修复标记覆盖的局部区域，使用其紧邻区域原有的纹理、背景和光影自然补全。标记之外的所有像素内容必须尽可能保持与输入图一致，不得改变主体、构图、位置、大小、色彩、清晰度、画幅比例或分辨率，不得扩图、裁切或重新构图。只输出一张处理后的图片，不要保留粉色笔刷，也不要添加任何文字、Logo、边框或说明。';

function buildPrompt(settings = {}) {
  const base = String(settings.prompt || DEFAULT_PROMPT).trim() || DEFAULT_PROMPT;
  return base;
}

function buildManualEditPrompt(settings = {}) {
  const base = String(settings.manualEditPrompt || MANUAL_EDIT_PROMPT).trim() || MANUAL_EDIT_PROMPT;
  return base;
}

module.exports = { DEFAULT_PROMPT, MANUAL_EDIT_PROMPT, buildManualEditPrompt, buildPrompt };
