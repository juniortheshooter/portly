'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { app, BrowserWindow, shell, dialog, Tray, Menu, nativeImage } = require('electron');

if (app && app.isPackaged && !process.env.DEVDECK_DATA_DIR) {
  process.env.DEVDECK_DATA_DIR = app.getPath('userData');
}

const {
  startServer,
  stopAllProjects,
  cleanupAllRunningChildrenSync,
  setCustomFolderPicker,
  setCustomWindowController,
  setCustomCrashReportSaver,
  setCustomConfigSaver,
  getSettings,
  notifyInstanceActivation,
  PORT
} = require('./server');

let mainWindow = null;
const secondaryWindows = new Set();
let appTray = null;
let trayNoticeShown = false;
let serverUrl = `http://localhost:${PORT}`;
let ownsServer = false;
let isQuitting = false;

function resolveAppIconPath() {
  const winIco = path.join(__dirname, 'public', 'portly-logo.ico');
  const pngIcon = path.join(__dirname, 'public', 'portly-logo.png');
  if (process.platform === 'win32' && fs.existsSync(winIco)) {
    return winIco;
  }
  return pngIcon;
}

function focusWindowToFront(win) {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) {
    win.show();
  }
  if (win.isMinimized()) {
    win.restore();
  }
  if (typeof win.moveTop === 'function') {
    try {
      win.moveTop();
    } catch {
      // Ignore unsupported z-order move
    }
  }
  win.setAlwaysOnTop(true);
  win.focus();
  setTimeout(() => {
    if (!win.isDestroyed()) {
      win.setAlwaysOnTop(false);
    }
  }, 120);
}

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow().catch(console.error);
    return;
  }
  focusWindowToFront(mainWindow);
}

function lockDownNavigation(win) {
  // Keep the app window on the local Portly UI. Any other link opens in the default browser.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== serverUrl && !url.startsWith(`${serverUrl}/`)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
      }
    }
  });
}

