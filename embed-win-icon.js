const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function findCachedRcedit(archName) {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const cacheRoot = path.join(localAppData, 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(cacheRoot)) return null;

  const exeName = archName === 'ia32' ? 'rcedit-ia32.exe' : 'rcedit-x64.exe';
  const preferredDirs = ['winCodeSign-2.6.0', '016197363', '741773463', '078418347', '918289527'];

  for (const dir of preferredDirs) {
    const candidate = path.join(cacheRoot, dir, exeName);
    if (fs.existsSync(candidate)) return candidate;
  }

  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(cacheRoot, entry.name, exeName);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const productFilename = context.packager?.appInfo?.productFilename || 'Portly';
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, 'public', 'portly-logo.ico');

  if (!fs.existsSync(exePath)) {
    throw new Error(`afterPack: executable not found at ${exePath}`);
  }
  if (!fs.existsSync(iconPath)) {
    throw new Error(`afterPack: icon not found at ${iconPath}`);
  }

  const rceditPath = findCachedRcedit(context.arch === 0 ? 'ia32' : 'x64');
  if (rceditPath) {
    const version = context.packager?.appInfo?.version || '1.0.0';
    execFileSync(
      rceditPath,
      [
        exePath,
        '--set-icon',
        iconPath,
        '--set-version-string',
        'ProductName',
        productFilename,
        '--set-version-string',
        'FileDescription',
        'Portly — Multi-OS Local Project Launcher & Port Manager',
        '--set-file-version',
        version,
        '--set-product-version',
        version
      ],
      { stdio: 'inherit' }
    );
  } else {
    console.warn('[afterPack] Cached rcedit executable not found; relying on electron-builder resource editor.');
  }

  try {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const ie4uinit = path.join(sysRoot, 'System32', 'ie4uinit.exe');
    if (fs.existsSync(ie4uinit)) {
      execFileSync(ie4uinit, ['-show'], { stdio: 'ignore' });
    }
  } catch {
    // Icon cache refresh is best-effort
  }
};
