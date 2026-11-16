'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = process.cwd();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function findEntryHtml(dirPath) {
  for (const preferred of ['index.html', 'index.htm', 'home.html', 'main.html']) {
    const candidate = path.join(dirPath, preferred);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  try {
    const htmlFile = fs
      .readdirSync(dirPath)
      .find((name) => /\.html?$/i.test(name) && fs.statSync(path.join(dirPath, name)).isFile());
    if (htmlFile) return path.join(dirPath, htmlFile);
  } catch {
    // Ignore directory read error
  }
  return path.join(dirPath, 'index.html');
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  let relPath = decodeURIComponent(reqUrl.pathname).replace(/^\/+/, '');

  let target = relPath ? path.resolve(ROOT, relPath) : findEntryHtml(ROOT);
  if (!target.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = findEntryHtml(target);
  }

  if (!fs.existsSync(target)) {
    const spaFallback = findEntryHtml(ROOT);
    if (fs.existsSync(spaFallback) && !path.extname(relPath)) {
      target = spaFallback;
    } else {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
  }

  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(target).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Static site running at http://localhost:${PORT}`);
});
