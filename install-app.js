'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const DEFAULT_ROOT = __dirname;
const APP_VERSION = (() => {
  try {
    return require('./package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function chmodExecutable(filePath) {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Ignore on filesystems without POSIX mode bits
  }
}

function writeUnixFile(filePath, content, executable = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = content.replace(/\r\n/g, '\n');
  fs.writeFileSync(filePath, normalized, 'utf8');
  if (executable) {
    chmodExecutable(filePath);
  }
}

function writeWindowsFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const normalized = content.replace(/\r?\n/g, '\r\n');
  fs.writeFileSync(filePath, normalized, 'utf8');
}

function buildWindowsBatch() {
  return `@echo off
setlocal
cd /d "%~dp0"
echo Launching Portly Desktop App...
node desktop-app.js
if errorlevel 1 (
  echo.
  echo Portly exited with an error. Press any key to close...
  pause >nul
)
`;
}

function buildWindowsVbs() {
  return `' Silent desktop launcher for Portly (no terminal window)
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appDir
shell.Run "node """ & appDir & "\\desktop-app.js""", 0, False
`;
}

function buildMacCommandScript() {
  return `#!/bin/bash
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -n 1)/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "Node.js Required" message "Please install Node.js (https://nodejs.org) to run Portly." as critical'
  exit 1
fi
exec node "$DIR/desktop-app.js"
`;
}

function buildLinuxShellScript() {
  return `#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$HOME/.nvm/current/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required to run Portly (https://nodejs.org)." >&2
  exit 1
fi
exec node "$DIR/desktop-app.js"
`;
}

function buildMacInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>Portly</string>
  <key>CFBundleExecutable</key>
  <string>Portly</string>
  <key>CFBundleIdentifier</key>
  <string>com.portly.localstudio</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Portly</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${APP_VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
}

// rootDir is only embedded for the copy installed to ~/Applications. The bundle that lives
// next to the source files finds them relative to itself, so it stays portable.
function buildMacAppExecutable(rootDir = null) {
  const fallback = rootDir ? rootDir.replace(/"/g, '\\"') : '$MAC_ROOT';
  return `#!/bin/bash
set -e
BUNDLE_EXEC="$(cd "$(dirname "$0")" && pwd)"
MAC_ROOT="$(cd "$BUNDLE_EXEC/../../.." && pwd)"
FALLBACK_DIR="${fallback}"
if [ -f "$MAC_ROOT/desktop-app.js" ]; then
  APP_DIR="$MAC_ROOT"
else
  APP_DIR="$FALLBACK_DIR"
fi
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"
if [ -d "$HOME/.nvm/versions/node" ]; then
  LATEST_NODE="$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -n 1)"
  if [ -n "$LATEST_NODE" ]; then
    export PATH="$HOME/.nvm/versions/node/$LATEST_NODE/bin:$PATH"
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "Node.js Required" message "Install Node.js to launch Portly." as critical'
  exit 1
fi
cd "$APP_DIR"
exec node "$APP_DIR/desktop-app.js"
`;
}

// Portable entry that runs start-portly.sh from the folder the .desktop file sits in.
function buildPortableLinuxDesktopEntry() {
  return `[Desktop Entry]
Version=1.0
Type=Application
Name=Portly
GenericName=Local App Studio
Comment=Manage, start, stop, and view live logs for local web apps
Exec=sh -c 'cd "$(dirname "%k")" && ./start-portly.sh'
Terminal=false
Categories=Development;WebDevelopment;Utility;
StartupWMClass=Portly
`;
}

function buildLinuxDesktopEntry(rootDir) {
  const execScript = path.posix.join(rootDir.replace(/\\/g, '/'), 'start-portly.sh');
  return `[Desktop Entry]
Version=1.0
Type=Application
Name=Portly
GenericName=Local App Studio
Comment=Manage, start, stop, and view live logs for local web apps
Exec="${execScript}"
Path=${rootDir.replace(/\\/g, '/')}
Terminal=false
Categories=Development;WebDevelopment;Utility;
StartupWMClass=Portly
`;
}

function createWindowsShortcut(shortcutPath, vbsPath, workingDir) {
  const icoPath = path.join(workingDir, 'public', 'portly-logo.ico');
  const psScript = [
    '$ws = New-Object -ComObject WScript.Shell;',
    '$s = $ws.CreateShortcut($env:PORTLY_LNK_PATH);',
    '$s.TargetPath = "$env:SystemRoot\\System32\\wscript.exe";',
    '$s.Arguments = "//nologo `"$env:PORTLY_VBS_PATH`"";',
    '$s.WorkingDirectory = $env:PORTLY_WORK_DIR;',
    '$s.Description = "Portly — Local App Studio";',
    'if ($env:PORTLY_ICON_PATH -and (Test-Path $env:PORTLY_ICON_PATH)) { $s.IconLocation = $env:PORTLY_ICON_PATH } else { $s.IconLocation = "$env:SystemRoot\\System32\\shell32.dll,22" };',
    '$s.Save();'
  ].join(' ');

  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    env: {
      ...process.env,
      PORTLY_LNK_PATH: shortcutPath,
      PORTLY_VBS_PATH: vbsPath,
      PORTLY_WORK_DIR: workingDir,
      PORTLY_ICON_PATH: fs.existsSync(icoPath) ? icoPath : ''
    },
    windowsHide: true,
    stdio: 'pipe'
  });
}

