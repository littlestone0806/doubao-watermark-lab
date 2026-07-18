'use strict';

const api = window.advancedBridge;

const elements = {
  prompt: document.querySelector('#advancedPrompt'),
  promptCount: document.querySelector('#advancedPromptCount'),
  manualPrompt: document.querySelector('#advancedManualPrompt'),
  manualPromptCount: document.querySelector('#advancedManualPromptCount'),
  cropEdge: document.querySelector('#advancedCropEdge'),
  cropPercent: document.querySelector('#advancedCropPercent'),
  cropPercentOutput: document.querySelector('#advancedCropPercentOutput'),
  compensation: document.querySelector('#advancedCompensation'),
  compensationOutput: document.querySelector('#advancedCompensationOutput'),
  saveButton: document.querySelector('#advancedSettingsSave'),
  cancelButton: document.querySelector('#advancedSettingsCancel'),
  toastRegion: document.querySelector('#toastRegion')
};

let settings = null;

const PRESET_COLORS = Object.freeze({
  forest: '#246b55',
  ocean: '#28739a',
  violet: '#745ca7',
  sunset: '#b9663e',
  graphite: '#53636a'
});

function themeColorParts(value) {
  const hex = /^#[0-9a-f]{6}$/i.test(value || '') ? value.toLowerCase() : PRESET_COLORS.forest;
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  const darken = (channel) => Math.round(channel * 0.68).toString(16).padStart(2, '0');
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return {
    hex,
    rgb: `${red}, ${green}, ${blue}`,
    deep: `#${darken(red)}${darken(green)}${darken(blue)}`,
    contrast: luminance > 0.68 ? '#14201b' : '#f7fffb'
  };
}

function applyAppearance(value) {
  const root = document.documentElement;
  const color = themeColorParts(value.themeColor || PRESET_COLORS[value.colorPalette]);
  root.dataset.theme = value.themeMode || 'auto';
  root.dataset.palette = value.colorPalette || 'forest';
  root.style.setProperty('--accent', color.hex);
  root.style.setProperty('--accent-deep', color.deep);
  root.style.setProperty('--accent-rgb', color.rgb);
  root.style.setProperty('--accent-contrast', color.contrast);
}

function formatPercent(value) {
  const number = Number(value) || 0;
  return `${Number.isInteger(number) ? number : number.toFixed(1)}%`;
}

function toast(message, type = 'info') {
  const item = document.createElement('div');
  item.className = `toast${type === 'error' ? ' error' : ''}`;
  item.textContent = message;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), 3200);
}

function syncCount(input, output) {
  output.value = input.value.length;
  output.textContent = input.value.length;
}

function syncRangeOutput(input, output) {
  const value = formatPercent(input.value);
  output.value = value;
  output.textContent = value;
}

function fillForm(value) {
  elements.prompt.value = value.prompt || '';
  syncCount(elements.prompt, elements.promptCount);
  elements.manualPrompt.value = value.manualEditPrompt || '';
  syncCount(elements.manualPrompt, elements.manualPromptCount);
  elements.cropEdge.value = value.cropEdge || 'top';
  elements.cropPercent.value = value.cropPercent ?? 10;
  syncRangeOutput(elements.cropPercent, elements.cropPercentOutput);
  elements.compensation.value = value.cropCompensationPercent ?? 0.5;
  syncRangeOutput(elements.compensation, elements.compensationOutput);
}

async function save() {
  elements.saveButton.disabled = true;
  try {
    await api.save({
      ...settings,
      prompt: elements.prompt.value,
      manualEditPrompt: elements.manualPrompt.value,
      cropEdge: elements.cropEdge.value,
      cropPercent: Number(elements.cropPercent.value),
      cropCompensationPercent: Number(elements.compensation.value)
    });
    api.close();
  } catch (error) {
    toast(error.message || String(error), 'error');
    elements.saveButton.disabled = false;
  }
}

elements.prompt.addEventListener('input', () => syncCount(elements.prompt, elements.promptCount));
elements.manualPrompt.addEventListener('input', () => syncCount(elements.manualPrompt, elements.manualPromptCount));
elements.cropPercent.addEventListener('input', () => syncRangeOutput(elements.cropPercent, elements.cropPercentOutput));
elements.compensation.addEventListener('input', () => syncRangeOutput(elements.compensation, elements.compensationOutput));
elements.saveButton.addEventListener('click', save);
elements.cancelButton.addEventListener('click', () => api.close());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.close();
});

(async () => {
  settings = await api.getSettings();
  applyAppearance(settings);
  fillForm(settings);
})();