async function createSecondaryWindow() {
  const baseBounds =
    mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : null;
  const win = new BrowserWindow({
    width: baseBounds ? baseBounds.width : 1440,
    height: baseBounds ? baseBounds.height : 900,
    x: baseBounds ? baseBounds.x + 28 : undefined,
    y: baseBounds ? baseBounds.y + 28 : undefined,
    minWidth: 880,
    minHeight: 620,
    frame: false,
    titleBarStyle: 'hidden',
    title: 'Portly — Local App Studio',
    icon: resolveAppIconPath(),
    autoHideMenuBar: true,
    backgroundColor: '#0b0c0e',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.setMenuBarVisibility(false);
  secondaryWindows.add(win);
  lockDownNavigation(win);
  await win.loadURL(serverUrl);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.on('closed', () => {
    secondaryWindows.delete(win);
  });
  return win;
}

function handleSecondInstanceActivation(reason = 'second-instance') {
  const currentSettings = getSettings();
  if (currentSettings.allowMultipleInstances && reason === 'second-instance') {
    createSecondaryWindow().catch(console.error);
    return {
      frameless: true,
      handledSingleInstance: true,
      allowMultipleInstances: true,
      openedNewWindow: true
    };
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow().catch(console.error);
    return {
      frameless: true,
      handledSingleInstance: true,
      allowMultipleInstances: false,
      restoredFrom: 'recreated'
    };
  }

  const wasHiddenInTray = !mainWindow.isVisible();
  const wasMinimized = mainWindow.isMinimized();
  const restoredFrom = wasHiddenInTray ? 'tray' : wasMinimized ? 'taskbar' : 'desktop';

  focusWindowToFront(mainWindow);

  if (reason === 'second-instance') {
    const message =
      restoredFrom === 'tray'
        ? 'Restored Portly from the system tray.'
        : restoredFrom === 'taskbar'
          ? 'Expanded Portly from the taskbar — only 1 instance can be used at a time.'
          : 'Only 1 instance of Portly can be used at a time (enable Multiple Instances in Settings to run more).';
    notifyInstanceActivation({
      restoredFrom,
      allowMultipleInstances: false,
      message
    });
  }

  return {
    frameless: true,
    handledSingleInstance: true,
    allowMultipleInstances: false,
    restoredFrom
  };
}

function requestExistingInstanceFocus(port = PORT) {
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

function updateTrayMenu() {
  if (!appTray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Portly Studio',
      click: () => restoreMainWindow()
    },
    {
      label: 'Stop All Running Servers',
      click: () => {
        stopAllProjects().catch((err) => {
          console.error('Failed stopping projects from tray:', err);
        });
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Portly Completely',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
  appTray.setContextMenu(menu);
}

function ensureSystemTray() {
  if (appTray) return appTray;
  try {
    const pngPath = path.join(__dirname, 'public', 'portly-logo.png');
    const iconPath = fs.existsSync(pngPath) ? pngPath : resolveAppIconPath();
    let img = nativeImage.createFromPath(iconPath);
    if (!img.isEmpty()) {
      img = img.resize({ width: 32, height: 32 });
    }
    appTray = new Tray(img);
    appTray.setToolTip('Portly — Local App Studio (Running in background)');
    appTray.on('click', () => restoreMainWindow());
    appTray.on('double-click', () => restoreMainWindow());
    updateTrayMenu();
  } catch (err) {
    console.error('Failed to create system tray:', err);
    appTray = null;
  }
  return appTray;
}

function hideWindowToTray() {
  ensureSystemTray();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    if (
      !trayNoticeShown &&
      appTray &&
      process.platform === 'win32' &&
      typeof appTray.displayBalloon === 'function'
    ) {
      trayNoticeShown = true;
      try {
        appTray.displayBalloon({
          title: 'Portly minimized to tray',
          content: 'Your local servers keep running in the background. Click the Portly tray icon to reopen or quit.'
        });
      } catch {
        // Ignore balloon errors on unsupported shells
      }
    }
  }
}

setCustomFolderPicker(async () => {
  const targetWindow = BrowserWindow.getFocusedWindow() || mainWindow;
  const result = await dialog.showOpenDialog(targetWindow || undefined, {
    title: 'Select Project Folder',
    buttonLabel: 'Select Folder',
    properties: ['openDirectory', 'dontAddToRecent']
  });
  return {
    path: result.canceled || !result.filePaths.length ? null : result.filePaths[0]
  };
});

setCustomCrashReportSaver(async ({ defaultFileName, content }) => {
  const targetWindow = BrowserWindow.getFocusedWindow() || mainWindow;
  let baseDir = app.getPath('desktop');
  if (!baseDir || !fs.existsSync(baseDir)) {
    baseDir = app.getPath('downloads') || app.getPath('userData');
  }
  const result = await dialog.showSaveDialog(targetWindow || undefined, {
    title: 'Save Portly Crash Report Locally',
    defaultPath: path.join(baseDir, defaultFileName),
    buttonLabel: 'Save Crash Report',
    filters: [
      { name: 'Crash Report Log (.log)', extensions: ['log', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) {
    return { filePath: null, canceled: true };
  }
  fs.writeFileSync(result.filePath, content, 'utf8');
  return { filePath: result.filePath, canceled: false };
});

setCustomConfigSaver(async ({ defaultFileName, content }) => {
  const targetWindow = BrowserWindow.getFocusedWindow() || mainWindow;
  let baseDir = app.getPath('desktop');
  if (!baseDir || !fs.existsSync(baseDir)) {
    baseDir = app.getPath('downloads') || app.getPath('userData');
  }
  const result = await dialog.showSaveDialog(targetWindow || undefined, {
    title: 'Save Portly Environment Config',
    defaultPath: path.join(baseDir, defaultFileName),
    buttonLabel: 'Save Config',
    filters: [
      { name: 'Portly Environment Config (.json)', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) {
    return { filePath: null, canceled: true };
  }
  fs.writeFileSync(result.filePath, content, 'utf8');
  return { filePath: result.filePath, canceled: false };
});

setCustomWindowController(async (action, body = {}) => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (action === 'quit') {
    isQuitting = true;
    app.quit();
    return { frameless: true, quitting: true };
  }
  if (action === 'focus') {
    return handleSecondInstanceActivation((body && body.reason) || 'second-instance');
  }
  if (!win) {
    return { frameless: false, maximized: false };
  }
  if (action === 'minimize') {
    win.minimize();
  } else if (action === 'maximize') {
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  } else if (action === 'tray') {
    hideWindowToTray();
    return { frameless: true, hiddenToTray: true, quitting: false };
  } else if (action === 'close') {
    if (win && mainWindow && win !== mainWindow && !win.isDestroyed()) {
      win.close();
      return {
        frameless: true,
        closedSecondaryWindow: true,
        quitting: false,
        hiddenToTray: false
      };
    }
    if (getSettings().exitClosesCompletely) {
      isQuitting = true;
      app.quit();
      return { frameless: true, quitting: true, hiddenToTray: false };
    }
    hideWindowToTray();
    return { frameless: true, hiddenToTray: true, quitting: false };
  }
  return {
    frameless: true,
    maximized: win.isMaximized()
  };
});

async function createWindow() {
  try {
    const started = await startServer();
    serverUrl = started.url;
    ownsServer = true;
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      const focusRes = await requestExistingInstanceFocus(PORT);
      if (!focusRes || typeof focusRes !== 'object' || focusRes.ok !== true) {
        // Something other than Portly is using the port. Never load a foreign page into the app window.
        dialog.showErrorBox(
          'Portly could not start',
          `Port ${PORT} is already in use by another program.\n\nClose that program, or start Portly with a different port by setting the PORT environment variable.`
        );
        isQuitting = true;
        app.exit(1);
        return;
      }
      if (
        focusRes &&
        focusRes.handledSingleInstance &&
        (!getSettings().allowMultipleInstances || focusRes.allowMultipleInstances === false) &&
        (focusRes.frameless || Number(focusRes.activeClients) > 0)
      ) {
        isQuitting = true;
        app.exit(0);
        return;
      }
      serverUrl = `http://localhost:${PORT}`;
      ownsServer = false;
    } else {
      throw err;
    }
  }

  if (ownsServer) {
    ensureSystemTray();
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 880,
    minHeight: 620,
    frame: false,
    titleBarStyle: 'hidden',
    title: 'Portly — Local App Studio',
    icon: resolveAppIconPath(),
    autoHideMenuBar: true,
    backgroundColor: '#0b0c0e',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  lockDownNavigation(mainWindow);
  await mainWindow.loadURL(serverUrl);

  // Route target="_blank" live app links (localhost:3000, etc.) to the OS default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:\/\//i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      if (getSettings().exitClosesCompletely) {
        isQuitting = true;
        app.quit();
        return;
      }
      event.preventDefault();
      hideWindowToTray();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  isQuitting = true;
  app.exit(0);
} else {
  app.on('second-instance', () => {
    handleSecondInstanceActivation('second-instance');
  });

  app.whenReady().then(() => {
    createWindow().catch((err) => {
      console.error('Failed to initialize Electron window:', err);
      app.quit();
    });

    app.on('activate', () => {
      restoreMainWindow();
    });
  });
}

app.on('before-quit', async (event) => {
  if (appTray) {
    appTray.destroy();
    appTray = null;
  }
  if (!isQuitting) {
    isQuitting = true;
  }
  if (!ownsServer) {
    return;
  }
  event.preventDefault();
  ownsServer = false;
  try {
    await stopAllProjects();
  } catch {
    // Ignore stop error on quit
  }
  cleanupAllRunningChildrenSync();
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (!appTray || isQuitting)) {
    app.quit();
  }
});
