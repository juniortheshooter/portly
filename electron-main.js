'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {
  app,
  BrowserWindow,
  shell,
  dialog,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage
} = require('electron');

if (app && app.isPackaged && !process.env.DEVDECK_DATA_DIR) {
  process.env.DEVDECK_DATA_DIR = app.getPath('userData');
}

// Check the single-instance lock before loading the server: a second launch should hand
// over to the running Portly and quit, without reading or rewriting projects.json.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.exit(0);
  return;
}

const {
  startServer,
  stopAllProjects,
  cleanupAllRunningChildrenSync,
  setCustomFolderPicker,
  setCustomWindowController,
  setCustomCrashReportSaver,
  setCustomConfigSaver,
  setSecretCodec,
  getSettings,
  notifyInstanceActivation,
  startProject,
  stopProject,
  onProjectStatus,
  onSettingsChanged,
  listProjectsWithStatus,
  recordInternalError,
  PORT
} = require('./server');

process.on('uncaughtException', (err) => recordInternalError('uncaughtException', err));

// Per-project environment variables are encrypted with the OS keychain (DPAPI on Windows,
// Keychain on macOS, libsecret/kwallet on Linux) whenever it is available.
setSecretCodec({
  available: () => Boolean(safeStorage && app.isReady() && safeStorage.isEncryptionAvailable()),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (data) => safeStorage.decryptString(Buffer.from(data, 'base64'))
});

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
// How the window frame is drawn on each OS:
// - Windows: our own title bar with real Windows caption buttons (keeps Snap Layouts).
// - macOS: native traffic lights inset into our title bar.
// - Linux: the desktop's own frame (frameless windows misbehave on many window managers).
const TITLEBAR_MODE = IS_WIN ? 'overlay' : IS_MAC ? 'inset' : 'native';
const TITLEBAR_HEIGHT = 34;

const THEME_COLORS = {
  light: { background: '#dfe4ec', symbol: '#0f172a' },
  dark: { background: '#0b0c0e', symbol: '#f3f4f6' }
};

function resolveThemeName() {
  const theme = (getSettings() || {}).theme;
  if (theme === 'dark' || theme === 'light') return theme;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function getWindowChromeOptions() {
  const colors = THEME_COLORS[resolveThemeName()];
  const base = {
    backgroundColor: colors.background,
    autoHideMenuBar: true,
    icon: resolveAppIconPath(),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  };
  if (TITLEBAR_MODE === 'overlay') {
    return {
      ...base,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: colors.background, symbolColor: colors.symbol, height: TITLEBAR_HEIGHT }
    };
  }
  if (TITLEBAR_MODE === 'inset') {
    return { ...base, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 10 } };
  }
  return { ...base, frame: true };
}

function getWindowUrl() {
  return `${serverUrl}/?titlebar=${TITLEBAR_MODE}`;
}

function applyThemeToWindows() {
  const colors = THEME_COLORS[resolveThemeName()];
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.setBackgroundColor(colors.background);
      if (TITLEBAR_MODE === 'overlay' && typeof win.setTitleBarOverlay === 'function') {
        win.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbol, height: TITLEBAR_HEIGHT });
      }
    } catch {
      // Older Electron or a window without an overlay
    }
  }
}

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
    title: 'Portly',
    ...getWindowChromeOptions()
  });

  win.setMenuBarVisibility(false);
  secondaryWindows.add(win);
  lockDownNavigation(win);
  win.once('ready-to-show', () => win.show());
  await win.loadURL(getWindowUrl());

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
          ? 'Portly is already open, so we brought it to the front.'
          : 'Portly is already open, so we brought it to the front. To open more windows, turn on Multiple Instances in Settings.';
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

function summarizeProjects(list) {
  const running = list.filter((p) => p.status === 'running').length;
  const crashed = list.filter((p) => p.status === 'crashed').length;
  const parts = [`${running} running`];
  if (crashed > 0) parts.push(`${crashed} crashed`);
  return `Portly: ${parts.join(', ')}`;
}

function buildTrayProjectItems(list) {
  if (list.length === 0) return [{ label: 'No projects yet', enabled: false }];
  return list.slice(0, 20).map((p) => {
    const port = p.assignedPort || p.customPort || p.defaultPort;
    const suffix = p.status === 'crashed' ? ' (crashed)' : port ? `  :${port}` : '';
    return {
      label: `${p.name}${suffix}`,
      type: 'checkbox',
      checked: p.status === 'running',
      click: () => {
        const action = p.status === 'running' ? stopProject(p.id) : startProject(p.id);
        Promise.resolve(action).catch((err) => console.error('Tray toggle failed:', err.message));
      }
    };
  });
}

