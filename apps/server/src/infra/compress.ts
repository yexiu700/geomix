import { createHash } from 'node:crypto';
import sharp from 'sharp';
import {
  IMAGE_MAX_EDGE,
  IMAGE_MAX_INPUT_BYTES,
  IMAGE_MAX_OUTPUT_BYTES,
  IMAGE_MAX_PIXELS,
  IMAGE_WARN_WIDTH,
} from '@geomix/shared';
import { ProviderError, PROVIDER_KIND } from './provider-error';

sharp.cache(false);
sharp.concurrency(1);

export type CompressedImage = {
  body: Buffer;
  contentType: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
  warning?: string;
};

export type CompressLimits = {
  maxInputBytes: number;
  maxOutputBytes: number;
  maxEdge: number;
  maxPixels: number;
  warnWidth: number;
};

const DEFAULT_LIMITS: CompressLimits = {
  maxInputBytes: IMAGE_MAX_INPUT_BYTES,
  maxOutputBytes: IMAGE_MAX_OUTPUT_BYTES,
  maxEdge: IMAGE_MAX_EDGE,
  maxPixels: IMAGE_MAX_PIXELS,
  warnWidth: IMAGE_WARN_WIDTH,
};

/**
 * 接受 jpg / png / webp。长边缩到 1600，输出压到 1MB 以内，并去掉 EXIF。
 * 宽度小于 500 只警告。像素和输入字节有上限，避免解码炸弹。
 */
export async function compressImage(
  input: Buffer,
  limits: CompressLimits = DEFAULT_LIMITS,
): Promise<CompressedImage> {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '图片内容不正确', 'empty');
  }
  if (input.length > limits.maxInputBytes) {
    throw new ProviderError(PROVIDER_KIND.TOO_LARGE, '图片超过大小限制', 'input');
  }
  assertMagic(input);
  const source = sharp(input, {
    limitInputPixels: limits.maxPixels,
    pages: 1,
    animated: false,
    sequentialRead: true,
  });
  let meta: sharp.Metadata;
  try {
    meta = await source.metadata();
  } catch {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '图片无法读取', 'decode');
  }
  if (!meta.width || !meta.height || !meta.format) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '图片无法读取', 'metadata');
  }
  if (!['jpeg', 'png', 'webp'].includes(meta.format)) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '只接受 jpg、png、webp', 'format');
  }
  if (meta.width * meta.height > limits.maxPixels) {
    throw new ProviderError(PROVIDER_KIND.TOO_LARGE, '图片像素过多', 'pixels');
  }
  const warning = meta.width < limits.warnWidth ? '宽度小于 500，仅警告' : undefined;
  let edge = Math.min(limits.maxEdge, Math.max(meta.width, meta.height));
  const qualities = [80, 70, 60, 50, 40, 30];
  for (let step = 0; step < 6; step += 1) {
    for (const quality of qualities) {
      const body = await sharp(input, {
        limitInputPixels: limits.maxPixels,
        pages: 1,
        animated: false,
      })
        .rotate()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      if (body.length <= limits.maxOutputBytes) {
        const out = await sharp(body).metadata();
        const width = out.width ?? 0;
        const height = out.height ?? 0;
        if (Math.max(width, height) > limits.maxEdge) {
          throw new ProviderError(PROVIDER_KIND.CONTRACT, '图片压缩后尺寸不正确', 'edge');
        }
        return { body, contentType: 'image/jpeg', width, height, bytes: body.length, warning };
      }
    }
    edge = Math.floor(edge * 0.8);
    if (edge < 320) break;
  }
  throw new ProviderError(PROVIDER_KIND.TOO_LARGE, '压缩后仍超过 1MB', 'output');
}

export async function placeholderPng(seed: string): Promise<Buffer> {
  const hash = createHash('sha256').update(seed).digest();
  const red = hash[0] ?? 32;
  const green = hash[1] ?? 64;
  const blue = hash[2] ?? 96;
  return sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: red, g: green, b: blue } },
  })
    .png()
    .toBuffer();
}

function assertMagic(input: Buffer): void {
  const head = input.subarray(0, 16).toString('utf8').trim().toLowerCase();
  if (
    head.startsWith('<svg') ||
    head.startsWith('<?xml') ||
    head.startsWith('<!doctype') ||
    head.startsWith('gif8')
  ) {
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '只接受 jpg、png、webp', 'format');
  }
  const jpeg = input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff;
  const png = input[0] === 0x89 && input[1] === 0x50 && input[2] === 0x4e && input[3] === 0x47;
  const webp =
    input.subarray(0, 4).toString('ascii') === 'RIFF' &&
    input.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!jpeg && !png && !webp)
    throw new ProviderError(PROVIDER_KIND.CONTRACT, '只接受 jpg、png、webp', 'format');
}
