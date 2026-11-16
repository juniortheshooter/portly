'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = __dirname;
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const RELEASE_DIR = path.join(ROOT_DIR, 'release');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function copyFileClean(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function writeUtf8(filePath, content, lfOnly = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const text = lfOnly ? content.replace(/\r\n/g, '\n') : content;
  fs.writeFileSync(filePath, text, 'utf8');
}

function copyDirRecursive(srcDir, destDir, skip = () => false) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, skip);
    } else {
      copyFileClean(srcPath, destPath);
    }
  }
}

function buildWebsiteDownloadHtml({ version, artifacts }) {
  const portable = artifacts.find((a) => a.id === 'portable');
  const setup = artifacts.find((a) => a.id === 'setup');
  const sourceZip = artifacts.find((a) => a.id === 'source');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Download Portly v${version} — Open-Source Local App Studio</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0c0e;
      --surface: #131519;
      --card: #1a1c21;
      --border: rgba(255, 255, 255, 0.1);
      --text: #f3f4f6;
      --muted: #9ca3af;
      --accent: #a855f7;
      --blue: #3b82f6;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 40px 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at 20% 10%, rgba(168, 85, 247, 0.12), transparent 45%), var(--bg);
      color: var(--text);
    }
    .portly-dl-wrap {
      max-width: 960px;
      margin: 0 auto;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 36px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
    }
    .portly-hero {
      display: flex;
      align-items: center;
      gap: 20px;
      flex-wrap: wrap;
      margin-bottom: 24px;
    }
    .portly-logo {
      width: 68px;
      height: 68px;
      border-radius: 18px;
      border: 1px solid rgba(168, 85, 247, 0.35);
      box-shadow: 0 8px 24px rgba(168, 85, 247, 0.25);
    }
    .portly-badges {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .pill {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      background: rgba(168, 85, 247, 0.16);
      color: #d8b4fe;
      border: 1px solid rgba(168, 85, 247, 0.3);
    }
    .pill.green {
      background: rgba(16, 185, 129, 0.14);
      color: #6ee7b7;
      border-color: rgba(16, 185, 129, 0.3);
    }
    h1 {
      margin: 0;
      font-size: 30px;
      letter-spacing: -0.02em;
    }
    .subtitle {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 15px;
      line-height: 1.5;
    }
    .dl-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 16px;
      margin: 28px 0;
    }
    .dl-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .dl-card h2 {
      margin: 0;
      font-size: 17px;
    }
    .dl-card p {
      margin: 0;
      font-size: 13px;
      color: var(--muted);
      line-height: 1.45;
      flex: 1;
    }
    .dl-meta {
      font-size: 12px;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .dl-btn {
      display: inline-block;
      text-align: center;
      text-decoration: none;
      padding: 11px 16px;
      border-radius: 12px;
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      background: linear-gradient(135deg, #7c3aed, #2563eb);
      transition: transform 0.15s ease, opacity 0.15s ease;
    }
    .dl-btn.secondary {
      background: #23262d;
      border: 1px solid var(--border);
    }
    .dl-btn:hover {
      opacity: 0.92;
      transform: translateY(-1px);
    }
    .checksums {
      background: #0e1014;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
      color: #cbd5e1;
      overflow-x: auto;
      line-height: 1.6;
    }
    .checksums-title {
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <section class="portly-dl-wrap" aria-labelledby="portly-title">
    <div class="portly-hero">
      <img src="./assets/portly-logo.png" alt="Portly logo" class="portly-logo" />
      <div>
        <h1 id="portly-title">Portly v${version} — Local App Studio</h1>
        <p class="subtitle">Free, open-source downloadable multi-OS desktop application to start, stop, monitor, and log local web apps across 30+ stacks with zero telemetry.</p>
        <div class="portly-badges">
          <span class="pill">Open-Source MIT License</span>
          <span class="pill green">100% Freeware &amp; Local-First</span>
          <span class="pill">Windows &bull; macOS &bull; Linux</span>
        </div>
      </div>
    </div>

    <div class="dl-grid">
      <div class="dl-card">
        <h2>Windows Portable (.exe)</h2>
        <p>Single-file executable you can share directly with friends. Double-click to run immediately with zero setup.</p>
        <div class="dl-meta">${portable.fileName} &bull; ${portable.sizeLabel}</div>
        <a class="dl-btn" href="./${portable.fileName}" download>Download Portable .exe</a>
      </div>

      <div class="dl-card">
        <h2>Windows Installer (.exe)</h2>
        <p>Full desktop setup adding Start Menu shortcuts, system tray integration, and clean uninstall support.</p>
        <div class="dl-meta">${setup.fileName} &bull; ${setup.sizeLabel}</div>
        <a class="dl-btn" href="./${setup.fileName}" download>Download Windows Setup</a>
      </div>

      <div class="dl-card">
        <h2>Multi-OS Open Source (.zip)</h2>
        <p>Full MIT-licensed source package with native launchers for Windows, macOS (.app / .command), and Linux (.sh / .desktop). Requires Node.js 18+.</p>
        <div class="dl-meta">${sourceZip.fileName} &bull; ${sourceZip.sizeLabel}</div>
        <a class="dl-btn secondary" href="./${sourceZip.fileName}" download>Download Source Archive</a>
      </div>
    </div>

    <div class="checksums-title">SHA-256 Checksums</div>
    <pre class="checksums">${artifacts.map((a) => `${a.sha256}  ${a.fileName}`).join('\n')}</pre>
  </section>
</body>
</html>
`;
}

function buildRelease() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const version = pkg.version || '1.1.0';
  const productName = pkg.productName || 'Portly';

  const distSetup = path.join(DIST_DIR, `${productName}-Setup-${version}-win-x64.exe`);
  const distPortable = path.join(DIST_DIR, `${productName}-Portable-${version}-win-x64.exe`);
  if (!fs.existsSync(distSetup) || !fs.existsSync(distPortable)) {
    throw new Error(
      `Missing Windows builds in dist/. Expected:\n- ${distSetup}\n- ${distPortable}\nRun "npm.cmd run dist:win" first.`
    );
  }

  fs.rmSync(RELEASE_DIR, { recursive: true, force: true });
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.mkdirSync(path.join(RELEASE_DIR, 'assets'), { recursive: true });

  const outSetupName = `${productName}-Setup-${version}-win-x64.exe`;
  const outPortableName = `${productName}-Portable-${version}-win-x64.exe`;
  const outZipName = `${productName}-OpenSource-${version}-MultiOS.zip`;

  const outSetupPath = path.join(RELEASE_DIR, outSetupName);
  const outPortablePath = path.join(RELEASE_DIR, outPortableName);
  const outZipPath = path.join(RELEASE_DIR, outZipName);

  copyFileClean(distSetup, outSetupPath);
  copyFileClean(distPortable, outPortablePath);

  // Stage clean privacy-safe open-source Multi-OS tree
  const tmpStageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'portly-release-stage-'));
  const stageDir = path.join(tmpStageRoot, `${productName}-OpenSource-${version}`);
  try {
    fs.mkdirSync(stageDir, { recursive: true });

    const rootSourceFiles = [
      'server.js',
      'desktop-app.js',
      'electron-main.js',
      'static-server.js',
      'install-app.js',
      'portly-client.js',
      'portly-mcp.js',
      'portly-cli.js',
      'embed-win-icon.js',
      'build-release.js',
      'test-multi-os.js',
      'package.json',
      'package-lock.json',
      'LICENSE',
      'README.md',
      'CONTRIBUTING.md',
      '.gitignore',
      'Start-Portly-App.bat',
      'Portly-Desktop.vbs',
      'Start-Portly.command',
      'start-portly.sh'
    ];

    for (const rel of rootSourceFiles) {
      const full = path.join(ROOT_DIR, rel);
      if (!fs.existsSync(full)) {
        throw new Error(`Missing required source file for release archive: ${rel}`);
      }
      copyFileClean(full, path.join(stageDir, rel));
    }

    // Copy public UI & branding assets
    copyDirRecursive(path.join(ROOT_DIR, 'public'), path.join(stageDir, 'public'), (name) =>
      /\.jpe?g$/i.test(name)
    );

    // Copy macOS Portly.app with portable relative path fallback (no machine-specific path)
    if (fs.existsSync(path.join(ROOT_DIR, 'Portly.app'))) {
      copyDirRecursive(path.join(ROOT_DIR, 'Portly.app'), path.join(stageDir, 'Portly.app'));
      const stagedMacExec = path.join(stageDir, 'Portly.app', 'Contents', 'MacOS', 'Portly');
      if (fs.existsSync(stagedMacExec)) {
        const sanitizedExec = fs
          .readFileSync(stagedMacExec, 'utf8')
          .replace(/FALLBACK_DIR="[^"]*"/, 'FALLBACK_DIR="$MAC_ROOT"');
        writeUtf8(stagedMacExec, sanitizedExec, true);
      }
    }

    // Write portable Linux .desktop entry (no hardcoded machine paths)
    writeUtf8(
      path.join(stageDir, 'Portly.desktop'),
      require('./install-app').buildPortableLinuxDesktopEntry(),
      true
    );

    // Seed clean empty workspace data (zero personal paths or settings)
    writeUtf8(path.join(stageDir, 'data', 'projects.json'), '[]\n', true);
    writeUtf8(
      path.join(stageDir, 'data', 'settings.json'),
      JSON.stringify(
        {
          userName: '',
          theme: 'light',
          defaultExpanded: false,
          allowMultipleInstances: false,
          exitClosesCompletely: false,
          onboarded: false
        },
        null,
        2
      ) + '\n',
      true
    );

    if (process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Compress-Archive -Path '${stageDir.replace(/'/g, "''")}' -DestinationPath '${outZipPath.replace(/'/g, "''")}' -Force`
        ],
        { stdio: 'pipe', windowsHide: true }
      );
    } else {
      execFileSync('zip', ['-r', '-q', outZipPath, path.basename(stageDir)], {
        cwd: tmpStageRoot,
        stdio: 'pipe'
      });
    }
  } finally {
    fs.rmSync(tmpStageRoot, { recursive: true, force: true });
  }

  const artifacts = [
    { id: 'setup', fileName: outSetupName, filePath: outSetupPath },
    { id: 'portable', fileName: outPortableName, filePath: outPortablePath },
    { id: 'source', fileName: outZipName, filePath: outZipPath }
  ].map((item) => {
    const stat = fs.statSync(item.filePath);
    return {
      ...item,
      bytes: stat.size,
      sizeLabel: formatMB(stat.size),
      sha256: sha256File(item.filePath)
    };
  });

  writeUtf8(
    path.join(RELEASE_DIR, 'SHA256SUMS.txt'),
    // Standard format so users can verify with `sha256sum -c SHA256SUMS.txt`
    artifacts.map((a) => `${a.sha256}  ${a.fileName}`).join('\n') + '\n',
    true
  );

  copyFileClean(
    path.join(ROOT_DIR, 'public', 'portly-logo.png'),
    path.join(RELEASE_DIR, 'assets', 'portly-logo.png')
  );
  copyFileClean(
    path.join(ROOT_DIR, 'public', 'portly-logo-white.png'),
    path.join(RELEASE_DIR, 'assets', 'portly-logo-white.png')
  );

  writeUtf8(
    path.join(RELEASE_DIR, 'website-download-section.html'),
    buildWebsiteDownloadHtml({ version, artifacts }),
    true
  );

  console.log(`Built Portly v${version} shippable release in ${RELEASE_DIR}:`);
  for (const a of artifacts) {
    console.log(`- ${a.fileName} (${a.sizeLabel}) SHA256=${a.sha256}`);
  }
}

if (require.main === module) {
  buildRelease();
}

module.exports = { buildRelease };
