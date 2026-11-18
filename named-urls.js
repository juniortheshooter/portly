'use strict';

// Named URLs: a small reverse proxy on loopback so http://shop.localhost:1355 reaches whatever
// port the "shop" project got today. Browsers (Chrome, Edge, Firefox, Safari 17+) already send
// *.localhost to 127.0.0.1 / ::1, so no hosts-file change or admin rights are needed.
//
// Safety rules:
//  - listens on 127.0.0.1 and ::1 only, never on the network;
//  - only answers Host headers that end in .localhost (blocks DNS-rebinding from other sites);
//  - only forwards to ports of projects Portly itself started, and never to Portly's own
//    control port or to the proxy's own port.

const http = require('node:http');
const net = require('node:net');

const DEFAULT_PROXY_PORT = 1355;
const LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RESERVED_NAMES = new Set(['localhost', 'portly']);

function slugifyHostname(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return slug || 'app';
}

/**
 * Cleans a user-typed web address. Accepts "shop", "shop.localhost", "http://shop.localhost:1355/".
 * Returns the bare name (without .localhost) or throws a 400 error.
 */
function normalizeHostnameInput(raw) {
  let value = String(raw || '').trim().toLowerCase();
  value = value.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '');
  value = value.replace(/\.+$/, '');
  if (value.endsWith('.localhost')) value = value.slice(0, -'.localhost'.length);
  const labels = value.split('.');
  const ok =
    value.length > 0 &&
    value.length <= 200 &&
    labels.length <= 4 &&
    labels.every((l) => LABEL_REGEX.test(l)) &&
    !RESERVED_NAMES.has(value);
  if (!ok) {
    const err = new Error(
      `"${raw}" can't be used as a web address. Use lowercase letters, numbers and dashes, like "shop" or "api.shop".`
    );
    err.statusCode = 400;
    throw err;
  }
  return value;
}

