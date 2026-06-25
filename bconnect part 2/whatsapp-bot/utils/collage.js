'use strict';
const sharp = require('sharp');
const https = require('https');
const http = require('http');

const CELL_W = 400;
const CELL_H = 300;
const GAP = 6;

async function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    try {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { timeout: 9000 }, res => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    } catch (e) { reject(e); }
  });
}

function numberBadge(n) {
  return Buffer.from(
    `<svg width="48" height="48" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="48" height="48" rx="24" fill="#16a34a" opacity="0.90"/>
      <text x="24" y="34" text-anchor="middle" font-size="26" font-weight="bold"
            font-family="Arial,sans-serif" fill="white">${n}</text>
    </svg>`
  );
}

function placeholderCell() {
  const svg = Buffer.from(
    `<svg width="${CELL_W}" height="${CELL_H}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${CELL_W}" height="${CELL_H}" fill="#2d2d2d"/>
      <text x="${CELL_W / 2}" y="${CELL_H / 2 + 8}" text-anchor="middle"
            font-size="18" font-family="Arial,sans-serif" fill="#888">No image</text>
    </svg>`
  );
  return sharp(svg).png().toBuffer();
}

async function processCell(url, index) {
  try {
    const raw = await fetchImageBuffer(url);
    const resized = await sharp(raw)
      .resize(CELL_W, CELL_H, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();

    const badge = numberBadge(index + 1);
    return await sharp(resized)
      .composite([{ input: badge, top: 10, left: 10 }])
      .png()
      .toBuffer();
  } catch {
    return placeholderCell();
  }
}

async function buildCollage(imageUrls) {
  const urls = imageUrls.filter(Boolean).slice(0, 4);
  if (!urls.length) return null;

  const n = urls.length;
  const totalW = CELL_W * n + GAP * (n - 1);

  const cells = await Promise.all(urls.map((url, i) => processCell(url, i)));

  const composites = cells.map((buf, i) => ({
    input: buf,
    left: i * (CELL_W + GAP),
    top: 0
  }));

  return sharp({
    create: { width: totalW, height: CELL_H, channels: 4, background: { r: 18, g: 18, b: 18, alpha: 1 } }
  })
    .composite(composites)
    .jpeg({ quality: 84 })
    .toBuffer();
}

module.exports = { buildCollage };
