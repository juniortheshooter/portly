'use strict';

// Tests for Stacks, per-project environment variables and named URLs (roadmap items 1-3).
// Runs against a throwaway data folder and a random proxy port, so it never touches your
// real project list or a Portly that is already running.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-stacks-'));
const DATA_ROOT = path.join(TMP, 'storage');
fs.mkdirSync(path.join(DATA_ROOT, 'data'), { recursive: true });
process.env.DEVDECK_DATA_DIR = DATA_ROOT;
process.env.PORTLY_PROXY_PORT = '0';
process.env.PORTLY_STACK_READY_TIMEOUT_MS = '15000';

const envLib = require('./env-store');
const named = require('./named-urls');
const detect = require('./stack-detect');

// One script plays every service. It records the env it got, checks whether the database
// already answered when it started, and (when it has a PORT) serves HTTP and an echo upgrade.
const SVC_SCRIPT = `
const http = require('http'), net = require('net'), fs = require('fs');
const name = process.argv[2];
const delay = Number(process.argv[3] || 0);
const pick = ['PORT','PORTLY_DB_PORT','PORTLY_DB_URL','PORTLY_PROJECT','PORTLY_STACK','PORTLY_NAMED_URL','API_KEY','DB_URL','SHARED','LITERAL'];
const env = {};
for (const k of pick) env[k] = process.env[k] === undefined ? null : process.env[k];
const dbCheck = process.env.PORTLY_DB_PORT
  ? new Promise((r) => { const s = net.connect(Number(process.env.PORTLY_DB_PORT), '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); })
  : Promise.resolve(null);
dbCheck.then((dbUp) => {
  fs.writeFileSync('out-' + name + '.json', JSON.stringify({ name, env, dbUp, at: Date.now() }));
  if (!process.env.PORT) { setInterval(() => {}, 1000); return; }
  setTimeout(() => {
    const srv = http.createServer((q, s) => s.end(name + ' host=' + q.headers.host + ' xfh=' + (q.headers['x-forwarded-host'] || '')));
    srv.on('upgrade', (req, sock) => {
      sock.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: echo\\r\\nConnection: Upgrade\\r\\n\\r\\n');
      sock.on('data', (d) => sock.write(d));
    });
    srv.listen(Number(process.env.PORT), '127.0.0.1');
  }, delay);
});
`;

function makeApp(dir, extraFiles = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'svc.js'), SVC_SCRIPT);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: path.basename(dir), scripts: { dev: 'node svc.js x' } }));
  for (const [f, content] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, f), content);
  return dir;
}

const ROOT = path.join(TMP, 'shop');
const DB_DIR = makeApp(path.join(ROOT, 'db'));
const API_DIR = makeApp(path.join(ROOT, 'api'), {
  '.env': 'API_KEY=from-dotenv\n# comment\nexport QUOTED="two words" # trailing\nMULTI="a\nb"\n'
});
const WEB_DIR = makeApp(path.join(ROOT, 'web'));

const srv = require('./server');

const results = [];
async function check(name, fn) {
  await fn();
  results.push(`PASS: ${name}`);
}

function request(port, urlPath, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = text;
          try {
            data = JSON.parse(text);
          } catch {
            // plain text
          }
          resolve({ status: res.statusCode, data, text });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readOut = (dir, name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `out-${name}.json`), 'utf8'));
  } catch {
    return null;
  }
};

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error('timed out waiting');
}

