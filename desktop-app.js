'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

const ROOT_DIR = __dirname;
const DEFAULT_PORT = Number(process.env.PORT) || 4567;
const DEFAULT_URL = `http://localhost:${DEFAULT_PORT}`;
const PROFILE_DIR = path.join(ROOT_DIR, 'data', 'desktop-profile');

function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(350);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function waitForHttpReady(targetUrl, timeoutMs = 12000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`${targetUrl.replace(/\/+$/, '')}/api/system`, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 500) {
          resolve(true);
          return;
        }
        retry();
      });
      req.setTimeout(800, () => {
        req.destroy();
        retry();
      });
      req.on('error', retry);
    };

    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error(`Timed out waiting for Portly server at ${targetUrl}`));
        return;
      }
      setTimeout(attempt, 250);
    };

    attempt();
  });
}

function resolveOnPath(binaryName) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, [binaryName], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
      .toString('utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (out && fs.existsSync(out)) return out;
  } catch {
    // Not found on PATH
  }
  return null;
}

function findChromiumAppBinary(platformOverride = process.platform) {
  const candidates = [];

  if (platformOverride === 'win32') {
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
      'C:\\Program Files',
      'C:\\Program Files (x86)'
    ].filter(Boolean);

    const rels = [
      path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join('Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join('Chromium', 'Application', 'chrome.exe')
    ];

    for (const root of roots) {
      for (const rel of rels) {
        candidates.push(path.join(root, rel));
      }
    }

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    for (const exe of ['msedge.exe', 'chrome.exe', 'brave.exe']) {
      const resolved = resolveOnPath(exe);
      if (resolved) return resolved;
    }
    return null;
  }

  if (platformOverride === 'darwin') {
    const home = os.homedir();
    const macApps = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      path.join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      path.join(home, 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
      path.join(home, 'Applications/Chromium.app/Contents/MacOS/Chromium')
    ];
    for (const p of macApps) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  const linuxNames = [
    'google-chrome',
    'google-chrome-stable',
    'microsoft-edge',
    'microsoft-edge-stable',
    'chromium',
    'chromium-browser',
    'brave-browser'
  ];

  for (const name of linuxNames) {
    const resolved = resolveOnPath(name);
    if (resolved) return resolved;
  }

  const linuxFallbacks = [
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser'
  ];
  for (const p of linuxFallbacks) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function openDefaultBrowser(targetUrl) {
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', targetUrl], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return child;
  }

  if (process.platform === 'darwin') {
    const child = spawn('open', [targetUrl], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    return child;
  }

  const child = spawn('xdg-open', [targetUrl], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
  return child;
}

function launchAppWindow({ url = DEFAULT_URL, profileDir = PROFILE_DIR, detached = true } = {}) {
  const binary = findChromiumAppBinary();
  if (binary) {
    fs.mkdirSync(profileDir, { recursive: true });
    const args = [
      `--app=${url}`,
      '--window-size=1440,900',
      '--class=Portly',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check'
    ];
    const child = spawn(binary, args, {
      detached,
      stdio: 'ignore',
      windowsHide: false
    });
    if (detached) {
      child.unref();
    }
    return { mode: 'app-window', binary, url, child };
  }

  const child = openDefaultBrowser(url);
  return { mode: 'default-browser', binary: null, url, child };
}

function parseArgs(argv) {
  const flags = {
    check: false,
    windowOnly: false,
    url: DEFAULT_URL,
    port: DEFAULT_PORT
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check' || a === '--dry-run') {
      flags.check = true;
    } else if (a === '--window-only') {
      flags.windowOnly = true;
    } else if (a === '--url' && argv[i + 1]) {
      flags.url = argv[i + 1];
      i += 1;
    } else if (a === '--port' && argv[i + 1]) {
      flags.port = Number(argv[i + 1]) || DEFAULT_PORT;
      flags.url = `http://localhost:${flags.port}`;
      i += 1;
    }
  }
  return flags;
}

function notifyExistingServerInstance(port) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ action: 'focus', reason: 'second-instance' });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/window-control',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 2500
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.write(payload);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const binary = findChromiumAppBinary();

  if (args.check) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          platform: process.platform,
          arch: os.arch(),
          url: args.url,
          binary,
          mode: binary ? 'app-window' : 'default-browser'
        },
        null,
        2
      )
    );
    return;
  }

  if (args.windowOnly) {
    const result = launchAppWindow({ url: args.url, detached: true });
    console.log(
      `Opened Portly window (${result.mode}${result.binary ? `: ${result.binary}` : ''}) at ${result.url}`
    );
    return;
  }

  let startedInProcess = false;
  let serverModule = null;
  const alreadyListening =
    (await isPortOpen(args.port, '127.0.0.1')) || (await isPortOpen(args.port, '::1'));

  if (!alreadyListening) {
    serverModule = require('./server');
    await serverModule.startServer(args.port);
    startedInProcess = true;
  }

  await waitForHttpReady(args.url, 12000);
  if (alreadyListening) {
    const focusRes = await notifyExistingServerInstance(args.port);
    if (focusRes && focusRes.frameless && focusRes.handledSingleInstance && !focusRes.allowMultipleInstances) {
      console.log(
        `Portly is already running — activated existing window (${focusRes.restoredFrom || 'desktop'}).`
      );
      return;
    }
    if (focusRes && !focusRes.allowMultipleInstances) {
      console.log('Portly is already running — only 1 instance is allowed at a time.');
      return;
    }
    if (focusRes && focusRes.allowMultipleInstances) {
      const multiLaunch = launchAppWindow({
        url: args.url,
        profileDir: path.join(ROOT_DIR, 'data', `desktop-profile-multi-${Date.now()}`),
        detached: true
      });
      console.log(`Opened additional Portly instance (${multiLaunch.mode}) at ${multiLaunch.url}`);
      return;
    }
  }

  const launchedAt = Date.now();
  const launch = launchAppWindow({
    url: args.url,
    detached: !startedInProcess
  });

  console.log(
    `Portly Desktop ready at ${launch.url} (${launch.mode}${launch.binary ? ` via ${path.basename(launch.binary)}` : ''})`
  );

  // If we own the server and opened a dedicated Chromium --app process that stays attached,
  // clean up managed dev servers if the user explicitly closes the desktop window.
  if (startedInProcess && launch.child && launch.mode === 'app-window') {
    launch.child.on('exit', async () => {
      const aliveMs = Date.now() - launchedAt;
      if (aliveMs > 2500) {
        console.log('Portly Desktop window closed. Shutting down server...');
        try {
          await serverModule.stopAllProjects();
        } catch {
          // Ignore shutdown errors
        }
        serverModule.cleanupAllRunningChildrenSync();
        process.exit(0);
      }
    });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Portly Desktop error: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  findChromiumAppBinary,
  launchAppWindow,
  openDefaultBrowser,
  waitForHttpReady
};
