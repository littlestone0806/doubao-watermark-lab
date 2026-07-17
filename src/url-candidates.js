'use strict';

const WATERMARK_MARKERS = /(?:watermark|water_mark|logo|doubao|aigc|imagex-watermark)/i;
const DOUBAO_GENERATED_MARKERS = /\/rc_gen_image\//i;
const IMAGE_PROCESS_MARKERS = /(?:x-tos-process|image_process|imageMogr|imageView|resize|quality|format|tplv-|~tplv)/i;
const TRUSTED_IMAGE_HOST = /(?:^|\.)(?:doubao\.com|byteimg\.com|bytedance\.com|volces\.com|volccdn\.com|bytecdn\.cn|ibytedtos\.com)$|(?:^|\.)[^.]*tos-cn-[^.]+\.[^.]+$/i;
const STATIC_ASSET_MARKERS = /(?:favicon|sprite|emoji|avatar|logo(?:[._/-]|$)|icon(?:[._/-]|$)|placeholder|loading)/i;

function hasWatermarkMarker(value) {
  return WATERMARK_MARKERS.test(String(value || ''));
}

function looksLikeStaticAsset(value) {
  return STATIC_ASSET_MARKERS.test(String(value || ''));
}

function isTrustedImageHost(hostname) {
  return TRUSTED_IMAGE_HOST.test(String(hostname || ''));
}

function createUrlVariants(candidate) {
  const rawUrl = typeof candidate === 'string' ? candidate : candidate?.url;
  const source = typeof candidate === 'string' ? 'network' : candidate?.source || 'network';
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return [];

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return [];
  }

  const looksRaw = isTrustedImageHost(parsed.hostname)
    && !IMAGE_PROCESS_MARKERS.test(parsed.href)
    && !hasWatermarkMarker(parsed.href)
    && !DOUBAO_GENERATED_MARKERS.test(parsed.href);
  const doubaoGenerated = DOUBAO_GENERATED_MARKERS.test(parsed.href);

  const variants = [{
    url: parsed.href,
    source,
    kind: doubaoGenerated
      ? 'doubao-generated-watermarked'
      : (hasWatermarkMarker(parsed.href) || IMAGE_PROCESS_MARKERS.test(parsed.href) ? 'processed' : (looksRaw ? 'direct-original' : 'direct')),
    likelyOriginal: looksRaw
  }];

  const canTryAssetVariants = isTrustedImageHost(parsed.hostname)
    && (IMAGE_PROCESS_MARKERS.test(parsed.href) || hasWatermarkMarker(parsed.href));

  if (canTryAssetVariants) {
    const bare = new URL(parsed.href);
    bare.search = '';
    bare.hash = '';
    const strippedPath = bare.pathname.replace(/~tplv-[^/]+$/i, '');
    const hasPathTemplate = strippedPath !== bare.pathname;
    const alternatives = [];
    if (hasPathTemplate) {
      const originalPath = new URL(bare.href);
      originalPath.pathname = strippedPath;
      alternatives.push({
        url: originalPath.href,
        source,
        kind: doubaoGenerated ? 'doubao-generated-path' : 'path-original',
        likelyOriginal: !doubaoGenerated
      });
    }
    if (parsed.search) {
      alternatives.push({
        url: bare.href,
        source,
        kind: doubaoGenerated
          ? 'doubao-generated-queryless'
          : (hasPathTemplate ? 'queryless-processed' : 'queryless-original'),
        likelyOriginal: !hasPathTemplate && !doubaoGenerated
      });
    }
    variants.unshift(...alternatives);
  }

  return variants;
}

function expandUrlCandidates(candidates) {
  const seen = new Set();
  const output = [];
  for (const candidate of candidates || []) {
    for (const variant of createUrlVariants(candidate)) {
      if (seen.has(variant.url)) continue;
      seen.add(variant.url);
      output.push(variant);
    }
  }
  return output;
}

module.exports = {
  createUrlVariants,
  expandUrlCandidates,
  hasWatermarkMarker,
  isTrustedImageHost,
  looksLikeStaticAsset
};
