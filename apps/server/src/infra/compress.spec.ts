import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { IMAGE_MAX_OUTPUT_BYTES } from '@geomix/shared';
import { compressImage } from './compress';

describe('image compression', () => {
  it('compresses a PNG of at least 3MB to at most 1MB and strips metadata', async () => {
    const width = 1200;
    const height = 900;
    const raw = Buffer.allocUnsafe(width * height * 3);
    let state = 0x12345678;
    for (let index = 0; index < raw.length; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      raw[index] = state & 255;
    }
    const source = await sharp(raw, { raw: { width, height, channels: 3 } })
      .withMetadata({ orientation: 6 })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(source.length).toBeGreaterThanOrEqual(3 * 1024 * 1024);

    const output = await compressImage(source);
    expect(output.bytes).toBeLessThanOrEqual(IMAGE_MAX_OUTPUT_BYTES);
    expect(output.bytes).toBe(output.body.length);
    expect(output.contentType).toBe('image/jpeg');
    expect(Math.max(output.width, output.height)).toBeLessThanOrEqual(1600);
    expect(output.body.includes(Buffer.from('Exif'))).toBe(false);
    const meta = await sharp(output.body).metadata();
    expect(meta.orientation ?? 1).toBe(1);
    expect(meta.format).toBe('jpeg');
  });

  it('warns on a narrow image and rejects other formats or oversized input', async () => {
    const narrow = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const warning = await compressImage(narrow);
    expect(warning.warning).toContain('500');
    await expect(compressImage(Buffer.from('GIF89a'))).rejects.toMatchObject({ reason: 'format' });
    await expect(compressImage(Buffer.from('<svg></svg>'))).rejects.toMatchObject({
      reason: 'format',
    });
    await expect(
      compressImage(Buffer.alloc(50, 1), {
        maxInputBytes: 20,
        maxOutputBytes: 1024,
        maxEdge: 1600,
        maxPixels: 1000,
        warnWidth: 500,
      }),
    ).rejects.toMatchObject({ reason: 'input' });
  });

  it('compresses 1x1 PNGs cleanly and converts corrupted-body PNG decode errors into ProviderError', async () => {
    const gray67 = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVQIHWP4DwABAQEANl9ngAAAAABJRU5ErkJggg==',
      'base64',
    );
    const ok = await compressImage(gray67);
    expect(ok.width).toBe(1);
    expect(ok.height).toBe(1);
    expect(ok.warning).toContain('500');

    const corruptIdat = Buffer.concat([
      gray67.subarray(0, 45),
      Buffer.from([
        0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x01, 0x02, 0x03, 0x04, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]),
    ]);
    await expect(compressImage(corruptIdat)).rejects.toMatchObject({
      kind: 'contract',
      reason: 'decode',
    });
  });
});
