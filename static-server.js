'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = path.resolve(process.cwd());

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

function isInsideRoot(target) {
  const rel = path.relative(ROOT, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function statSafe(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function send(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

function handleRequest(req, res) {
  let reqUrl;
  let relPath;
  try {
    reqUrl = new URL(req.url || '/', 'http://localhost');
    relPath = decodeURIComponent(reqUrl.pathname).replace(/^[\\/]+/, '');
  } catch {
    send(res, 400, 'Bad Request');
    return;
  }

  if (relPath.includes('\0')) {
    send(res, 400, 'Bad Request');
    return;
  }

  let target = relPath ? path.resolve(ROOT, relPath) : findEntryHtml(ROOT);
  if (!isInsideRoot(target)) {
    send(res, 403, 'Forbidden');
    return;
  }

  let stat = statSafe(target);
  if (stat && stat.isDirectory()) {
    target = findEntryHtml(target);
    stat = statSafe(target);
  }

  if (!stat || !stat.isFile()) {
    const spaFallback = findEntryHtml(ROOT);
    const fallbackStat = statSafe(spaFallback);
    if (fallbackStat && fallbackStat.isFile() && !path.extname(relPath)) {
      target = spaFallback;
      stat = fallbackStat;
    } else {
      send(res, 404, 'Not Found');
      return;
    }
  }

  if (!isInsideRoot(target)) {
    send(res, 403, 'Forbidden');
    return;
  }

  const lastModified = stat.mtime.toUTCString();
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Last-Modified': lastModified,
    ETag: etag,
    'Cache-Control': 'no-cache'
  };

  const ifNoneMatch = req.headers['if-none-match'];
  const ifModifiedSince = req.headers['if-modified-since'];
  if (
    (ifNoneMatch && ifNoneMatch === etag) ||
    (!ifNoneMatch && ifModifiedSince && Date.parse(ifModifiedSince) >= Math.floor(stat.mtimeMs / 1000) * 1000)
  ) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  headers['Content-Length'] = stat.size;
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }

  const stream = fs.createReadStream(target);
  stream.on('error', () => {
    if (!res.headersSent) {
      send(res, 500, 'Could not read file');
    } else {
      res.destroy();
    }
  });
  stream.once('open', () => {
    res.writeHead(200, headers);
    stream.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (error) {
    console.error(`[static-server] ${error && error.message ? error.message : error}`);
    send(res, 500, 'Internal Server Error');
  }
});

server.on('clientError', (_error, socket) => {
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  } catch {
    // ignore
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Static site running at http://localhost:${PORT}`);
});