function updateTrayMenu() {
  if (!appTray) return;
  let list = [];
  try {
    list = listProjectsWithStatus();
  } catch {
    list = [];
  }
  try {
    appTray.setToolTip(summarizeProjects(list));
  } catch {
    // ignore
  }
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Portly',
      click: () => restoreMainWindow()
    },
    { type: 'separator' },
    ...buildTrayProjectItems(list),
    { type: 'separator' },
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
      label: 'Quit Portly',
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
    appTray.setToolTip('Portly');
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
          title: 'Portly is still running',
          content: 'Your servers keep running. Click the Portly icon in the system tray to reopen or quit.'
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

function makeFileSaver({ title, buttonLabel, filters }) {
  return async ({ defaultFileName, content }) => {
    const targetWindow = BrowserWindow.getFocusedWindow() || mainWindow;
    let baseDir = app.getPath('desktop');
    if (!baseDir || !fs.existsSync(baseDir)) {
      baseDir = app.getPath('downloads') || app.getPath('userData');
    }
    const result = await dialog.showSaveDialog(targetWindow || undefined, {
      title,
      defaultPath: path.join(baseDir, defaultFileName),
      buttonLabel,
      filters
    });
    if (result.canceled || !result.filePath) {
      return { filePath: null, canceled: true };
    }
    fs.writeFileSync(result.filePath, content, 'utf8');
    return { filePath: result.filePath, canceled: false };
  };
}

setCustomCrashReportSaver(
  makeFileSaver({
    title: 'Save Portly Crash Report',
    buttonLabel: 'Save Crash Report',
    filters: [
      { name: 'Crash Report Log (.log)', extensions: ['log', 'txt'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
);

setCustomConfigSaver(
  makeFileSaver({
    title: 'Save Portly Environment Config',
    buttonLabel: 'Save Config',
    filters: [
      { name: 'Portly Environment Config (.json)', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  })
);

// Tray summary, tray project list and crash notifications follow project status changes.
const lastKnownStatus = new Map();
let trayRefreshTimer = null;
onProjectStatus((project) => {
  const previous = lastKnownStatus.get(project.id);
  lastKnownStatus.set(project.id, project.status);
  if (project.status === 'crashed' && previous && previous !== 'crashed') {
    const windowInFocus = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused();
    if (!windowInFocus && Notification.isSupported()) {
      try {
        const note = new Notification({
          title: `${project.name} crashed`,
          body: project.crashReason || 'The server stopped unexpectedly. Open Portly to see its logs.',
          silent: false
        });
        note.on('click', () => restoreMainWindow());
        note.show();
      } catch (err) {
        console.error('Crash notification failed:', err.message);
      }
    }
  }
  if (!trayRefreshTimer) {
    trayRefreshTimer = setTimeout(() => {
      trayRefreshTimer = null;
      updateTrayMenu();
    }, 300);
  }
});

onSettingsChanged(() => applyThemeToWindows());
nativeTheme.on('updated', () => applyThemeToWindows());

function buildMacAppMenu() {
  if (!IS_MAC) return;
  const openSettings = () => {
    restoreMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents
        .executeJavaScript('window.portlyOpenSettings && window.portlyOpenSettings()')
        .catch(() => {});
    }
  };
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: openSettings },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit Portly',
          accelerator: 'Cmd+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          }
        }
      ]
    },
    { role: 'editMenu' },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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
    title: 'Portly',
    ...getWindowChromeOptions()
  });

  mainWindow.setMenuBarVisibility(false);
  lockDownNavigation(mainWindow);
  // Show only once the page has painted, so there is no flash of the wrong colour.
  const shownWindow = mainWindow;
  shownWindow.once('ready-to-show', () => {
    if (!shownWindow.isDestroyed()) shownWindow.show();
  });
  await mainWindow.loadURL(getWindowUrl());
  if (!shownWindow.isDestroyed() && !shownWindow.isVisible()) shownWindow.show();
  updateTrayMenu();

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

{
  app.on('second-instance', () => {
    handleSecondInstanceActivation('second-instance');
  });

  app.whenReady().then(() => {
    buildMacAppMenu();
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
