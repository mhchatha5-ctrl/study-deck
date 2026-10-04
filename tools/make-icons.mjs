// Renders the app icons from an inline SVG with headless Chromium.
//   node tools/make-icons.mjs
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const art = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${pad ? 0 : 112}" fill="#2563d9"/>
  <g transform="translate(256 262) scale(${pad ? 0.74 : 0.92}) translate(-256 -262)">
    <rect x="150" y="96" width="250" height="310" rx="28" fill="#9bbcf5" transform="rotate(8 275 251)"/>
    <rect x="112" y="112" width="250" height="310" rx="28" fill="#ffffff"/>
    <rect x="148" y="160" width="150" height="18" rx="9" fill="#c9d7f3"/>
    <rect x="148" y="200" width="178" height="18" rx="9" fill="#c9d7f3"/>
    <path d="M160 312 l46 46 l96 -110" fill="none" stroke="#198a4b" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>`;

const out = [
  ['icons/icon-192.png', 192, false],
  ['icons/icon-512.png', 512, false],
  ['icons/icon-maskable-512.png', 512, true],
  ['icons/apple-touch-icon.png', 180, true],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, full] of out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${art(full)}`);
  writeFileSync(file, await page.screenshot({ omitBackground: !full }));
}
await browser.close();
console.log('icons written');
