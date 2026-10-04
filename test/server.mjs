// Minimal static file server for local testing: node test/server.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.pdf': 'application/pdf', '.ics': 'text/calendar', '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream', '.ttf': 'font/ttf', '.icc': 'application/octet-stream',
};
// overrides: Map of path -> body, used by tests to simulate an app update.
export function serve(port = 8080, extraHeaders = {}, overrides = new Map()) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (overrides.has(url.pathname)) {
        res.writeHead(200, { 'Content-Type': TYPES[extname(url.pathname)] || 'text/plain', 'Cache-Control': 'no-cache' });
        res.end(overrides.get(url.pathname));
        return;
      }
      let p = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
      if (p.endsWith('/')) p += 'index.html';
      const file = join(root, p);
      const s = await stat(file);
      if (s.isDirectory()) throw new Error('dir');
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...extraHeaders });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = +process.argv[2] || 8080;
  serve(port).then(() => console.log(`http://localhost:${port}/`));
}