async function installDesktopApp({ rootDir = DEFAULT_ROOT, installToUserMenu = false } = {}) {
  const createdPaths = [];

  // 1. Always generate cross-platform desktop launchers inside project directory
  const winPortlyBat = path.join(rootDir, 'Start-Portly-App.bat');
  const winVbs = path.join(rootDir, 'Portly-Desktop.vbs');
  writeWindowsFile(winPortlyBat, buildWindowsBatch());
  writeWindowsFile(winVbs, buildWindowsVbs());
  createdPaths.push(winPortlyBat, winVbs);

  const macCommand = path.join(rootDir, 'Start-Portly.command');
  writeUnixFile(macCommand, buildMacCommandScript(), true);
  createdPaths.push(macCommand);

  const linuxSh = path.join(rootDir, 'start-portly.sh');
  writeUnixFile(linuxSh, buildLinuxShellScript(), true);
  createdPaths.push(linuxSh);

  // macOS Portly.app bundle inside project directory
  const macAppBundle = path.join(rootDir, 'Portly.app');
  const macPlist = path.join(macAppBundle, 'Contents', 'Info.plist');
  const macExec = path.join(macAppBundle, 'Contents', 'MacOS', 'Portly');
  writeUnixFile(macPlist, buildMacInfoPlist(), false);
  writeUnixFile(macExec, buildMacAppExecutable(), true);
  createdPaths.push(macPlist, macExec);

  // Linux .desktop entry inside project directory
  const linuxDesktop = path.join(rootDir, 'Portly.desktop');
  writeUnixFile(linuxDesktop, buildPortableLinuxDesktopEntry(), true);
  createdPaths.push(linuxDesktop);

  // 2. Host-specific native shortcut artifact
  let nativeNote = '';
  if (process.platform === 'win32') {
    const portlyLnkPath = path.join(rootDir, 'Portly.lnk');
    createWindowsShortcut(portlyLnkPath, winVbs, rootDir);
    createdPaths.push(portlyLnkPath);
    nativeNote = 'Created Windows shortcut Portly.lnk and silent desktop launcher.';
  } else if (process.platform === 'darwin') {
    if (installToUserMenu) {
      const userAppsDir = path.join(os.homedir(), 'Applications', 'Portly.app');
      const userPlist = path.join(userAppsDir, 'Contents', 'Info.plist');
      const userExec = path.join(userAppsDir, 'Contents', 'MacOS', 'Portly');
      writeUnixFile(userPlist, buildMacInfoPlist(), false);
      writeUnixFile(userExec, buildMacAppExecutable(rootDir), true);
      createdPaths.push(userAppsDir);
    }
    nativeNote = 'Created macOS Portly.app bundle and Start-Portly.command.';
  } else {
    if (installToUserMenu) {
      const userMenuFile = path.join(
        os.homedir(),
        '.local',
        'share',
        'applications',
        'portly.desktop'
      );
      writeUnixFile(userMenuFile, buildLinuxDesktopEntry(rootDir), true);
      createdPaths.push(userMenuFile);
    }
    nativeNote = 'Created Linux Portly.desktop launcher and start-portly.sh.';
  }

  return {
    ok: true,
    platform: process.platform,
    createdPaths,
    message: nativeNote || 'Generated Windows, macOS, and Linux launchers.'
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const installToUserMenu = args.includes('--system') || args.includes('--user-menu');
  installDesktopApp({ rootDir: DEFAULT_ROOT, installToUserMenu })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      console.error(`Install failed: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  installDesktopApp,
  buildPortableLinuxDesktopEntry
};
