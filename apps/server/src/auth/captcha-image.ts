import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const SCALE = 3;
const WIDTH = 132;
const HEIGHT = 48;

/** 5 宽 7 高的点阵。图像里只有像素，没有字符文本。 */
const GLYPHS: Record<string, number[]> = {
  A: [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  B: [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
  C: [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110],
  D: [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110],
  E: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
  F: [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000],
  G: [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
  H: [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
  J: [0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100],
  K: [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001],
  L: [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111],
  M: [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
  N: [0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001],
  P: [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
  Q: [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101],
  R: [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001],
  S: [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
  T: [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
  U: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
  V: [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
  W: [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010],
  X: [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001],
  Y: [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100],
  Z: [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110],
  '6': [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
};

export function renderCaptchaPng(code: string): Buffer {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const png = drawPng(code, attempt);
    const encoded = png.toString('base64');
    if (
      !png.includes(Buffer.from(code)) &&
      !encoded.includes(code) &&
      !encoded.toLowerCase().includes(code.toLowerCase())
    ) {
      return png;
    }
  }
  return drawPng(code, 0);
}

export function captchaPngDataUrl(code: string): string {
  return `data:image/png;base64,${renderCaptchaPng(code).toString('base64')}`;
}

function drawPng(code: string, salt: number): Buffer {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3);
  fill(pixels, 248, 250, 252);
  const noise = randomBytes(16 + salt);
  for (let i = 0; i < 18; i += 1) {
    const x1 = noise[i % noise.length] ?? 0;
    const y = 4 + ((noise[(i + 3) % noise.length] ?? 0) % (HEIGHT - 8));
    stroke(pixels, x1 % WIDTH, y, (x1 + 40) % WIDTH, y + (i % 2 === 0 ? 6 : -5));
  }
  const glyphs = [...code];
  glyphs.forEach((char, index) => {
    const glyph = GLYPHS[char];
    if (!glyph) return;
    const jitterX = (noise[(index + salt) % noise.length] ?? 0) % 3;
    const jitterY = (noise[(index + 7) % noise.length] ?? 0) % 3;
    const originX = 10 + index * 30 + jitterX;
    const originY = 10 + jitterY;
    glyph.forEach((row, y) => {
      for (let x = 0; x < 5; x += 1) {
        if ((row & (1 << (4 - x))) === 0) continue;
        fillRect(pixels, originX + x * SCALE, originY + y * SCALE, SCALE, SCALE, 31, 41, 55);
      }
    });
  });
  return encodePng(WIDTH, HEIGHT, pixels);
}

function fill(pixels: Uint8Array, r: number, g: number, b: number): void {
  for (let i = 0; i < pixels.length; i += 3) {
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
  }
}

function fillRect(
  pixels: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
): void {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) setPixel(pixels, xx, yy, r, g, b);
  }
}

function stroke(pixels: Uint8Array, x0: number, y0: number, x1: number, y1: number): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let step = 0; step <= steps; step += 1) {
    const x = Math.round(x0 + ((x1 - x0) * step) / steps);
    const y = Math.round(y0 + ((y1 - y0) * step) / steps);
    setPixel(pixels, x, y, 148, 163, 184);
  }
}

function setPixel(pixels: Uint8Array, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const index = (y * WIDTH + x) * 3;
  pixels[index] = r;
  pixels[index + 1] = g;
  pixels[index + 2] = b;
}

function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * (stride + 1);
    raw[offset] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, offset + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc;
}
