/**
 * Turns SVG files into PNG pictures with the headless browser the viewer tests use, for looking at renders where
 * an SVG cannot be opened. Usage: node scripts/svg-to-png.ts <width> <out folder> <file.svg>...
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { chromium } from 'playwright';

const [widthText, out, ...files] = process.argv.slice(2);
if (!widthText || !out || files.length === 0) throw new Error('Usage: node scripts/svg-to-png.ts <width> <out folder> <file.svg>...');
const browser = await chromium.launch();
for (const file of files) {
  const svg = readFileSync(file, 'utf8');
  const [, , , w, h] = /viewBox="(\S+) (\S+) (\S+) (\S+)"/.exec(svg) as RegExpExecArray;
  const width = Number(widthText);
  const height = Math.round((width * Number(h)) / Number(w));
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(`<body style="margin:0">${svg.replace(/width="\d+"/, `width="${width}" height="${height}"`)}</body>`);
  await page.screenshot({ path: join(out, `${basename(file, '.svg')}.png`) });
  await page.close();
}
await browser.close();
