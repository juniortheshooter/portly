'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = __dirname;

function requestJson(baseUrl, pathname, method = 'GET', bodyObj = null) {
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = http.request(
      `${baseUrl}${pathname}`,
      {
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload)
            }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode, data: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestRaw(baseUrl, pathname, method, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { method, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  const results = [];
  const check = (name, fn) => {
    fn();
    results.push(`PASS: ${name}`);
  };
  const checkAsync = async (name, fn) => {
    await fn();
    results.push(`PASS: ${name}`);
  };

  // 1. JavaScript syntax checks across all modules
  const jsFiles = [
    'server.js',
    'desktop-app.js',
    'electron-main.js',
    'install-app.js',
    'static-server.js',
    'portly-client.js',
    'portly-mcp.js',
    'portly-cli.js',
    path.join('public', 'app.js')
  ];
  check('Syntax checks (node --check)', () => {
    for (const rel of jsFiles) {
      execFileSync(process.execPath, ['--check', path.join(ROOT_DIR, rel)], {
        stdio: 'pipe'
      });
    }
  });

  // 2. Module helpers & multi-OS path normalization
  const srv = require('./server');
  check('getSystemInfo() metadata', () => {
    const info = srv.getSystemInfo();
    assert.strictEqual(info.platform, process.platform);
    assert.strictEqual(info.arch, os.arch());
    assert.ok(['Windows', 'macOS', 'Linux', process.platform].includes(info.osName));
    assert.ok(['Explorer', 'Finder', 'File Manager'].includes(info.fileManagerLabel));
    assert.ok(info.shellName.length > 0);
  });

  check('cleanPathInput() expands tilde and trims quotes', () => {
    assert.strictEqual(srv.cleanPathInput('~'), os.homedir());
    assert.strictEqual(
      srv.cleanPathInput('"~/projects/demo"'),
      path.join(os.homedir(), 'projects', 'demo')
    );
    if (process.platform === 'win32') {
      // Backslash separators are only path separators on Windows.
      assert.strictEqual(
        srv.cleanPathInput("'~\\sites\\app'"),
        path.join(os.homedir(), 'sites', 'app')
      );
    }
  });

  check('normalizePathKey() removes trailing separators & handles OS case rules', () => {
    const p1 = path.join(ROOT_DIR, 'public') + path.sep;
    const p2 = path.join(ROOT_DIR, 'public');
    assert.strictEqual(srv.normalizePathKey(p1), srv.normalizePathKey(p2));
  });

  check('buildEffectiveCommand() handles cross-platform Python & Vite ports', () => {
    assert.strictEqual(
      srv.buildEffectiveCommand({ framework: 'Vite', command: 'npm run dev' }, 5180),
      'npm run dev -- --port 5180'
    );
    assert.strictEqual(
      srv.buildEffectiveCommand({ framework: 'Django', command: 'python3 manage.py runserver' }, 8012),
      'python3 manage.py runserver 8012'
    );
    assert.strictEqual(
      srv.buildEffectiveCommand({ framework: 'Django', command: 'python manage.py runserver' }, 8013),
      'python manage.py runserver 8013'
    );
  });

  // 3. desktop-app.js --check
  check('desktop-app.js --check reports valid OS and launcher mode', () => {
    const raw = execFileSync(process.execPath, [path.join(ROOT_DIR, 'desktop-app.js'), '--check'], {
      stdio: ['ignore', 'pipe', 'pipe']
    }).toString('utf8');
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.platform, process.platform);
    assert.ok(parsed.url.startsWith('http://localhost:'));
    assert.ok(['app-window', 'default-browser'].includes(parsed.mode));
  });

  // 4. install-app.js cross-platform launchers & LF line endings
  await checkAsync('install-app.js generates Windows, macOS, and Linux launchers', async () => {
    const { installDesktopApp } = require('./install-app');
    // Generate into a temp folder so the test never rewrites the launchers in the repo.
    const launcherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-launchers-'));
    const res = await installDesktopApp({ rootDir: launcherDir, installToUserMenu: false });
    assert.strictEqual(res.ok, true);

    const expectedFiles = [
      'Start-Portly-App.bat',
      'Portly-Desktop.vbs',
      'Start-Portly.command',
      'start-portly.sh',
      path.join('Portly.app', 'Contents', 'Info.plist'),
      path.join('Portly.app', 'Contents', 'MacOS', 'Portly'),
      'Portly.desktop'
    ];
    if (process.platform === 'win32') {
      expectedFiles.push('Portly.lnk');
    }

    for (const rel of expectedFiles) {
      const full = path.join(launcherDir, rel);
      assert.ok(fs.existsSync(full), `Missing expected launcher: ${rel}`);
    }

    // Verify POSIX scripts and macOS bundle use Unix LF line endings (no CRLF)
    const unixFiles = [
      'Start-Portly.command',
      'start-portly.sh',
      path.join('Portly.app', 'Contents', 'Info.plist'),
      path.join('Portly.app', 'Contents', 'MacOS', 'Portly'),
      'Portly.desktop'
    ];
    for (const rel of unixFiles) {
      const content = fs.readFileSync(path.join(launcherDir, rel), 'utf8');
      assert.strictEqual(content.includes('\r\n'), false, `Unexpected CRLF in ${rel}`);
      assert.strictEqual(content.includes(launcherDir), false, `Launcher ${rel} must not embed an absolute path`);
    }
    fs.rmSync(launcherDir, { recursive: true, force: true });
  });

  // 5. Universal web language & framework detection via temp fixtures
  check('inspectProjectPath() recognizes JS/Bun, Deno, Python, Go, Rust, PHP, Ruby, Java, .NET, Elixir, Flutter, Docker & Static HTML', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-langs-'));
    try {
      const makeFixture = (folder, files) => {
        const dir = path.join(tmpRoot, folder);
        fs.mkdirSync(dir, { recursive: true });
        for (const [rel, content] of Object.entries(files)) {
          const full = path.join(dir, rel);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, content, 'utf8');
        }
        return srv.inspectProjectPath(dir);
      };

      const bunVite = makeFixture('bun-vite', {
        'bun.lockb': '',
        'package.json': JSON.stringify({
          name: 'bun-vite-app',
          scripts: { dev: 'vite' },
          devDependencies: { vite: '^5.0.0' }
        })
      });
      assert.strictEqual(bunVite.valid, true);
      assert.ok(/Vite/i.test(bunVite.framework));
      assert.ok(bunVite.recommendedCommand.startsWith('bun'));

      const denoFresh = makeFixture('deno-fresh', {
        'deno.json': JSON.stringify({
          tasks: { start: 'deno run -A --watch=static/,routes/ dev.ts' },
          imports: { '$fresh/': 'https://deno.land/x/fresh@1.6.8/' }
        })
      });
      assert.strictEqual(denoFresh.valid, true);
      assert.ok(/Deno/i.test(denoFresh.language) || /Fresh/i.test(denoFresh.framework));
      assert.ok(denoFresh.recommendedCommand.includes('deno'));

      const fastapi = makeFixture('py-fastapi', {
        'requirements.txt': 'fastapi\nuvicorn\n',
        'main.py': 'from fastapi import FastAPI\napp = FastAPI()\n'
      });
      assert.strictEqual(fastapi.valid, true);
      assert.strictEqual(fastapi.language, 'Python');
      assert.ok(/FastAPI/i.test(fastapi.framework));
      assert.ok(fastapi.recommendedCommand.includes('uvicorn'));

      const django = makeFixture('py-django', {
        'requirements.txt': 'django>=5.0\n',
        'manage.py': '#!/usr/bin/env python\n'
      });
      assert.strictEqual(django.valid, true);
      assert.strictEqual(django.framework, 'Django');
      assert.ok(django.recommendedCommand.includes('manage.py runserver'));

      const goGin = makeFixture('go-gin', {
        'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n',
        'main.go': 'package main\nfunc main() {}\n'
      });
      assert.strictEqual(goGin.valid, true);
      assert.strictEqual(goGin.language, 'Go');
      assert.ok(/Gin/i.test(goGin.framework));
      assert.ok(goGin.recommendedCommand.includes('go run'));

      const hugo = makeFixture('go-hugo', {
        'hugo.toml': 'baseURL = "http://example.org/"\ntitle = "Docs"\n'
      });
      assert.strictEqual(hugo.valid, true);
      assert.ok(/Hugo/i.test(hugo.framework));
      assert.ok(hugo.recommendedCommand.includes('hugo server'));

      const rustAxum = makeFixture('rust-axum', {
        'Cargo.toml': '[package]\nname = "web-api"\nversion = "0.1.0"\n[dependencies]\naxum = "0.7"\n'
      });
      assert.strictEqual(rustAxum.valid, true);
      assert.strictEqual(rustAxum.language, 'Rust');
      assert.ok(/Axum/i.test(rustAxum.framework));
      assert.ok(rustAxum.recommendedCommand.includes('cargo run'));

      const rustTrunk = makeFixture('rust-trunk', {
        'Cargo.toml': '[package]\nname = "leptos-ui"\n[dependencies]\nleptos = "0.6"\n',
        'Trunk.toml': '[serve]\nport = 8080\n'
      });
      assert.strictEqual(rustTrunk.valid, true);
      assert.ok(rustTrunk.recommendedCommand.includes('trunk serve'));

      const laravel = makeFixture('php-laravel', {
        'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
        artisan: '#!/usr/bin/env php\n'
      });
      assert.strictEqual(laravel.valid, true);
      assert.strictEqual(laravel.language, 'PHP');
      assert.strictEqual(laravel.framework, 'Laravel');
      assert.ok(laravel.recommendedCommand.includes('artisan serve'));

      const rails = makeFixture('ruby-rails', {
        Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n",
        'config.ru': 'run Rails.application\n'
      });
      assert.strictEqual(rails.valid, true);
      assert.strictEqual(rails.language, 'Ruby');
      assert.ok(/Rails/i.test(rails.framework));
      assert.ok(rails.recommendedCommand.includes('rails server'));

      const spring = makeFixture('java-spring', {
        'pom.xml': '<project><dependencies><dependency><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>'
      });
      assert.strictEqual(spring.valid, true);
      assert.ok(/Java|Kotlin/i.test(spring.language));
      assert.ok(/Spring Boot/i.test(spring.framework));

      const dotnet = makeFixture('dotnet-web', {
        'WebPortal.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>'
      });
      assert.strictEqual(dotnet.valid, true);
      assert.ok(/\.NET|C#/i.test(dotnet.language));
      assert.ok(/ASP\.NET/i.test(dotnet.framework));
      assert.ok(dotnet.recommendedCommand.includes('dotnet'));

      const phoenix = makeFixture('elixir-phoenix', {
        'mix.exs': 'defmodule MyApp.MixProject do\n  defp deps, do: [{:phoenix, "~> 1.7"}]\nend\n'
      });
      assert.strictEqual(phoenix.valid, true);
      assert.strictEqual(phoenix.language, 'Elixir');
      assert.ok(/Phoenix/i.test(phoenix.framework));
      assert.ok(phoenix.recommendedCommand.includes('mix phx.server'));

      const flutter = makeFixture('dart-flutter', {
        'pubspec.yaml': 'name: my_flutter_web\ndependencies:\n  flutter:\n    sdk: flutter\n',
        'web/index.html': '<!doctype html><html></html>'
      });
      assert.strictEqual(flutter.valid, true);
      assert.ok(/Dart/i.test(flutter.language));
      assert.ok(/Flutter/i.test(flutter.framework));
      assert.ok(flutter.recommendedCommand.includes('flutter run'));

      const docker = makeFixture('docker-app', {
        'docker-compose.yml': 'services:\n  web:\n    image: nginx:alpine\n'
      });
      assert.strictEqual(docker.valid, true);
      assert.ok(/Docker/i.test(docker.framework) || /Docker/i.test(docker.language));
      assert.ok(docker.recommendedCommand.includes('docker compose'));

      const altHtml = makeFixture('static-home', {
        'home.html': '<!doctype html><html><body>Hello</body></html>'
      });
      assert.strictEqual(altHtml.valid, true);
      assert.ok(altHtml.recommendedCommand.includes('static-server.js'));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // 6. Ephemeral live HTTP API verification + settings reset / onboarding round-trip
  await checkAsync('Live HTTP endpoints (/api/system, /api/settings, /api/settings/reset, /api/projects, /api/inspect, cross-site guard)', async () => {
    const started = await srv.startServer(0);
    try {
      const sysRes = await requestJson(started.url, '/api/system');
      assert.strictEqual(sysRes.status, 200);
      assert.strictEqual(sysRes.data.platform, process.platform);
      assert.ok(typeof sysRes.data.osVersion === 'string' && sysRes.data.osVersion.length > 0);

      let lastWindowAction = null;
      srv.setCustomWindowController(async (action) => {
        lastWindowAction = action;
        return { maximized: action === 'maximize' };
      });
      try {
        const winRes = await requestJson(started.url, '/api/window-control', 'POST', { action: 'maximize' });
        assert.strictEqual(winRes.status, 200);
        assert.strictEqual(winRes.data.frameless, true);
        assert.strictEqual(winRes.data.maximized, true);
        assert.strictEqual(lastWindowAction, 'maximize');

        const trayRes = await requestJson(started.url, '/api/window-control', 'POST', { action: 'tray' });
        assert.strictEqual(trayRes.status, 200);
        assert.strictEqual(trayRes.data.frameless, true);
        assert.strictEqual(lastWindowAction, 'tray');

        const closeRes = await requestJson(started.url, '/api/window-control', 'POST', { action: 'close' });
        assert.strictEqual(closeRes.status, 200);
        assert.strictEqual(closeRes.data.frameless, true);
        assert.strictEqual(lastWindowAction, 'close');
      } finally {
        srv.setCustomWindowController(null);
      }

      const resetRes1 = await requestJson(started.url, '/api/settings/reset', 'POST', {});
      assert.strictEqual(resetRes1.status, 200);
      assert.strictEqual(resetRes1.data.userName, '');
      assert.strictEqual(resetRes1.data.allowMultipleInstances, false);
      assert.strictEqual(resetRes1.data.exitClosesCompletely, false);
      assert.strictEqual(resetRes1.data.onboarded, false);

      const focusSingleRes = await requestJson(started.url, '/api/window-control', 'POST', {
        action: 'focus',
        reason: 'second-instance'
      });
      assert.strictEqual(focusSingleRes.status, 200);
      assert.strictEqual(focusSingleRes.data.handledSingleInstance, true);
      assert.strictEqual(focusSingleRes.data.allowMultipleInstances, false);

      const closeTrayRes = await requestJson(started.url, '/api/window-control', 'POST', {
        action: 'close'
      });
      assert.strictEqual(closeTrayRes.status, 200);
      assert.strictEqual(closeTrayRes.data.quitting, false);
      assert.strictEqual(closeTrayRes.data.hiddenToTray, true);

      const putRes = await requestJson(started.url, '/api/settings', 'PUT', {
        userName: 'Alex',
        theme: 'dark',
        defaultExpanded: true,
        allowMultipleInstances: true,
        exitClosesCompletely: true,
        onboarded: true
      });
      assert.strictEqual(putRes.status, 200);
      assert.strictEqual(putRes.data.userName, 'Alex');
      assert.strictEqual(putRes.data.theme, 'dark');
      assert.strictEqual(putRes.data.defaultExpanded, true);
      assert.strictEqual(putRes.data.allowMultipleInstances, true);
      assert.strictEqual(putRes.data.exitClosesCompletely, true);
      assert.strictEqual(putRes.data.onboarded, true);

      const closeQuitRes = await requestJson(started.url, '/api/window-control', 'POST', {
        action: 'close'
      });
      assert.strictEqual(closeQuitRes.status, 200);
      assert.strictEqual(closeQuitRes.data.quitting, true);
      assert.strictEqual(closeQuitRes.data.hiddenToTray, false);

      const settingsRes = await requestJson(started.url, '/api/settings');
      assert.strictEqual(settingsRes.status, 200);
      assert.strictEqual(settingsRes.data.userName, 'Alex');
      assert.strictEqual(settingsRes.data.allowMultipleInstances, true);
      assert.strictEqual(settingsRes.data.exitClosesCompletely, true);
      assert.strictEqual(settingsRes.data.onboarded, true);

      const resetRes2 = await requestJson(started.url, '/api/settings/reset', 'POST', {});
      assert.strictEqual(resetRes2.status, 200);
      assert.strictEqual(resetRes2.data.userName, '');
      assert.strictEqual(resetRes2.data.onboarded, false);

      const inspectSelf = await requestJson(started.url, '/api/inspect', 'POST', { path: ROOT_DIR });
      assert.strictEqual(inspectSelf.status, 200);
      assert.strictEqual(inspectSelf.data.valid, true);

      const projectsRes = await requestJson(started.url, '/api/projects');
      assert.strictEqual(projectsRes.status, 200);
      assert.ok(Array.isArray(projectsRes.data));

      // Cross-site and DNS-rebinding requests must be refused.
      const evilOrigin = await requestRaw(started.url, '/api/projects', 'POST', { Origin: 'https://evil.example' });
      assert.strictEqual(evilOrigin, 403);
      const evilHost = await requestRaw(started.url, '/api/projects', 'GET', { Host: 'evil.example:4567' });
      assert.strictEqual(evilHost, 403);
      const crossSite = await requestRaw(started.url, '/api/projects', 'GET', { 'Sec-Fetch-Site': 'cross-site' });
      assert.strictEqual(crossSite, 403);
      const sameOrigin = await requestRaw(started.url, '/api/projects', 'GET', { Origin: started.url.replace('localhost', '127.0.0.1') });
      assert.strictEqual(sameOrigin, 200);

      srv.setCustomFolderPicker(async () => ({ path: ROOT_DIR }));
      try {
        const pickRes = await requestJson(started.url, '/api/pick-folder', 'POST', {});
        assert.strictEqual(pickRes.status, 200);
        assert.strictEqual(pickRes.data.path, ROOT_DIR);
      } finally {
        srv.setCustomFolderPicker(null);
      }

      // Crash report export (POST direct, custom saver hook, and GET plain-text attachment)
      const tempCrashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-crash-test-'));
      const cleanupFiles = [];
      try {
        const postDirect = await requestJson(started.url, '/api/crash-reports/export', 'POST', { saveDialog: false });
        assert.strictEqual(postDirect.status, 200);
        assert.strictEqual(postDirect.data.ok, true);
        assert.strictEqual(postDirect.data.dialogUsed, false);
        assert.ok(fs.existsSync(postDirect.data.savedPath), 'Expected archive crash report file on disk');
        cleanupFiles.push(postDirect.data.savedPath);
        assert.ok(postDirect.data.content.includes('PORTLY — LOCAL CRASH & DIAGNOSTIC REPORT'));
        assert.ok(postDirect.data.content.includes(process.version));

        const targetCustomPath = path.join(tempCrashDir, 'custom-crash.log');
        srv.setCustomCrashReportSaver(async ({ defaultFileName }) => {
          assert.ok(defaultFileName.startsWith('portly-crash-report-'));
          return { filePath: targetCustomPath, canceled: false };
        });
        const postCustom = await requestJson(started.url, '/api/crash-reports/export', 'POST', {});
        assert.strictEqual(postCustom.status, 200);
        assert.strictEqual(postCustom.data.dialogUsed, true);
        assert.strictEqual(postCustom.data.canceled, false);
        assert.strictEqual(postCustom.data.savedPath, targetCustomPath);
        assert.ok(fs.existsSync(targetCustomPath), 'Expected custom saver crash report file on disk');
        assert.ok(fs.readFileSync(targetCustomPath, 'utf8').includes('PORTLY — LOCAL CRASH & DIAGNOSTIC REPORT'));
        if (postCustom.data.archivePath) cleanupFiles.push(postCustom.data.archivePath);

        const getRes = await requestJson(started.url, '/api/crash-reports/export');
        assert.strictEqual(getRes.status, 200);
        assert.ok(typeof getRes.data === 'string' && getRes.data.includes('PORTLY — LOCAL CRASH & DIAGNOSTIC REPORT'));
      } finally {
        srv.setCustomCrashReportSaver(null);
        for (const f of cleanupFiles) {
          fs.rmSync(f, { force: true });
        }
        fs.rmSync(tempCrashDir, { recursive: true, force: true });
      }

      // Environment config export/import (saveDialog: false, custom saver hook, GET download, and restore)
      const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-config-test-'));
      const configCleanupFiles = [];
      let baselineConfig = null;
      try {
        const baselineExport = await requestJson(started.url, '/api/config/export', 'POST', { saveDialog: false });
        assert.strictEqual(baselineExport.status, 200);
        assert.strictEqual(baselineExport.data.ok, true);
        baselineConfig = baselineExport.data.config;
        if (baselineExport.data.archivePath) configCleanupFiles.push(baselineExport.data.archivePath);

        const postConfigDirect = await requestJson(started.url, '/api/config/export', 'POST', {
          saveDialog: false,
          layout: {
            splitRatio: 67.5,
            overviewPosition: 'bottom',
            overviewScale: 0.85,
            splitDirection: 'vertical',
            overviewMode: 'compact',
            viewMode: 'cards'
          }
        });
        assert.strictEqual(postConfigDirect.status, 200);
        assert.strictEqual(postConfigDirect.data.ok, true);
        assert.strictEqual(postConfigDirect.data.dialogUsed, false);
        assert.ok(fs.existsSync(postConfigDirect.data.savedPath), 'Expected archive config file on disk');
        configCleanupFiles.push(postConfigDirect.data.savedPath);
        assert.strictEqual(postConfigDirect.data.config.layout.splitRatio, 67.5);
        assert.strictEqual(postConfigDirect.data.config.layout.overviewPosition, 'bottom');
        assert.strictEqual(postConfigDirect.data.config.layout.splitDirection, 'vertical');

        const targetCustomConfigPath = path.join(tempConfigDir, 'custom-portly-config.json');
        srv.setCustomConfigSaver(async ({ defaultFileName }) => {
          assert.ok(defaultFileName.startsWith('portly-config-') && defaultFileName.endsWith('.json'));
          return { filePath: targetCustomConfigPath, canceled: false };
        });
        const postConfigCustom = await requestJson(started.url, '/api/config/export', 'POST', {});
        assert.strictEqual(postConfigCustom.status, 200);
        assert.strictEqual(postConfigCustom.data.dialogUsed, true);
        assert.strictEqual(postConfigCustom.data.canceled, false);
        assert.strictEqual(postConfigCustom.data.savedPath, targetCustomConfigPath);
        assert.ok(fs.existsSync(targetCustomConfigPath), 'Expected custom saver config file on disk');
        if (postConfigCustom.data.archivePath) configCleanupFiles.push(postConfigCustom.data.archivePath);

        const getConfigRes = await requestJson(started.url, '/api/config/export');
        assert.strictEqual(getConfigRes.status, 200);
        assert.strictEqual(getConfigRes.data.app, 'Portly');
        assert.ok(Array.isArray(getConfigRes.data.projects));

        const missingDummyPath = path.join(tempConfigDir, 'does-not-exist-project');
        const importPayload = {
          config: {
            app: 'Portly',
            schemaVersion: 1,
            settings: {
              userName: 'RestoredGabe',
              theme: 'dark',
              defaultExpanded: true,
              allowMultipleInstances: true,
              exitClosesCompletely: true,
              onboarded: true
            },
            layout: {
              overviewMode: 'compact',
              overviewPosition: 'bottom',
              overviewScale: 0.9,
              splitDirection: 'vertical',
              splitRatio: 72.5,
              paneFocus: 'split',
              viewMode: 'cards'
            },
            projects: [
              {
                name: 'portly-self-test',
                path: ROOT_DIR,
                command: 'node server.js',
                customPort: '4567'
              },
              {
                name: 'missing-path-test',
                path: missingDummyPath,
                command: 'npm run dev'
              }
            ]
          },
          mode: 'replace'
        };
        // Imported configs are untrusted: new or changed start commands need explicit confirmation.
        const unconfirmedRes = await requestJson(started.url, '/api/config/import', 'POST', importPayload);
        assert.strictEqual(unconfirmedRes.status, 409);
        assert.strictEqual(unconfirmedRes.data.needsConfirmation, true);
        assert.ok(
          unconfirmedRes.data.commandChanges.some((c) => c.to === 'node server.js'),
          'Expected the review list to include the imported command'
        );
        importPayload.confirmCommands = true;
        const importRes = await requestJson(started.url, '/api/config/import', 'POST', importPayload);
        assert.strictEqual(importRes.status, 200);
        assert.strictEqual(importRes.data.ok, true);
        assert.strictEqual(importRes.data.settings.userName, 'RestoredGabe');
        assert.strictEqual(importRes.data.settings.theme, 'dark');
        assert.strictEqual(importRes.data.settings.allowMultipleInstances, true);
        assert.strictEqual(importRes.data.settings.exitClosesCompletely, true);
        assert.strictEqual(importRes.data.settings.onboarded, true);

        const roundtripExport = await requestJson(started.url, '/api/config/export', 'POST', { saveDialog: false });
        assert.strictEqual(roundtripExport.status, 200);
        assert.strictEqual(roundtripExport.data.config.settings.allowMultipleInstances, true);
        assert.strictEqual(roundtripExport.data.config.settings.exitClosesCompletely, true);
        if (roundtripExport.data.archivePath) configCleanupFiles.push(roundtripExport.data.archivePath);
        assert.strictEqual(importRes.data.layout.splitRatio, 72.5);
        assert.strictEqual(importRes.data.layout.overviewPosition, 'bottom');
        assert.strictEqual(importRes.data.layout.overviewScale, 0.9);
        assert.strictEqual(importRes.data.layout.splitDirection, 'vertical');
        assert.strictEqual(importRes.data.importedProjectsCount, 1);
        assert.strictEqual(importRes.data.skippedMissingPaths.length, 1);
        assert.ok(Array.isArray(importRes.data.brokenProjects), 'Expected brokenProjects array');
        assert.strictEqual(importRes.data.brokenProjects.length, 1);
        assert.strictEqual(importRes.data.brokenProjects[0].name, 'missing-path-test');
        assert.strictEqual(importRes.data.brokenProjects[0].brokenPath, missingDummyPath);
        assert.strictEqual(importRes.data.brokenProjects[0].command, 'npm run dev');
        assert.strictEqual(importRes.data.projects.length, 1);
        assert.strictEqual(importRes.data.projects[0].name, 'portly-self-test');
        assert.strictEqual(importRes.data.projects[0].command, 'node server.js');
      } finally {
        srv.setCustomConfigSaver(null);
        if (baselineConfig) {
          await requestJson(started.url, '/api/config/import', 'POST', { config: baselineConfig, mode: 'replace', confirmCommands: true });
        }
        await requestJson(started.url, '/api/settings/reset', 'POST', {});
        for (const f of configCleanupFiles) {
          fs.rmSync(f, { force: true });
        }
        fs.rmSync(tempConfigDir, { recursive: true, force: true });
      }
    } finally {
      await new Promise((resolve) => started.server.close(resolve));
    }
  });

  // 7. Native Windows expanded File Explorer COM picker (IFileOpenDialog) compilation check
  check('getWindowsModernPickerScript() compiles IFileOpenDialog COM wrapper on Windows', () => {
    const script = srv.getWindowsModernPickerScript();
    assert.ok(script.includes('IFileOpenDialog'), 'Expected IFileOpenDialog COM interface');
    assert.ok(script.includes('0x00000020'), 'Expected FOS_PICKFOLDERS flag');
    if (process.platform === 'win32') {
      const match = script.match(/\$code = @'\r?\n([\s\S]*?)\r?\n'@/);
      assert.ok(match && match[1], 'Expected C# type definition block in picker script');
      const testScript = [
        `$code = @'`,
        match[1],
        `'@`,
        `Add-Type -TypeDefinition $code -Language CSharp`,
        `$dlg = [ModernFolderPicker]::CreateConfigured()`,
        `if ($dlg -ne $null) { Write-Output 'MODERN_PICKER_COMPILED' }`
      ].join('\n');
      const encoded = Buffer.from(testScript, 'utf16le').toString('base64');
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Sta', '-EncodedCommand', encoded],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
        .toString('utf8')
        .trim();
      assert.ok(out.includes('MODERN_PICKER_COMPILED'), `Unexpected output: ${out}`);
    }
  });

  // 8. Windows PATH / Path casing merge + System32 preservation when localbins exist
  check('buildCrossPlatformEnv() preserves Windows System32 and merges Path/PATH case-insensitively', () => {
    assert.strictEqual(typeof srv.buildCrossPlatformEnv, 'function', 'buildCrossPlatformEnv must be exported');
    // Use a throwaway project folder that has node_modules/.bin, so the check does not
    // depend on whether `npm install` has run in the Portly folder itself (CI skips it).
    const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-env-'));
    fs.mkdirSync(path.join(fixtureDir, 'node_modules', '.bin'), { recursive: true });
    const env = srv.buildCrossPlatformEnv(4999, fixtureDir);
    assert.strictEqual(env.PORT, '4999');
    if (process.platform === 'win32') {
      const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
      assert.strictEqual(pathKeys.length, 1, `Expected single merged PATH key, found: ${pathKeys.join(',')}`);
      const pathEntries = String(env[pathKeys[0]] || '').split(';').filter(Boolean);
      const normalized = pathEntries.map((p) => p.toLowerCase());
      assert.ok(
        normalized.some((p) => p.includes('\\system32')),
        `Expected Windows System32 in merged Path/PATH, got: ${pathEntries.slice(0, 8).join(';')}`
      );
      const localBin = path.join(fixtureDir, 'node_modules', '.bin').toLowerCase();
      assert.ok(normalized.includes(localBin), `Expected local node_modules/.bin in PATH: ${localBin}`);
    }
  });

  // 9. buildCrashReport() standalone formatter check
  check('buildCrashReport() includes system & project diagnostic sections', () => {
    assert.strictEqual(typeof srv.buildCrashReport, 'function', 'buildCrashReport must be exported');
    const report = srv.buildCrashReport(null);
    assert.ok(report.fileName.startsWith('portly-crash-report-') && report.fileName.endsWith('.log'));
    assert.ok(report.content.includes('PORTLY — LOCAL CRASH & DIAGNOSTIC REPORT'));
    assert.ok(Array.isArray(report.includedProjects));
  });

  // 9b. AI agent integration: MCP server (stdio) + CLI drive a live Portly
  await checkAsync('MCP server and CLI can add, start, read logs from and stop a project', async () => {
    const { spawn, execFile } = require('node:child_process');
    const runCli = (args) =>
      new Promise((resolve, reject) =>
        execFile(process.execPath, [path.join(ROOT_DIR, 'portly-cli.js'), ...args], { env, encoding: 'utf8' }, (err, out) =>
          err ? reject(err) : resolve(out)
        )
      );
    const started = await srv.startServer(0);
    const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-mcp-site-'));
    fs.writeFileSync(path.join(siteDir, 'index.html'), '<h1>hello from portly test</h1>', 'utf8');
    const env = { ...process.env, PORTLY_URL: started.url.replace('localhost', '127.0.0.1') };

    const child = spawn(process.execPath, [path.join(ROOT_DIR, 'portly-mcp.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map();
    let buffer = '';
    let strayOutput = false;
    child.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          strayOutput = true; // stdout must only carry protocol messages
          continue;
        }
        if (pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });
    let nextId = 1;
    const rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => reject(new Error(`MCP timeout: ${method}`)), 30000);
        pending.set(id, (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    const callTool = async (name, args = {}) => {
      const res = await rpc('tools/call', { name, arguments: args });
      const text = res.result.content[0].text;
      return { isError: Boolean(res.result.isError), text, data: res.result.isError ? null : JSON.parse(text) };
    };

    let projectId = null;
    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
      assert.strictEqual(init.result.serverInfo.name, 'portly');
      assert.ok(init.result.capabilities.tools);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

      const list = await rpc('tools/list', {});
      const names = list.result.tools.map((t) => t.name);
      for (const n of ['portly_list_projects', 'portly_start_project', 'portly_stop_project', 'portly_restart_project', 'portly_get_logs', 'portly_add_project', 'portly_get_project', 'portly_inspect_folder', 'portly_stop_all']) {
        assert.ok(names.includes(n), `Missing MCP tool ${n}`);
      }
      assert.ok(list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object'));

      const unknown = await rpc('does/not/exist', {});
      assert.strictEqual(unknown.error.code, -32601);

      const inspected = await callTool('portly_inspect_folder', { path: siteDir });
      assert.strictEqual(inspected.data.valid, true);

      const added = await callTool('portly_add_project', { path: siteDir, name: 'mcp-test-site' });
      assert.strictEqual(added.isError, false, added.text);
      projectId = added.data.id;

      const dup = await callTool('portly_add_project', { path: siteDir });
      assert.strictEqual(dup.isError, true, 'Adding the same folder twice should report an error');

      const startedProj = await callTool('portly_start_project', { project: 'mcp-test', wait_seconds: 25 });
      assert.strictEqual(startedProj.isError, false, startedProj.text);
      assert.strictEqual(startedProj.data.status, 'running');
      assert.ok(startedProj.data.url, 'Expected a URL once the project is running');

      const page = await new Promise((resolve, reject) => {
        http.get(startedProj.data.url.replace('localhost', '127.0.0.1'), (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        }).on('error', reject);
      });
      assert.ok(page.includes('hello from portly test'));

      const cliList = JSON.parse(await runCli(['list']));
      assert.ok(cliList.some((p) => p.name === 'mcp-test-site' && p.status === 'running'));

      const logs = await callTool('portly_get_logs', { project: projectId, lines: 20 });
      assert.strictEqual(logs.isError, false, logs.text);
      assert.ok(logs.data.count >= 1);

      const stopped = await callTool('portly_stop_project', { project: 'mcp-test-site' });
      assert.strictEqual(stopped.isError, false, stopped.text);
      assert.notStrictEqual(stopped.data.status, 'running');

      const missing = await callTool('portly_start_project', { project: 'no-such-project-xyz' });
      assert.strictEqual(missing.isError, true);
      assert.strictEqual(strayOutput, false, 'portly-mcp.js wrote non-protocol data to stdout');
    } finally {
      child.kill();
      try {
        await requestJson(started.url, '/api/projects/stop-all', 'POST', {});
        if (projectId) await requestJson(started.url, `/api/projects/${projectId}`, 'DELETE');
      } catch {
        // best effort cleanup
      }
      fs.rmSync(siteDir, { recursive: true, force: true });
      await new Promise((resolve) => {
        srv.server.close(() => resolve());
        if (typeof srv.server.closeAllConnections === 'function') srv.server.closeAllConnections();
      });
    }
  });

  // 10. Light-theme white Portly logo asset checks
  check('White Portly logo assets exist for Light theme', () => {
    const whitePng = path.join(ROOT_DIR, 'public', 'portly-logo-white.png');
    assert.ok(fs.existsSync(whitePng), 'Missing public/portly-logo-white.png');
    assert.ok(fs.statSync(whitePng).size > 1000, 'Expected non-empty portly-logo-white.png');
  });

  // 11. Open-source freeware distribution docs & MIT license presence
  check('Open-source license, README, and privacy-safe package.json build config', () => {
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'LICENSE')), 'Missing LICENSE');
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'README.md')), 'Missing README.md');
    assert.ok(fs.existsSync(path.join(ROOT_DIR, 'CONTRIBUTING.md')), 'Missing CONTRIBUTING.md');
    const licenseText = fs.readFileSync(path.join(ROOT_DIR, 'LICENSE'), 'utf8');
    assert.ok(licenseText.includes('MIT License'), 'Expected MIT License header');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.license, 'MIT');
    assert.strictEqual(pkg.build.files.includes('data/projects.json'), false, 'Packaged build must not include personal data/projects.json');
  });

  for (const line of results) {
    console.log(line);
  }
  console.log(`ALL_MULTI_OS_TESTS_PASSED (${results.length}/${results.length})`);
}

run().catch((err) => {
  console.error('TEST_FAILED:', err);
  process.exit(1);
});
