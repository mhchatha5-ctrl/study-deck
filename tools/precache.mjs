// Writes the list of app files into sw.js and stamps a content hash as the
// version, so every change to the app ships as an update. Run before commit:
//   node tools/precache.mjs
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const walk = (dir) => readdirSync(join(root, dir)).flatMap((f) => {
  const p = join(dir, f);
  return statSync(join(root, p)).isDirectory() ? walk(p) : [p];
});
const files = [
  'index.html', 'manifest.webmanifest',
  ...walk('css'), ...walk('js'), ...walk('icons'),
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  ...walk('vendor/pdfjs/wasm').filter((f) => !/LICENSE/.test(f)),
  ...walk('vendor/pdfjs/standard_fonts').filter((f) => !/LICENSE/.test(f)),
  ...walk('vendor/pdfjs/iccs').filter((f) => !/LICENSE/.test(f)),
].map((f) => f.split('\\').join('/'));

const hash = createHash('sha256');
for (const f of files) hash.update(f).update(readFileSync(join(root, f)));
const version = hash.digest('hex').slice(0, 12);

let sw = readFileSync(join(root, 'sw.js'), 'utf8');
sw = sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
sw = sw.replace(/\/\/ PRECACHE-START[\s\S]*\/\/ PRECACHE-END/,
  `// PRECACHE-START\nconst PRECACHE = [\n  './',\n${files.map((f) => `  './${f}',`).join('\n')}\n];\n// PRECACHE-END`);
writeFileSync(join(root, 'sw.js'), sw);
console.log(`sw.js: ${files.length + 1} files, version ${version}`);
