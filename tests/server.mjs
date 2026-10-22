// Static file server for test fixtures (and for serving a local update feed).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.xml': 'text/xml', '.crx': 'application/x-chrome-extension', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function serve(dir, { port = 0 } = {}) {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(dir, path));
      res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    server.hits?.push(path);
  });
  server.hits = [];
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.url = `http://127.0.0.1:${server.address().port}`;
    resolve(server);
  }));
}