/** Turns the Host header into the bare name, or null when it isn't a *.localhost name. */
function hostFromHeader(hostHeader) {
  if (!hostHeader) return null;
  let host = String(hostHeader).trim().toLowerCase();
  if (host.startsWith('[')) return null; // IPv6 literal
  host = host.replace(/:\d+$/, '').replace(/\.+$/, '');
  if (!host.endsWith('.localhost')) return null;
  const name = host.slice(0, -'.localhost'.length);
  return name || null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderNotRunningPage(name, info, listNames, proxyPort, notAnswering = false) {
  const portSuffix = proxyPort === 80 ? '' : `:${proxyPort}`;
  const known = listNames()
    .filter((n) => n.running)
    .map(
      (n) =>
        `<li><a href="http://${escapeHtml(n.hostname)}.localhost${portSuffix}/">${escapeHtml(n.hostname)}.localhost</a> <span>${escapeHtml(n.name)}</span></li>`
    )
    .join('');
  const heading = !info
    ? `No project is called ${escapeHtml(name)}.localhost`
    : notAnswering
      ? `${escapeHtml(info.name)} isn't answering yet`
      : `${escapeHtml(info.name)} isn't running`;
  const body = !info
    ? `<p>Check the web address on the project's card in Portly.</p>`
    : notAnswering
      ? `<p>It may still be starting. Reload in a few seconds, or check its logs in Portly.</p>`
      : `<p>Start <strong>${escapeHtml(info.name)}</strong> in Portly, then reload this page.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading} · Portly</title>
<style>body{font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:12vh auto;padding:0 20px;color:#1f2937;background:#f8fafc}h1{font-size:20px}ul{padding-left:18px}li span{color:#64748b;margin-left:6px}a{color:#4f46e5}@media (prefers-color-scheme:dark){body{background:#0b0c14;color:#e5e7eb}li span{color:#94a3b8}a{color:#a5b4fc}}</style>
</head><body><h1>${heading}</h1>${body}${known ? `<p>Running now:</p><ul>${known}</ul>` : ''}<p style="color:#94a3b8;font-size:13px">Served by Portly's named URL proxy.</p></body></html>`;
}

/**
 * @param {object} opts
 * @param {(name: string) => ({ name: string, port: number|null, running: boolean } | null)} opts.resolve
 * @param {() => Array<{ hostname: string, name: string, running: boolean }>} opts.listNames
 * @param {() => number[]} opts.forbiddenPorts ports that must never be a target (Portly's own)
 */
function createNamedUrlProxy({ resolve, listNames, forbiddenPorts }) {
  const servers = [];
  let listeningPort = null;
  let lastError = null;
  // Which loopback address each target port answered on (dev servers may bind only ::1).
  const familyCache = new Map();

  function connectTarget(port, onReady, onFail) {
    const hosts = familyCache.get(port) === '::1' ? ['::1', '127.0.0.1'] : ['127.0.0.1', '::1'];
    let i = 0;
    const tryNext = () => {
      if (i >= hosts.length) {
        onFail();
        return;
      }
      const host = hosts[i++];
      const sock = net.connect({ host, port });
      const fail = () => {
        sock.destroy();
        tryNext();
      };
      sock.once('error', fail);
      sock.setTimeout(3000, fail);
      sock.once('connect', () => {
        sock.removeListener('error', fail);
        // Keep a listener for the socket's whole life. On Windows a dev server that is
        // stopped sends a reset, which would otherwise surface as an uncaught exception.
        sock.on('error', () => {});
        sock.setTimeout(0);
        familyCache.set(port, host);
        onReady(sock, host);
      });
    };
    tryNext();
  }

  function lookup(req) {
    const name = hostFromHeader(req.headers.host);
    if (!name) return { error: 'host' };
    const info = resolve(name);
    if (!info || !info.running || !info.port) return { error: 'down', name, info };
    const port = Number(info.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'down', name, info };
    const blocked = new Set([...(forbiddenPorts() || []), listeningPort].filter(Boolean).map(Number));
    if (blocked.has(port)) return { error: 'blocked', name, info };
    return { name, info, port };
  }

  function forwardedHeaders(req) {
    const headers = { ...req.headers };
    const remote = req.socket.remoteAddress || '';
    headers['x-forwarded-for'] = headers['x-forwarded-for']
      ? `${headers['x-forwarded-for']}, ${remote}`
      : remote;
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-proto'] = 'http';
    return headers;
  }

  function handleRequest(req, res) {
    const target = lookup(req);
    if (target.error === 'host') {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Portly only answers *.localhost addresses here.');
      return;
    }
    if (target.error) {
      res.writeHead(target.error === 'blocked' ? 403 : 502, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(renderNotRunningPage(target.name, target.info, listNames, listeningPort));
      return;
    }

    connectTarget(
      target.port,
      (sock, host) => {
        const upstream = http.request(
          {
            host,
            port: target.port,
            method: req.method,
            path: req.url,
            headers: forwardedHeaders(req),
            createConnection: () => sock
          },
          (upRes) => {
            res.writeHead(upRes.statusCode || 502, upRes.statusMessage, upRes.rawHeaders);
            upRes.pipe(res);
          }
        );
        upstream.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderNotRunningPage(target.name, target.info, listNames, listeningPort));
          } else {
            res.destroy();
          }
        });
        req.on('aborted', () => upstream.destroy());
        // Each proxied request gets its own upstream connection; close it when the reply is done.
        res.on('close', () => sock.destroy());
        req.pipe(upstream);
      },
      () => {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(renderNotRunningPage(target.name, target.info, listNames, listeningPort, true));
      }
    );
  }

  // WebSockets (Vite / webpack hot reload, socket.io, Next.js dev overlay).
  function handleUpgrade(req, socket, head) {
    const target = lookup(req);
    if (target.error) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.on('error', () => {});
    connectTarget(
      target.port,
      (upstream) => {
        const headers = forwardedHeaders(req);
        let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
        for (const [k, v] of Object.entries(headers)) {
          if (Array.isArray(v)) for (const item of v) raw += `${k}: ${item}\r\n`;
          else if (v !== undefined) raw += `${k}: ${v}\r\n`;
        }
        raw += '\r\n';
        upstream.write(raw);
        if (head && head.length) upstream.write(head);
        upstream.on('error', () => socket.destroy());
        socket.on('close', () => upstream.destroy());
        upstream.on('close', () => socket.destroy());
        upstream.pipe(socket);
        socket.pipe(upstream);
      },
      () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    );
  }

  function listenOn(port, host) {
    return new Promise((resolveListen, rejectListen) => {
      const srv = http.createServer(handleRequest);
      srv.on('upgrade', handleUpgrade);
      srv.on('clientError', (err, socket) => {
        try {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        } catch {
          // ignore
        }
      });
      srv.once('error', rejectListen);
      srv.listen({ port, host, exclusive: true }, () => {
        srv.removeListener('error', rejectListen);
        // Never keep the process alive on its own: it lives and dies with Portly's server.
        srv.unref();
        resolveListen(srv);
      });
    });
  }

  async function start(port = DEFAULT_PROXY_PORT) {
    await stop();
    lastError = null;
    const wanted = Number.isInteger(Number(port)) && Number(port) >= 0 ? Number(port) : DEFAULT_PROXY_PORT;
    try {
      servers.push(await listenOn(wanted, '127.0.0.1'));
    } catch (err) {
      lastError =
        err && err.code === 'EADDRINUSE'
          ? `Port ${wanted} is already used by another program, so named URLs are off. Pick another port in Settings.`
          : err && (err.code === 'EACCES' || err.code === 'EPERM')
            ? `Portly isn't allowed to use port ${wanted} without admin rights. Pick a port above 1024 in Settings.`
            : `Named URLs couldn't start on port ${wanted}: ${err && err.message}`;
      return { ok: false, error: lastError };
    }
    listeningPort = servers[0].address().port;
    // ::1 as well, for browsers that try IPv6 first. Not having IPv6 is fine.
    try {
      servers.push(await listenOn(listeningPort, '::1'));
    } catch {
      // ignore
    }
    return { ok: true, port: listeningPort };
  }

  function stop() {
    const closing = servers.splice(0).map(
      (s) =>
        new Promise((r) => {
          s.close(() => r());
          if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
        })
    );
    listeningPort = null;
    familyCache.clear();
    return Promise.all(closing);
  }

  return {
    start,
    stop,
    getPort: () => listeningPort,
    getError: () => lastError,
    isRunning: () => listeningPort !== null
  };
}

function buildNamedUrl(hostname, proxyPort) {
  if (!hostname || !proxyPort) return null;
  return `http://${hostname}.localhost${Number(proxyPort) === 80 ? '' : `:${proxyPort}`}`;
}

module.exports = {
  createNamedUrlProxy,
  slugifyHostname,
  normalizeHostnameInput,
  hostFromHeader,
  buildNamedUrl,
  DEFAULT_PROXY_PORT
};