async function run() {
  // ---------- unit checks ----------
  await check('.env parser handles export, quotes, comments and multi-line values', () => {
    const rows = envLib.parseDotEnv('A=1\nexport B="two words" # c\nC=\'x#y\'\n#D=4\nE=plain # note\nF="l1\nl2"\nbad key=1\n');
    assert.deepStrictEqual(rows, [
      { key: 'A', value: '1' },
      { key: 'B', value: 'two words' },
      { key: 'C', value: 'x#y' },
      { key: 'E', value: 'plain' },
      { key: 'F', value: 'l1\nl2' }
    ]);
  });

  await check('env config rejects bad names, PATH and duplicates', () => {
    assert.throws(() => envLib.normalizeEnvConfig({ profiles: { Dev: [{ key: '1BAD', value: 'x' }] } }), /valid variable name/);
    assert.throws(() => envLib.normalizeEnvConfig({ profiles: { Dev: [{ key: 'Path', value: 'x' }] } }), /PATH/);
    assert.throws(() => envLib.normalizeEnvConfig({ profiles: { Dev: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] } }), /twice/);
    const ok = envLib.normalizeEnvConfig({ activeProfile: 'Nope', profiles: { Dev: [{ key: '', value: '' }], Test: [] } });
    assert.strictEqual(ok.activeProfile, 'Dev');
    assert.deepStrictEqual(ok.profiles.Dev, []);
  });

  await check('${NAME} references expand, $${NAME} stays literal', () => {
    const lookup = (n) => ({ PORT: '4000', HOST: 'localhost' })[n];
    assert.strictEqual(envLib.expandReferences('http://${HOST}:${PORT}/x${MISSING}', lookup), 'http://localhost:4000/x');
    assert.strictEqual(envLib.expandReferences('$${PORT}', lookup), '${PORT}');
  });

  await check('env store encrypts values when a codec is available and never writes them in plain text', () => {
    const file = path.join(TMP, 'env-test.json');
    const codec = {
      available: () => true,
      encrypt: (s) => Buffer.from(s, 'utf8').toString('base64').split('').reverse().join(''),
      decrypt: (s) => Buffer.from(s.split('').reverse().join(''), 'base64').toString('utf8')
    };
    const store = envLib.createEnvStore(file, codec);
    store.set('owner', { profiles: { Dev: [{ key: 'TOKEN', value: 'super-secret-value' }] } });
    assert.ok(!fs.readFileSync(file, 'utf8').includes('super-secret-value'));
    const again = envLib.createEnvStore(file, codec);
    assert.deepStrictEqual(again.activeVars('owner'), { TOKEN: 'super-secret-value' });
    assert.deepStrictEqual(again.summary('owner'), { activeProfile: 'Dev', profileNames: ['Dev'], count: 1 });
  });

  await check('web addresses are validated and slugified', () => {
    assert.strictEqual(named.normalizeHostnameInput('http://Shop.localhost:1355/'), 'shop');
    assert.strictEqual(named.normalizeHostnameInput('api.shop'), 'api.shop');
    assert.throws(() => named.normalizeHostnameInput('-bad'), /can't be used/);
    assert.throws(() => named.normalizeHostnameInput('portly'), /can't be used/);
    assert.throws(() => named.normalizeHostnameInput('a b'), /can't be used/);
    assert.strictEqual(named.slugifyHostname('Café Shop!'), 'cafe-shop');
    assert.strictEqual(named.hostFromHeader('API.Shop.localhost:1355'), 'api.shop');
    assert.strictEqual(named.hostFromHeader('evil.com'), null);
    assert.strictEqual(named.hostFromHeader('localhost:1355'), null);
  });

  await check('stack detection reads Procfile, workspaces and docker compose', () => {
    const helpers = { inspect: srv.inspectProjectPath, isProjectDir: (d) => fs.existsSync(path.join(d, 'package.json')) };

    const proc = path.join(TMP, 'proc');
    makeApp(proc, { 'Procfile.dev': 'web: npm run dev\nworker: node worker.js\n' });
    const p = detect.suggestStack(proc, helpers);
    assert.strictEqual(p.source, 'Procfile.dev');
    assert.deepStrictEqual(p.services.map((s) => [s.name, s.kind]), [['web', 'server'], ['worker', 'worker']]);

    const mono = path.join(TMP, 'mono');
    fs.mkdirSync(mono, { recursive: true });
    fs.writeFileSync(path.join(mono, 'package.json'), JSON.stringify({ name: '@acme/mono', workspaces: ['apps/*', 'packages/*'] }));
    makeApp(path.join(mono, 'apps', 'web'));
    makeApp(path.join(mono, 'apps', 'api'));
    fs.mkdirSync(path.join(mono, 'packages', 'ui'), { recursive: true });
    fs.writeFileSync(path.join(mono, 'packages', 'ui', 'package.json'), JSON.stringify({ name: 'ui', scripts: { build: 'tsc' } }));
    const m = detect.suggestStack(mono, helpers);
    assert.strictEqual(m.name, 'mono');
    assert.strictEqual(m.source, 'workspaces');
    assert.deepStrictEqual(m.services.map((s) => s.name).sort(), ['api', 'web']);
    assert.deepStrictEqual(m.services.find((s) => s.name === 'web').startAfter, ['api']);

    const comp = path.join(TMP, 'comp');
    fs.mkdirSync(comp, { recursive: true });
    fs.writeFileSync(
      path.join(comp, 'compose.yaml'),
      'services:\n  db:\n    image: postgres:16\n  api:\n    build: .\n    ports: ["4000:4000"]\n    depends_on:\n      - db\n  jobs:\n    build: .\n    depends_on: [db, api]\n'
    );
    const c = detect.suggestStack(comp, helpers);
    assert.strictEqual(c.source, 'compose.yaml');
    const byName = Object.fromEntries(c.services.map((s) => [s.name, s]));
    assert.strictEqual(byName.api.command, 'docker compose -f compose.yaml up api');
    assert.deepStrictEqual(byName.api.startAfter, ['db']);
    assert.deepStrictEqual(byName.jobs.startAfter, ['db', 'api']);
    assert.strictEqual(byName.jobs.kind, 'worker');

    const folders = detect.suggestStack(ROOT, helpers);
    assert.strictEqual(folders.source, 'folders');
    assert.deepStrictEqual(folders.services.map((s) => s.name).sort(), ['api', 'db', 'web']);
    assert.deepStrictEqual(folders.services.find((s) => s.name === 'api').startAfter, ['db']);
    assert.deepStrictEqual(folders.services.find((s) => s.name === 'web').startAfter, ['api']);
  });

  // ---------- integration ----------
  const started = await srv.startServer(0);
  const port = started.port;
  try {
    const status = srv.getNamedUrlStatus();
    await check('named URL proxy starts on loopback with the app', () => {
      assert.strictEqual(status.running, true);
      assert.ok(status.port > 0);
    });
    const proxyPort = status.port;

    const sug = await request(port, '/api/stacks/suggest', 'POST', { path: ROOT });
    await check('POST /api/stacks/suggest returns services with a start order', () => {
      assert.strictEqual(sug.status, 200);
      assert.strictEqual(sug.data.services.length, 3);
    });

    const loopRes = await request(port, '/api/stacks', 'POST', {
      name: 'Loop',
      services: [
        { name: 'a', path: DB_DIR, command: 'node svc.js a', startAfter: ['b'] },
        { name: 'b', path: API_DIR, command: 'node svc.js b', startAfter: ['a'] }
      ]
    });
    await check('a start-after loop is refused and nothing is saved', async () => {
      assert.strictEqual(loopRes.status, 400);
      assert.match(loopRes.data.error, /loop/);
      const list = await request(port, '/api/projects');
      assert.strictEqual(list.data.length, 0);
      const stacks = await request(port, '/api/stacks');
      assert.strictEqual(stacks.data.length, 0);
    });

    const created = await request(port, '/api/stacks', 'POST', {
      name: 'Shop',
      path: ROOT,
      services: [
        { name: 'web', path: WEB_DIR, command: 'node svc.js web', startAfter: ['api'] },
        { name: 'api', path: API_DIR, command: 'node svc.js api', startAfter: ['db'] },
        { name: 'db', path: DB_DIR, command: 'node svc.js db 900' },
        { name: 'worker', path: API_DIR, command: 'node svc.js worker', kind: 'worker', startAfter: ['db'] }
      ]
    });
    const stack = created.data.stack;
    const svc = Object.fromEntries(created.data.services.map((s) => [s.name, s]));
    await check('POST /api/stacks creates the stack, its services and web addresses', () => {
      assert.strictEqual(created.status, 201);
      assert.strictEqual(stack.hostname, 'shop');
      assert.strictEqual(stack.namedUrl, `http://shop.localhost:${proxyPort}`);
      assert.deepStrictEqual(
        stack.serviceIds.map((id) => created.data.services.find((s) => s.id === id).name),
        ['db', 'api', 'web', 'worker']
      );
      assert.strictEqual(stack.primaryServiceId, svc.web.id);
      assert.strictEqual(svc.api.hostname, 'api.shop');
      assert.strictEqual(svc.api.namedUrl, `http://api.shop.localhost:${proxyPort}`);
      assert.strictEqual(svc.worker.namedUrl, null, 'workers have no web address');
      assert.deepStrictEqual(svc.web.startAfter, [svc.api.id]);
    });

    await check('a stack may run two commands from one folder; stand-alone duplicates are still refused', async () => {
      const dupInStack = await request(port, '/api/projects', 'POST', { path: API_DIR, command: 'node svc.js api', stackId: stack.id });
      assert.strictEqual(dupInStack.status, 409);
      const standalone = await request(port, '/api/projects', 'POST', { path: API_DIR });
      assert.strictEqual(standalone.status, 201, 'a folder used by a stack can also be a stand-alone project');
      const again = await request(port, '/api/projects', 'POST', { path: API_DIR });
      assert.strictEqual(again.status, 409);
      assert.strictEqual((await request(port, `/api/projects/${standalone.data.id}`, 'DELETE')).status, 200);
    });

    const putStackEnv = await request(port, `/api/env/${stack.id}`, 'PUT', {
      profiles: { Dev: [{ key: 'SHARED', value: 'from-stack' }, { key: 'API_KEY', value: 'stack-level' }] }
    });
    const putApiEnv = await request(port, `/api/env/${svc.api.id}`, 'PUT', {
      activeProfile: 'Dev',
      profiles: {
        Dev: [
          { key: 'API_KEY', value: 'secret-dev-123' },
          { key: 'DB_URL', value: 'postgres://localhost:${PORTLY_DB_PORT}/shop' },
          { key: 'LITERAL', value: '$${PORT}' },
          { key: 'PORT', value: '1' }
        ],
        Test: [{ key: 'API_KEY', value: 'secret-test-456' }]
      }
    });
    await check('PUT /api/env saves profiles and the project list shows only counts', async () => {
      assert.strictEqual(putStackEnv.status, 200);
      assert.strictEqual(putApiEnv.status, 200);
      assert.deepStrictEqual(putApiEnv.data.envFiles, ['.env']);
      const list = await request(port, '/api/projects');
      const api = list.data.find((p) => p.id === svc.api.id);
      assert.deepStrictEqual(api.env, { activeProfile: 'Dev', profileNames: ['Dev', 'Test'], count: 4 });
      assert.ok(!JSON.stringify(list.data).includes('secret-dev-123'));
      const projectsFile = fs.readFileSync(path.join(DATA_ROOT, 'data', 'projects.json'), 'utf8');
      assert.ok(!projectsFile.includes('secret-dev-123'), 'values must not be in projects.json');
    });

    await check('POST /api/env/:id/import-file reads a known .env file and refuses other names', async () => {
      const ok = await request(port, `/api/env/${svc.api.id}/import-file`, 'POST', { file: '.env' });
      assert.strictEqual(ok.status, 200);
      assert.deepStrictEqual(ok.data.vars, [
        { key: 'API_KEY', value: 'from-dotenv' },
        { key: 'QUOTED', value: 'two words' },
        { key: 'MULTI', value: 'a\nb' }
      ]);
      const bad = await request(port, `/api/env/${svc.api.id}/import-file`, 'POST', { file: '../../etc/passwd' });
      assert.strictEqual(bad.status, 400);
    });

    const startRes = await request(port, `/api/stacks/${stack.id}/start`, 'POST', {});
    await check('starting a stack waits for each service before starting the ones after it', async () => {
      assert.strictEqual(startRes.status, 200, JSON.stringify(startRes.data));
      assert.strictEqual(startRes.data.ok, true, JSON.stringify(startRes.data.problems));
      const db = await waitFor(() => readOut(DB_DIR, 'db'));
      const api = await waitFor(() => readOut(API_DIR, 'api'));
      const web = await waitFor(() => readOut(WEB_DIR, 'web'));
      assert.strictEqual(api.dbUp, true, 'api must start only after db answers on its port');
      assert.ok(api.at >= db.at + 800, 'api started before db finished booting');
      assert.ok(web.at >= api.at);
    });

    await check('services get their env: stack, then own profile, ${} expanded, Portly ports win', () => {
      const api = readOut(API_DIR, 'api').env;
      const dbPort = readOut(DB_DIR, 'db').env.PORT;
      assert.strictEqual(api.SHARED, 'from-stack');
      assert.strictEqual(api.API_KEY, 'secret-dev-123', 'service value overrides the stack value');
      assert.strictEqual(api.PORTLY_DB_PORT, dbPort);
      assert.strictEqual(api.DB_URL, `postgres://localhost:${dbPort}/shop`);
      assert.strictEqual(api.LITERAL, '${PORT}');
      assert.notStrictEqual(api.PORT, '1', 'PORT is always the one Portly assigned');
      assert.strictEqual(api.PORTLY_STACK, 'Shop');
      assert.strictEqual(api.PORTLY_NAMED_URL, `http://api.shop.localhost:${proxyPort}`);
      const worker = readOut(API_DIR, 'worker').env;
      assert.strictEqual(worker.PORT, null, 'workers get no port');
      assert.strictEqual(worker.API_KEY, 'stack-level');
      const web = readOut(WEB_DIR, 'web').env;
      assert.strictEqual(web.API_KEY, 'stack-level');
      assert.strictEqual(web.DB_URL, null, 'one service\'s variables do not leak into another');
    });

    await check('env values never appear in the logs', async () => {
      const logs = await request(port, `/api/projects/${svc.api.id}/logs`);
      const text = JSON.stringify(logs.data);
      assert.ok(text.includes('environment variable'), 'expected a note about the variables');
      assert.ok(!text.includes('secret-dev-123'));
    });

    await check('stack status is running once every service is up', async () => {
      await waitFor(async () => (await request(port, `/api/stacks/${stack.id}`)).data.status === 'running');
    });

    await check('CLI and MCP can list and drive stacks', async () => {
      const { execFile } = require('node:child_process');
      const env = { ...process.env, PORTLY_URL: `http://127.0.0.1:${port}` };
      const out = await new Promise((resolve, reject) =>
        execFile(process.execPath, [path.join(__dirname, 'portly-cli.js'), 'stacks'], { env }, (err, stdout) =>
          err ? reject(err) : resolve(JSON.parse(stdout))
        )
      );
      assert.strictEqual(out[0].name, 'Shop');
      assert.deepStrictEqual(out[0].services.map((s) => s.name), ['db', 'api', 'web', 'worker']);
      assert.strictEqual(out[0].services[1].namedUrl, `http://api.shop.localhost:${proxyPort}`);
      const mcpList = await new Promise((resolve, reject) => {
        const child = require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'portly-mcp.js')], { env });
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d;
          if (buf.includes('\n')) {
            child.kill();
            resolve(JSON.parse(buf.split('\n')[0]));
          }
        });
        child.on('error', reject);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
      });
      const names = mcpList.result.tools.map((t) => t.name);
      for (const n of ['portly_list_stacks', 'portly_start_stack', 'portly_stop_stack']) assert.ok(names.includes(n), n);
    });

    await check('named URLs reach the right service and keep the original Host', async () => {
      const api = await request(proxyPort, '/', 'GET', undefined, { Host: `api.shop.localhost:${proxyPort}` });
      assert.strictEqual(api.status, 200);
      assert.match(api.text, /^api host=api\.shop\.localhost:\d+ xfh=api\.shop\.localhost/);
      const top = await request(proxyPort, '/', 'GET', undefined, { Host: `shop.localhost:${proxyPort}` });
      assert.match(top.text, /^web /, 'shop.localhost opens the stack\'s main web service');
    });

    await check('the proxy refuses other hosts, explains stopped apps, and never reaches Portly itself', async () => {
      const evil = await request(proxyPort, '/api/projects', 'GET', undefined, { Host: 'evil.example' });
      assert.strictEqual(evil.status, 400);
      const unknown = await request(proxyPort, '/', 'GET', undefined, { Host: `nope.localhost:${proxyPort}` });
      assert.strictEqual(unknown.status, 502);
      assert.match(unknown.text, /No project is called nope\.localhost/);
      const worker = await request(proxyPort, '/', 'GET', undefined, { Host: `worker.shop.localhost:${proxyPort}` });
      assert.strictEqual(worker.status, 502, 'workers are not served');
      // Try to point a project at Portly's own port: the proxy must refuse.
      const own = await request(port, '/api/projects', 'POST', { path: WEB_DIR, command: 'node svc.js own', customPort: port });
      assert.strictEqual(own.status, 201);
      const ownStart = await request(port, `/api/projects/${own.data.id}/start`, 'POST', {});
      assert.strictEqual(ownStart.status, 409, 'Portly refuses its own port as a custom port');
      await request(port, `/api/projects/${own.data.id}`, 'DELETE');
    });

    await check('WebSocket upgrades are forwarded (hot reload)', async () => {
      const reply = await new Promise((resolve, reject) => {
        const sock = net.connect(proxyPort, '127.0.0.1', () => {
          sock.write(`GET /hmr HTTP/1.1\r\nHost: api.shop.localhost:${proxyPort}\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n`);
        });
        let buf = '';
        sock.on('data', (d) => {
          buf += d.toString();
          if (buf.includes('\r\n\r\n') && !buf.includes('ping')) sock.write('ping');
          if (buf.includes('ping')) {
            sock.destroy();
            resolve(buf);
          }
        });
        sock.on('error', reject);
        setTimeout(() => reject(new Error('no upgrade reply')), 5000);
      });
      assert.match(reply, /^HTTP\/1\.1 101/);
    });

    await check('renaming a stack address moves its services too; clashes are refused', async () => {
      const renamed = await request(port, `/api/stacks/${stack.id}`, 'PUT', { hostname: 'store' });
      assert.strictEqual(renamed.status, 200);
      assert.strictEqual(renamed.data.hostname, 'store');
      const list = await request(port, '/api/projects');
      assert.strictEqual(list.data.find((p) => p.id === svc.api.id).hostname, 'api.store');
      const clash = await request(port, `/api/projects/${svc.web.id}`, 'PUT', { hostname: 'api.store' });
      assert.strictEqual(clash.status, 409);
      const loop = await request(port, `/api/projects/${svc.db.id}`, 'PUT', { startAfter: [svc.web.id] });
      assert.strictEqual(loop.status, 400);
      const after = await request(port, '/api/projects');
      assert.deepStrictEqual(after.data.find((p) => p.id === svc.db.id).startAfter, [], 'a refused edit changes nothing');
    });

    await check('switching profile changes what the next start gets', async () => {
      const sw = await request(port, `/api/env/${svc.api.id}/profile`, 'POST', { profile: 'Test' });
      assert.strictEqual(sw.status, 200);
      fs.rmSync(path.join(API_DIR, 'out-api.json'), { force: true });
      const r = await request(port, `/api/projects/${svc.api.id}/restart`, 'POST', {});
      assert.strictEqual(r.status, 200);
      const api = await waitFor(() => readOut(API_DIR, 'api'));
      assert.strictEqual(api.env.API_KEY, 'secret-test-456');
      assert.strictEqual(api.env.DB_URL, null);
    });

    const exported = await request(port, '/api/config/export', 'POST', { saveDialog: false });
    await check('config export carries stacks and start order but no env values', () => {
      assert.strictEqual(exported.status, 200);
      const cfg = exported.data.config;
      assert.strictEqual(cfg.stacks.length, 1);
      assert.strictEqual(cfg.stacks[0].hostname, 'store');
      const api = cfg.projects.find((p) => p.name === 'api');
      assert.strictEqual(api.stackId, stack.id);
      assert.deepStrictEqual(api.startAfter, [svc.db.id]);
      const text = JSON.stringify(cfg);
      assert.ok(!text.includes('secret-'), 'no env values in exports');
      if (exported.data.archivePath) fs.rmSync(exported.data.archivePath, { force: true });
    });

    const stopRes = await request(port, `/api/stacks/${stack.id}/stop`, 'POST', {});
    await check('stopping a stack stops every service', async () => {
      assert.strictEqual(stopRes.status, 200);
      assert.strictEqual(stopRes.data.status, 'stopped');
      const list = await request(port, '/api/projects');
      assert.ok(list.data.every((p) => p.status !== 'running'));
      const down = await request(proxyPort, '/', 'GET', undefined, { Host: `store.localhost:${proxyPort}` });
      assert.strictEqual(down.status, 502);
      assert.match(down.text, /Shop isn't running/);
    });

    await check('importing the exported config restores the stack and its links', async () => {
      const cfg = exported.data.config;
      const imp = await request(port, '/api/config/import', 'POST', { config: cfg, mode: 'replace', confirmCommands: true });
      assert.strictEqual(imp.status, 200, JSON.stringify(imp.data));
      assert.strictEqual(imp.data.stacks.length, 1);
      const stackAfter = imp.data.stacks[0];
      assert.strictEqual(stackAfter.hostname, 'store');
      const services = imp.data.projects.filter((p) => p.stackId === stackAfter.id);
      assert.strictEqual(services.length, 4);
      const byName = Object.fromEntries(services.map((s) => [s.name, s]));
      assert.deepStrictEqual(byName.web.startAfter, [byName.api.id]);
      assert.strictEqual(byName.worker.kind, 'worker');
      assert.strictEqual(byName.api.hostname, 'api.store');
    });

    await check('turning named URLs off stops the proxy; on brings it back', async () => {
      const off = await request(port, '/api/settings', 'PUT', { namedUrls: false });
      assert.strictEqual(off.status, 200);
      assert.strictEqual(off.data.namedUrlStatus.running, false);
      const list = await request(port, '/api/projects');
      assert.ok(list.data.every((p) => p.namedUrl === null));
      const on = await request(port, '/api/settings', 'PUT', { namedUrls: true });
      assert.strictEqual(on.data.namedUrlStatus.running, true);
      const bad = await request(port, '/api/settings', 'PUT', { proxyPort: 'abc' });
      assert.strictEqual(bad.status, 400);
    });

    await check('deleting a stack can keep its services as projects, or remove them with their env', async () => {
      const stacksNow = (await request(port, '/api/stacks')).data;
      const id = stacksNow[0].id;
      const apiId = (await request(port, '/api/projects')).data.find((p) => p.name === 'api' && p.stackId === id).id;
      await request(port, `/api/env/${apiId}`, 'PUT', { profiles: { Dev: [{ key: 'X', value: 'y' }] } });
      const kept = await request(port, `/api/stacks/${id}?keepServices=1`, 'DELETE');
      assert.strictEqual(kept.status, 200);
      const after = (await request(port, '/api/projects')).data;
      assert.strictEqual(after.length, 4);
      assert.ok(after.every((p) => !p.stackId && p.startAfter.length === 0));
      assert.strictEqual(after.find((p) => p.id === apiId).hostname, 'api');

      const again = await request(port, '/api/stacks', 'POST', {
        name: 'Temp',
        services: [{ name: 'one', path: DB_DIR, command: 'node svc.js one' }]
      });
      const tempSvc = again.data.services[0].id;
      await request(port, `/api/env/${tempSvc}`, 'PUT', { profiles: { Dev: [{ key: 'GONE', value: 'soon' }] } });
      const removed = await request(port, `/api/stacks/${again.data.stack.id}`, 'DELETE');
      assert.strictEqual(removed.status, 200);
      assert.strictEqual((await request(port, `/api/env/${tempSvc}`)).status, 404);
      const envFile = fs.readFileSync(path.join(DATA_ROOT, 'data', 'env-vars.json'), 'utf8');
      assert.ok(!envFile.includes(tempSvc), 'env entries of removed services are deleted');
    });
  } finally {
    await srv.stopAllProjects();
    await srv.stopNamedUrlProxy();
    await new Promise((resolve) => {
      started.server.close(() => resolve());
      if (typeof started.server.closeAllConnections === 'function') started.server.closeAllConnections();
    });
  }

  for (const line of results) console.log(line);
  console.log(`ALL_STACK_TESTS_PASSED (${results.length}/${results.length})`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(0);
}

run().catch((err) => {
  console.error('TEST_FAILED:', err);
  srv.cleanupAllRunningChildrenSync();
  process.exit(1);
});
