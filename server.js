'use strict';

const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { URL } = require('node:url');
const envStoreLib = require('./env-store');
const namedUrls = require('./named-urls');
const stackDetect = require('./stack-detect');

const PORT = Number(process.env.PORT) || 4567;
const HOST = '127.0.0.1';

const ROOT_DIR = __dirname;
const STORAGE_ROOT = process.env.DEVDECK_DATA_DIR
  ? path.resolve(process.env.DEVDECK_DATA_DIR)
  : ROOT_DIR;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(STORAGE_ROOT, 'data');
const LOGS_DIR = path.join(STORAGE_ROOT, 'logs');
const CRASH_REPORTS_DIR = path.join(STORAGE_ROOT, 'crash-reports');
const CONFIGS_DIR = path.join(STORAGE_ROOT, 'configs');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LAYOUT_FILE = path.join(DATA_DIR, 'layout.json');
const STACKS_FILE = path.join(DATA_DIR, 'stacks.json');
const ENV_VARS_FILE = path.join(DATA_DIR, 'env-vars.json');
// How long a stack waits for a service to answer on its port before starting the next one.
const STACK_READY_TIMEOUT_MS = Number(process.env.PORTLY_STACK_READY_TIMEOUT_MS) || 60000;
// A worker counts as started once it has stayed up this long.
const WORKER_READY_MS = 1500;
// In packaged builds the app lives inside app.asar, which plain `node` cannot read, so the
// static server is shipped unpacked next to it (see build.asarUnpack in package.json).
const STATIC_SERVER_SCRIPT = path
  .join(ROOT_DIR, 'static-server.js')
  .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

const MAX_MEMORY_LOGS = 500;
const MAX_READ_LOG_LINES = 200;
// Rotate a project's log file once it passes this size, keeping one older file (<id>.1.log).
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
// Batch log lines sent to the UI so a chatty build doesn't trigger one event per line.
const LOG_BROADCAST_INTERVAL_MS = 75;
const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{1,80}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const ANSI_REGEX = /(?:\x1B\[[0-?]*[ -/]*[@-~]|\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B[@-Z\\-_])/g;
const LOCAL_URL_REGEX = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)[^\s"')\]]*/i;
const PORT_LISTEN_REGEX = /(?:listening on|running on|started on|port)\s*(?::|\s)\s*(\d{2,5})\b/i;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

/** @type {Array<object>} */
let projects = [];
/** Stacks: groups of services (projects with a matching stackId). Saved in data/stacks.json. */
let stacks = [];

/** @type {(() => Promise<{ path: string | null }>) | null} */
let customFolderPicker = null;

function setCustomFolderPicker(fn) {
  customFolderPicker = typeof fn === 'function' ? fn : null;
}

/** @type {((action: string, body?: object) => Promise<object> | object) | null} */
let customWindowController = null;

function setCustomWindowController(fn) {
  customWindowController = typeof fn === 'function' ? fn : null;
}

/** @type {((payload: { defaultFileName: string, content: string }) => Promise<{ filePath: string | null, canceled?: boolean }>) | null} */
let customCrashReportSaver = null;

function setCustomCrashReportSaver(fn) {
  customCrashReportSaver = typeof fn === 'function' ? fn : null;
}

/** @type {((payload: { defaultFileName: string, content: string }) => Promise<{ filePath: string | null, canceled?: boolean }>) | null} */
let customConfigSaver = null;

function setCustomConfigSaver(fn) {
  customConfigSaver = typeof fn === 'function' ? fn : null;
}

/** @type {{ userName: string, theme: 'light' | 'dark', defaultExpanded: boolean, allowMultipleInstances: boolean, exitClosesCompletely: boolean, onboarded: boolean }} */
let settings = {
  userName: '',
  theme: 'light',
  defaultExpanded: false,
  allowMultipleInstances: false,
  exitClosesCompletely: false,
  onboarded: false
};

let savedLayout = {
  overviewMode: 'expanded',
  overviewPosition: 'top',
  overviewScale: 1,
  overviewBlockOrder: ['banner', 'kpis'],
  kpiOrder: ['total', 'running', 'stopped'],
  splitDirection: 'horizontal',
  splitRatio: 56,
  paneFocus: 'split',
  viewMode: 'split',
  filter: 'all',
  expandedCardPaths: []
};

/** @type {Map<string, object>} */
const runtimeState = new Map();

/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();

/** Problems found while loading saved data, shown once in the UI (GET /api/notices). */
const startupNotices = [];

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Atomics.wait unavailable: retry immediately
  }
}

/**
 * Writes a file so that a crash, power cut or forced quit can never leave it half-written:
 * the content goes to a temp file first, is flushed to disk, then renamed over the original
 * (an atomic replace on Windows, macOS and Linux).
 */
function writeFileAtomic(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, content, null, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {
      // fsync is best effort (not supported on some network drives)
    }
  } finally {
    fs.closeSync(fd);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmpPath, filePath);
      return;
    } catch (err) {
      // Antivirus, indexers and sync tools on Windows can briefly lock the target file.
      if (['EPERM', 'EBUSY', 'EACCES'].includes(err.code) && attempt < 6) {
        sleepSync(25 * (attempt + 1));
        continue;
      }
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      throw err;
    }
  }
}

function writeJsonAtomic(filePath, data) {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2));
}

function timestampForFileName() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Moves an unreadable data file aside so it is never overwritten, and returns the new path. */
function quarantineCorruptFile(filePath) {
  const parsed = path.parse(filePath);
  const target = path.join(parsed.dir, `${parsed.name}.corrupt-${timestampForFileName()}${parsed.ext}`);
  try {
    fs.renameSync(filePath, target);
    return target;
  } catch {
    try {
      fs.copyFileSync(filePath, target);
      return target;
    } catch {
      return null;
    }
  }
}

function ensureDirectories() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(CRASH_REPORTS_DIR, { recursive: true });
  fs.mkdirSync(CONFIGS_DIR, { recursive: true });
}

function getDefaultLayout() {
  return {
    overviewMode: 'expanded',
    overviewPosition: 'top',
    overviewScale: 1,
    overviewBlockOrder: ['banner', 'kpis'],
    kpiOrder: ['total', 'running', 'stopped'],
    splitDirection: 'horizontal',
    splitRatio: 56,
    paneFocus: 'split',
    viewMode: 'split',
    filter: 'all',
    expandedCardPaths: []
  };
}

function sanitizeLayout(raw = {}) {
  const defaults = getDefaultLayout();
  const src = raw && typeof raw === 'object' ? raw : {};

  const overviewMode = ['expanded', 'compact', 'collapsed'].includes(src.overviewMode)
    ? src.overviewMode
    : defaults.overviewMode;
  const overviewPosition = ['top', 'bottom'].includes(src.overviewPosition)
    ? src.overviewPosition
    : defaults.overviewPosition;
  const scaleNum = Number(src.overviewScale);
  const overviewScale = Number.isFinite(scaleNum)
    ? Math.round(Math.min(1.22, Math.max(0.65, scaleNum)) * 100) / 100
    : defaults.overviewScale;
  const validBlocks = new Set(['banner', 'kpis']);
  const overviewBlockOrder =
    Array.isArray(src.overviewBlockOrder) &&
    src.overviewBlockOrder.length === 2 &&
    src.overviewBlockOrder.every((k) => validBlocks.has(k)) &&
    new Set(src.overviewBlockOrder).size === 2
      ? [...src.overviewBlockOrder]
      : [...defaults.overviewBlockOrder];
  const validKpis = new Set(['total', 'running', 'stopped']);
  const kpiOrder =
    Array.isArray(src.kpiOrder) &&
    src.kpiOrder.length === 3 &&
    src.kpiOrder.every((k) => validKpis.has(k)) &&
    new Set(src.kpiOrder).size === 3
      ? [...src.kpiOrder]
      : [...defaults.kpiOrder];
  const splitDirection = ['horizontal', 'vertical'].includes(src.splitDirection)
    ? src.splitDirection
    : defaults.splitDirection;
  const ratioNum = Number(src.splitRatio);
  const splitRatio = Number.isFinite(ratioNum)
    ? Math.round(Math.min(80, Math.max(20, ratioNum)) * 10) / 10
    : defaults.splitRatio;
  const paneFocus = ['split', 'console-collapsed', 'console-full'].includes(src.paneFocus)
    ? src.paneFocus
    : defaults.paneFocus;
  const viewMode = ['split', 'cards', 'table'].includes(src.viewMode)
    ? src.viewMode
    : defaults.viewMode;
  const filter = ['all', 'running', 'stopped', 'crashed'].includes(src.filter)
    ? src.filter
    : defaults.filter;
  const expandedCardPaths = Array.isArray(src.expandedCardPaths)
    ? src.expandedCardPaths
        .map((p) => cleanPathInput(p))
        .filter(Boolean)
    : [];

  return {
    overviewMode,
    overviewPosition,
    overviewScale,
    overviewBlockOrder,
    kpiOrder,
    splitDirection,
    splitRatio,
    paneFocus,
    viewMode,
    filter,
    expandedCardPaths
  };
}

function loadLayout() {
  ensureDirectories();
  const defaults = getDefaultLayout();
  if (fs.existsSync(LAYOUT_FILE)) {
    try {
      const raw = fs.readFileSync(LAYOUT_FILE, 'utf8').replace(/^\uFEFF/, '');
      savedLayout = sanitizeLayout(JSON.parse(raw));
      return;
    } catch {
      savedLayout = defaults;
    }
  } else {
    savedLayout = defaults;
  }
  saveLayout(savedLayout);
}

function saveLayout(nextLayout) {
  ensureDirectories();
  savedLayout = sanitizeLayout(nextLayout);
  writeJsonAtomic(LAYOUT_FILE, savedLayout);
  return savedLayout;
}

function normalizeTheme(value) {
  return value === 'dark' || value === 'system' ? value : 'light';
}

function getDefaultSettings() {
  return {
    userName: '',
    theme: 'light',
    defaultExpanded: false,
    allowMultipleInstances: false,
    exitClosesCompletely: false,
    onboarded: false,
    namedUrls: true,
    proxyPort: namedUrls.DEFAULT_PROXY_PORT
  };
}

function validateProxyPortInput(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    const err = new Error('The named URL port must be a number between 1 and 65535.');
    err.statusCode = 400;
    throw err;
  }
  if (n === PORT) {
    const err = new Error(`Port ${n} is Portly's own port. Pick another one.`);
    err.statusCode = 400;
    throw err;
  }
  return n;
}

function normalizeProxyPort(value, fallback = namedUrls.DEFAULT_PROXY_PORT) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function loadSettings() {
  ensureDirectories();
  const defaults = getDefaultSettings();
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      const cleanName = typeof parsed.userName === 'string' ? parsed.userName.trim() : '';
      settings = {
        userName: cleanName,
        theme: normalizeTheme(parsed.theme),
        defaultExpanded: Boolean(parsed.defaultExpanded),
        allowMultipleInstances: Boolean(parsed.allowMultipleInstances),
        exitClosesCompletely: Boolean(parsed.exitClosesCompletely),
        onboarded: Boolean(parsed.onboarded) && Boolean(cleanName),
        namedUrls: parsed.namedUrls === undefined ? true : Boolean(parsed.namedUrls),
        proxyPort: normalizeProxyPort(parsed.proxyPort)
      };
      return;
    } catch {
      settings = { ...defaults };
    }
  } else {
    settings = { ...defaults };
  }
  saveSettings(settings);
}

function saveSettings(nextSettings) {
  ensureDirectories();
  const cleanName = typeof nextSettings.userName === 'string' ? nextSettings.userName.trim() : '';
  settings = {
    userName: cleanName,
    theme: normalizeTheme(nextSettings.theme),
    defaultExpanded: Boolean(nextSettings.defaultExpanded),
    allowMultipleInstances:
      nextSettings.allowMultipleInstances !== undefined
        ? Boolean(nextSettings.allowMultipleInstances)
        : Boolean(settings && settings.allowMultipleInstances),
    exitClosesCompletely:
      nextSettings.exitClosesCompletely !== undefined
        ? Boolean(nextSettings.exitClosesCompletely)
        : Boolean(settings && settings.exitClosesCompletely),
    onboarded:
      nextSettings.onboarded !== undefined
        ? Boolean(nextSettings.onboarded) && Boolean(cleanName)
        : Boolean(cleanName),
    namedUrls:
      nextSettings.namedUrls !== undefined
        ? Boolean(nextSettings.namedUrls)
        : settings && settings.namedUrls !== undefined
          ? Boolean(settings.namedUrls)
          : true,
    proxyPort: normalizeProxyPort(
      nextSettings.proxyPort,
      settings && settings.proxyPort ? settings.proxyPort : namedUrls.DEFAULT_PROXY_PORT
    )
  };
  writeJsonAtomic(SETTINGS_FILE, settings);
  for (const listener of settingsListeners) {
    try {
      listener(settings);
    } catch (err) {
      console.error('Settings listener failed:', err.message);
    }
  }
  return settings;
}

function resetSettings() {
  const defaults = getDefaultSettings();
  settings = { ...defaults };
  savedLayout = getDefaultLayout();
  ensureDirectories();
  writeJsonAtomic(SETTINGS_FILE, settings);
  writeJsonAtomic(LAYOUT_FILE, savedLayout);
  broadcastEvent('settings-updated', settings);
  return settings;
}

function getSettings() {
  return { ...settings };
}

function notifyInstanceActivation(payload = {}) {
  const eventPayload = {
    restoredFrom: payload.restoredFrom || 'desktop',
    allowMultipleInstances: Boolean(
      payload.allowMultipleInstances !== undefined
        ? payload.allowMultipleInstances
        : settings.allowMultipleInstances
    ),
    message:
      payload.message ||
      'Only 1 instance of Portly can be used at a time (enable Multiple Instances in Settings to run more).',
    timestamp: new Date().toISOString()
  };
  broadcastEvent('instance-activated', eventPayload);
  return eventPayload;
}

function getSystemInfo() {
  const platform = process.platform;
  const arch = os.arch();
  const homedir = os.homedir();
  const release = os.release();
  const osVersion = typeof os.version === 'function' ? os.version() : release;

  if (platform === 'win32') {
    return {
      platform,
      osName: 'Windows',
      osFamily: 'windows',
      arch,
      release,
      osVersion,
      homedir,
      nodeVersion: process.version,
      fileManagerLabel: 'Explorer',
      shortcutModifier: 'Ctrl',
      shellName: 'cmd.exe',
      pathPlaceholder: `${path.join(homedir, 'projects', 'my-web-app')}`
    };
  }

  if (platform === 'darwin') {
    return {
      platform,
      osName: 'macOS',
      osFamily: 'mac',
      arch,
      release,
      osVersion,
      homedir,
      nodeVersion: process.version,
      fileManagerLabel: 'Finder',
      shortcutModifier: '⌘',
      shellName: path.basename(process.env.SHELL || 'zsh'),
      pathPlaceholder: '~/Projects/my-web-app'
    };
  }

  return {
    platform,
    osName: platform === 'linux' ? 'Linux' : platform,
    osFamily: 'linux',
    arch,
    release,
    osVersion,
    homedir,
    nodeVersion: process.version,
    fileManagerLabel: 'File Manager',
    shortcutModifier: 'Ctrl',
    shellName: path.basename(process.env.SHELL || 'bash'),
    pathPlaceholder: '~/projects/my-web-app'
  };
}

function cleanPathInput(rawPath) {
  if (typeof rawPath !== 'string') return '';
  let cleaned = rawPath.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (cleaned === '~') {
    cleaned = os.homedir();
  } else if (cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
    cleaned = path.join(os.homedir(), cleaned.slice(2));
  }
  return cleaned;
}

function normalizePathKey(dirPath) {
  const normalized = path.resolve(dirPath).replace(/[\\/]+$/, '');
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return normalized.toLowerCase();
  }
  return normalized;
}

function stripAnsi(text) {
  return String(text).replace(ANSI_REGEX, '').replace(/\r/g, '');
}

function readPortFromEnvFile(dirPath) {
  for (const envName of ['.env', '.env.local', '.env.development']) {
    const envPath = path.join(dirPath, envName);
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      const match = content.match(/^\s*PORT\s*=\s*["']?(\d{2,5})["']?/m);
      if (match) return Number(match[1]);
    } catch {
      // Ignore unreadable env file
    }
  }
  return null;
}

function readPortFromSourceFiles(dirPath, pkg) {
  const candidates = [
    'src/server/index.ts',
    'src/server/index.js',
    'src/index.ts',
    'src/index.js',
    'server.ts',
    'server.js',
    'index.ts',
    'index.js',
    'app.ts',
    'app.js'
  ];

  const scriptsText = pkg && pkg.scripts ? Object.values(pkg.scripts).join(' ') : '';
  const scriptPortMatch = scriptsText.match(/(?:--port|-p)\s+(\d{2,5})\b/);
  if (scriptPortMatch) {
    return Number(scriptPortMatch[1]);
  }

  for (const rel of candidates) {
    const full = path.join(dirPath, rel);
    if (!fs.existsSync(full)) continue;
    try {
      const src = fs.readFileSync(full, 'utf8');
      const envFallback = src.match(/process\.env\.PORT\s*\|\|\s*(\d{2,5})/);
      if (envFallback) return Number(envFallback[1]);
      const listenMatch = src.match(/\.listen\(\s*(\d{2,5})\b/);
      if (listenMatch) return Number(listenMatch[1]);
    } catch {
      // Ignore unreadable source file
    }
  }
  return null;
}

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

function findFirstExisting(dirPath, candidates) {
  for (const rel of candidates) {
    const full = path.join(dirPath, rel);
    if (fs.existsSync(full)) return rel;
  }
  return '';
}

function findFileByExt(dirPath, exts) {
  try {
    const files = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of files) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (exts.some((ext) => lower.endsWith(ext))) {
        return entry.name;
      }
    }
  } catch {
    // Ignore unreadable folder
  }
  return '';
}

function detectJsPackageManager(dirPath, pkg) {
  if (fs.existsSync(path.join(dirPath, 'bun.lockb')) || fs.existsSync(path.join(dirPath, 'bun.lock'))) {
    return 'bun';
  }
  if (fs.existsSync(path.join(dirPath, 'pnpm-lock.yaml'))) {
    return 'pnpm';
  }
  if (fs.existsSync(path.join(dirPath, 'yarn.lock'))) {
    return 'yarn';
  }
  const declared = typeof pkg?.packageManager === 'string' ? pkg.packageManager.toLowerCase() : '';
  if (declared.startsWith('bun@')) return 'bun';
  if (declared.startsWith('pnpm@')) return 'pnpm';
  if (declared.startsWith('yarn@')) return 'yarn';
  return 'npm';
}

function formatPmScript(pm, scriptName) {
  if (scriptName === 'start' && pm === 'npm') return 'npm start';
  if (pm === 'yarn') return `yarn ${scriptName}`;
  return `${pm} run ${scriptName}`;
}

function chooseSuggestedCommand(scripts, pm = 'npm') {
  if (!scripts || typeof scripts !== 'object') return formatPmScript(pm, 'dev');
  if (scripts.dev) return formatPmScript(pm, 'dev');
  if (scripts.start) return formatPmScript(pm, 'start');
  if (scripts.serve) return formatPmScript(pm, 'serve');
  if (scripts.preview) return formatPmScript(pm, 'preview');
  const scriptNames = Object.keys(scripts);
  if (scriptNames.length > 0) {
    return formatPmScript(pm, scriptNames[0]);
  }
  return formatPmScript(pm, 'dev');
}

function extractTechStack(deps, hasTsConfig, pm) {
  const stack = [];
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
  const majorOf = (name) => {
    const v = String(deps[name] || '').replace(/^[^0-9]*/, '');
    const m = v.match(/^(\d+)/);
    return m ? m[1] : '';
  };

  if (pm && pm !== 'npm') stack.push(pm === 'bun' ? 'Bun' : pm === 'pnpm' ? 'pnpm' : 'Yarn');
  if (hasTsConfig || has('typescript') || has('tsx')) stack.push('TypeScript');
  if (has('next')) stack.push(`Next.js${majorOf('next') ? ` ${majorOf('next')}` : ''}`);
  if (has('express')) stack.push('Express');
  if (has('fastify')) stack.push('Fastify');
  if (has('hono')) stack.push('Hono');
  if (has('vite')) stack.push('Vite');
  if (has('react')) stack.push(`React${majorOf('react') ? ` ${majorOf('react')}` : ''}`);
  if (has('vue')) stack.push('Vue');
  if (has('svelte') || has('@sveltejs/kit')) stack.push('Svelte');
  if (has('solid-js') || has('@solidjs/start')) stack.push('SolidJS');
  if (has('@builder.io/qwik')) stack.push('Qwik');
  if (has('tailwindcss') || has('@tailwindcss/vite')) stack.push('Tailwind');
  if (has('@electric-sql/pglite')) stack.push('PGlite');
  if (has('drizzle-orm')) stack.push('Drizzle');
  if (has('prisma') || has('@prisma/client')) stack.push('Prisma');
  if (has('pg') || has('postgres')) stack.push('Postgres');

  return stack.slice(0, 5);
}

function analyzeNodePackage(dirPath, pkg, hasAnyHtml) {
  const deps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {})
  };
  const has = (name) => Object.prototype.hasOwnProperty.call(deps, name);
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const pm = detectJsPackageManager(dirPath, pkg);
  const hasTsConfig = fs.existsSync(path.join(dirPath, 'tsconfig.json'));
  const language = hasTsConfig || has('typescript') || has('tsx') ? 'TypeScript' : 'JavaScript';
  const techStack = extractTechStack(deps, hasTsConfig, pm);

  const detectedPort =
    readPortFromEnvFile(dirPath) ||
    readPortFromSourceFiles(dirPath, pkg);

  const devScript = typeof scripts.dev === 'string' ? scripts.dev : '';
  const hasBackendServer =
    has('express') ||
    has('fastify') ||
    has('koa') ||
    has('hono') ||
    has('@nestjs/core') ||
    has('@adonisjs/core');

  let framework = pm === 'bun' ? 'Bun' : 'Node.js';
  let programType =
    language === 'TypeScript' ? 'TypeScript Web App' : `${pm === 'bun' ? 'Bun' : 'Node.js'} Web App`;
  let defaultPort = detectedPort || 3000;
  let recommendedCommand = chooseSuggestedCommand(scripts, pm);
  let deployNote = pm !== 'npm' ? `Detected ${pm} workspace` : '';

  if (hasBackendServer && has('vite')) {
    const serverName = has('fastify')
      ? 'Fastify'
      : has('hono')
        ? 'Hono'
        : has('koa')
          ? 'Koa'
          : 'Express';
    framework = `${serverName} + Vite`;
    programType =
      language === 'TypeScript'
        ? 'Full-Stack TypeScript Server'
        : 'Full-Stack Node Server';
    defaultPort = detectedPort || 3000;

    if (/\btsx\s+watch\b/i.test(devScript)) {
      recommendedCommand = devScript.replace(/\btsx\s+watch\b/i, 'npx tsx').trim();
      deployNote =
        'Auto-optimized for Node 24: uses npx tsx directly (Vite middleware handles HMR)';
    } else {
      deployNote = `${serverName} API with embedded Vite middleware`;
    }
  } else if (has('next')) {
    framework = 'Next.js';
    programType = 'Full-Stack React Framework';
    defaultPort = detectedPort || 3000;
    recommendedCommand = scripts.dev ? formatPmScript(pm, 'dev') : chooseSuggestedCommand(scripts, pm);
    deployNote = 'Next.js integrated dev server';
  } else if (has('astro')) {
    framework = 'Astro';
    programType = 'Content & Web Framework';
    defaultPort = detectedPort || 4321;
  } else if (has('@remix-run/dev') || has('@react-router/dev')) {
    framework = 'Remix';
    programType = 'Full-Stack React Framework';
    defaultPort = detectedPort || 3000;
  } else if (has('nuxt')) {
    framework = 'Nuxt';
    programType = 'Full-Stack Vue Framework';
    defaultPort = detectedPort || 3000;
  } else if (has('@sveltejs/kit') || has('svelte')) {
    framework = has('@sveltejs/kit') ? 'SvelteKit' : 'Svelte';
    programType = 'Full-Stack Svelte App';
    defaultPort = detectedPort || 5173;
  } else if (has('@solidjs/start') || has('solid-start')) {
    framework = 'SolidStart';
    programType = 'Full-Stack Solid Framework';
    defaultPort = detectedPort || 3000;
  } else if (has('@builder.io/qwik-city') || has('@builder.io/qwik')) {
    framework = 'Qwik';
    programType = 'Resumable Web Framework';
    defaultPort = detectedPort || 5173;
  } else if (has('gatsby')) {
    framework = 'Gatsby';
    programType = 'React Static & SSR Site';
    defaultPort = detectedPort || 8000;
    if (!scripts.dev && scripts.develop) recommendedCommand = formatPmScript(pm, 'develop');
  } else if (has('@11ty/eleventy')) {
    framework = 'Eleventy (11ty)';
    programType = 'Static Site Generator';
    defaultPort = detectedPort || 8080;
  } else if (has('@docusaurus/core')) {
    framework = 'Docusaurus';
    programType = 'Documentation Site';
    defaultPort = detectedPort || 3000;
  } else if (has('vitepress') || has('vuepress')) {
    framework = has('vitepress') ? 'VitePress' : 'VuePress';
    programType = 'Documentation Site';
    defaultPort = detectedPort || (has('vitepress') ? 5173 : 8080);
  } else if (has('@storybook/react') || has('@storybook/vue3') || has('@storybook/html') || has('storybook')) {
    framework = 'Storybook';
    programType = 'UI Component Workshop';
    defaultPort = detectedPort || 6006;
    if (scripts.storybook && !scripts.dev) recommendedCommand = formatPmScript(pm, 'storybook');
  } else if (has('@strapi/strapi')) {
    framework = 'Strapi';
    programType = 'Headless CMS';
    defaultPort = detectedPort || 1337;
    if (scripts.develop && !scripts.dev) recommendedCommand = formatPmScript(pm, 'develop');
  } else if (has('@angular/core')) {
    framework = 'Angular';
    programType = 'Frontend Application';
    defaultPort = detectedPort || 4200;
    if (scripts.start && !scripts.dev) recommendedCommand = formatPmScript(pm, 'start');
  } else if (has('vite')) {
    framework = 'Vite';
    programType = 'Frontend SPA';
    defaultPort = detectedPort || 5173;
  } else if (has('parcel')) {
    framework = 'Parcel';
    programType = 'Frontend Bundle';
    defaultPort = detectedPort || 1234;
  } else if (has('webpack-dev-server')) {
    framework = 'Webpack';
    programType = 'Frontend Application';
    defaultPort = detectedPort || 8080;
  } else if (has('react-scripts')) {
    framework = 'Create React App';
    programType = 'Frontend SPA';
    defaultPort = detectedPort || 3000;
    if (scripts.start) recommendedCommand = formatPmScript(pm, 'start');
  } else if (hasBackendServer) {
    framework = has('@nestjs/core')
      ? 'NestJS'
      : has('@adonisjs/core')
        ? 'AdonisJS'
        : has('fastify')
          ? 'Fastify'
          : has('hono')
            ? 'Hono'
            : has('koa')
              ? 'Koa'
              : 'Express';
    programType = language === 'TypeScript' ? 'TypeScript API Server' : 'Node.js API Server';
    defaultPort = detectedPort || (has('@adonisjs/core') ? 3333 : 3000);
  } else if (has('solid-js')) {
    framework = 'SolidJS';
    programType = 'Frontend Application';
    defaultPort = detectedPort || 3000;
  } else if (has('vue')) {
    framework = 'Vue';
    programType = 'Frontend Application';
    defaultPort = detectedPort || 5173;
  } else if (has('react')) {
    framework = 'React';
    programType = 'Frontend Application';
    defaultPort = detectedPort || 3000;
  } else if (hasAnyHtml && Object.keys(scripts).length === 0) {
    framework = 'Static HTML';
    programType = 'Static Website';
    defaultPort = detectedPort || 8080;
    recommendedCommand = `node "${STATIC_SERVER_SCRIPT}"`;
    deployNote = 'Served with built-in static web server';
  }

  return {
    language,
    framework,
    programType,
    techStack,
    defaultPort,
    packageManager: pm,
    scripts,
    suggestedCommand: recommendedCommand,
    recommendedCommand,
    deployNote
  };
}

function analyzeDenoProject(dirPath) {
  const denoFile = findFirstExisting(dirPath, ['deno.json', 'deno.jsonc']);
  if (!denoFile) return null;

  const raw = readTextSafe(path.join(dirPath, denoFile));
  let parsed = {};
  try {
    const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    parsed = JSON.parse(stripped || '{}');
  } catch {
    parsed = {};
  }

  const tasks = parsed.tasks && typeof parsed.tasks === 'object' ? parsed.tasks : {};
  const lower = raw.toLowerCase();
  const framework = lower.includes('fresh')
    ? 'Fresh'
    : lower.includes('hono')
      ? 'Hono'
      : lower.includes('oak')
        ? 'Oak'
        : 'Deno';

  let recommendedCommand = 'deno task dev';
  if (tasks.dev) recommendedCommand = 'deno task dev';
  else if (tasks.start) recommendedCommand = 'deno task start';
  else if (Object.keys(tasks).length > 0) recommendedCommand = `deno task ${Object.keys(tasks)[0]}`;
  else {
    const entry = findFirstExisting(dirPath, ['main.ts', 'server.ts', 'dev.ts', 'mod.ts', 'main.js']);
    if (entry) recommendedCommand = `deno run --allow-net --allow-read --allow-env ${entry}`;
  }

  return {
    language: 'TypeScript (Deno)',
    framework,
    programType: 'Deno Web Application',
    techStack: ['Deno', 'TypeScript', framework].slice(0, 4),
    defaultPort: readPortFromEnvFile(dirPath) || 8000,
    scripts: {},
    suggestedCommand: recommendedCommand,
    recommendedCommand,
    deployNote: `Deno runtime (${denoFile})`
  };
}

function analyzePythonProject(dirPath) {
  const pyBin = process.platform === 'win32' ? 'python' : 'python3';
  const manifestText = [
    readTextSafe(path.join(dirPath, 'pyproject.toml')),
    readTextSafe(path.join(dirPath, 'requirements.txt')),
    readTextSafe(path.join(dirPath, 'Pipfile'))
  ]
    .join('\n')
    .toLowerCase();

  const managePy = path.join(dirPath, 'manage.py');
  if (fs.existsSync(managePy)) {
    return {
      language: 'Python',
      framework: 'Django',
      programType: 'Python Web App',
      techStack: ['Python', 'Django'],
      defaultPort: readPortFromEnvFile(dirPath) || 8000,
      scripts: {},
      suggestedCommand: `${pyBin} manage.py runserver`,
      recommendedCommand: `${pyBin} manage.py runserver`,
      deployNote: 'Django development server (auto-uses .venv if present)'
    };
  }

  if (fs.existsSync(path.join(dirPath, 'rxconfig.py')) || manifestText.includes('reflex')) {
    return {
      language: 'Python',
      framework: 'Reflex',
      programType: 'Full-Stack Python App',
      techStack: ['Python', 'Reflex'],
      defaultPort: 3000,
      scripts: {},
      suggestedCommand: 'reflex run',
      recommendedCommand: 'reflex run',
      deployNote: 'Reflex reactive Python web app'
    };
  }

  if (fs.existsSync(path.join(dirPath, 'mkdocs.yml')) || manifestText.includes('mkdocs')) {
    return {
      language: 'Python',
      framework: 'MkDocs',
      programType: 'Python Docs Site',
      techStack: ['Python', 'MkDocs'],
      defaultPort: 8000,
      scripts: {},
      suggestedCommand: 'mkdocs serve',
      recommendedCommand: 'mkdocs serve',
      deployNote: 'MkDocs live documentation server'
    };
  }

  const entryFile = findFirstExisting(dirPath, [
    'app.py',
    'main.py',
    'server.py',
    'run.py',
    'wsgi.py',
    'asgi.py'
  ]);

  if (!entryFile && !manifestText.trim()) return null;

  const entryText = entryFile ? readTextSafe(path.join(dirPath, entryFile)).toLowerCase() : '';
  const combined = `${entryText}\n${manifestText}`;
  const stem = entryFile ? path.basename(entryFile, '.py') : 'main';
  const targetPy = entryFile || 'app.py';

  if (combined.includes('streamlit')) {
    return {
      language: 'Python',
      framework: 'Streamlit',
      programType: 'Python Data App',
      techStack: ['Python', 'Streamlit'],
      defaultPort: 8501,
      scripts: {},
      suggestedCommand: `streamlit run ${targetPy}`,
      recommendedCommand: `streamlit run ${targetPy}`,
      deployNote: 'Streamlit interactive web app'
    };
  }

  if (combined.includes('gradio')) {
    return {
      language: 'Python',
      framework: 'Gradio',
      programType: 'Python AI / UI App',
      techStack: ['Python', 'Gradio'],
      defaultPort: 7860,
      scripts: {},
      suggestedCommand: `${pyBin} ${targetPy}`,
      recommendedCommand: `${pyBin} ${targetPy}`,
      deployNote: 'Gradio web interface (GRADIO_SERVER_PORT injected)'
    };
  }

  if (/\bdash\b/.test(combined)) {
    return {
      language: 'Python',
      framework: 'Plotly Dash',
      programType: 'Python Analytics App',
      techStack: ['Python', 'Dash'],
      defaultPort: 8050,
      scripts: {},
      suggestedCommand: `${pyBin} ${targetPy}`,
      recommendedCommand: `${pyBin} ${targetPy}`,
      deployNote: 'Plotly Dash server'
    };
  }

  if (combined.includes('nicegui')) {
    return {
      language: 'Python',
      framework: 'NiceGUI',
      programType: 'Python Web UI',
      techStack: ['Python', 'NiceGUI'],
      defaultPort: 8080,
      scripts: {},
      suggestedCommand: `${pyBin} ${targetPy}`,
      recommendedCommand: `${pyBin} ${targetPy}`,
      deployNote: 'NiceGUI web application'
    };
  }

  if (combined.includes('fastapi') || combined.includes('litestar') || combined.includes('starlette') || combined.includes('uvicorn')) {
    const fw = combined.includes('litestar')
      ? 'Litestar'
      : combined.includes('starlette') && !combined.includes('fastapi')
        ? 'Starlette'
        : 'FastAPI';
    return {
      language: 'Python',
      framework: fw,
      programType: 'Python ASGI Server',
      techStack: ['Python', fw, 'Uvicorn'],
      defaultPort: 8000,
      scripts: {},
      suggestedCommand: `uvicorn ${stem}:app --reload`,
      recommendedCommand: `uvicorn ${stem}:app --reload`,
      deployNote: `${fw} + Uvicorn ASGI server`
    };
  }

  if (combined.includes('quart') || combined.includes('flask')) {
    const fw = combined.includes('quart') && !combined.includes('flask') ? 'Quart' : 'Flask';
    return {
      language: 'Python',
      framework: fw,
      programType: 'Python Web App',
      techStack: ['Python', fw],
      defaultPort: 5000,
      scripts: {},
      suggestedCommand: `${pyBin} ${targetPy}`,
      recommendedCommand: `${pyBin} ${targetPy}`,
      deployNote: `${fw} development server`
    };
  }

  if (entryFile) {
    const fw = combined.includes('tornado')
      ? 'Tornado'
      : combined.includes('sanic')
        ? 'Sanic'
        : combined.includes('aiohttp')
          ? 'aiohttp'
          : combined.includes('bottle')
            ? 'Bottle'
            : 'Python';
    return {
      language: 'Python',
      framework: fw,
      programType: 'Python Web App',
      techStack: ['Python', fw].filter((v, i, a) => a.indexOf(v) === i),
      defaultPort: readPortFromEnvFile(dirPath) || 8000,
      scripts: {},
      suggestedCommand: `${pyBin} ${entryFile}`,
      recommendedCommand: `${pyBin} ${entryFile}`,
      deployNote: `Runs ${entryFile} (auto-uses .venv if present)`
    };
  }

  return null;
}

function analyzeGoProject(dirPath) {
  const hugoConfig = findFirstExisting(dirPath, [
    'hugo.toml',
    'hugo.yaml',
    'hugo.json',
    'hugo.yml'
  ]);
  if (hugoConfig) {
    return {
      language: 'Go / Hugo',
      framework: 'Hugo',
      programType: 'Static Site Generator',
      techStack: ['Hugo', 'Go Templates'],
      defaultPort: 1313,
      scripts: {},
      suggestedCommand: 'hugo server -D',
      recommendedCommand: 'hugo server -D',
      deployNote: 'Hugo live-reload site server'
    };
  }

  const goModPath = path.join(dirPath, 'go.mod');
  const mainGoPath = path.join(dirPath, 'main.go');
  if (!fs.existsSync(goModPath) && !fs.existsSync(mainGoPath)) return null;

  const goMod = readTextSafe(goModPath).toLowerCase();
  const mainGo = readTextSafe(mainGoPath).toLowerCase();
  const combined = `${goMod}\n${mainGo}`;

  const framework = combined.includes('gin-gonic/gin')
    ? 'Gin'
    : combined.includes('gofiber/fiber')
      ? 'Fiber'
      : combined.includes('labstack/echo')
        ? 'Echo'
        : combined.includes('go-chi/chi')
          ? 'Chi'
          : 'Go net/http';

  const hasAir = fs.existsSync(path.join(dirPath, '.air.toml'));
  const cmd = hasAir ? 'air' : fs.existsSync(goModPath) ? 'go run .' : 'go run main.go';

  return {
    language: 'Go',
    framework,
    programType: 'Go Web Server',
    techStack: ['Go', framework].filter((v, i, a) => a.indexOf(v) === i),
    defaultPort: readPortFromEnvFile(dirPath) || 8080,
    scripts: {},
    suggestedCommand: cmd,
    recommendedCommand: cmd,
    deployNote: hasAir ? 'Hot reload with Air' : 'Runs compiled Go dev server (PORT env set)'
  };
}

function analyzeRustProject(dirPath) {
  const zolaCfg = path.join(dirPath, 'config.toml');
  if (fs.existsSync(zolaCfg)) {
    const zolaText = readTextSafe(zolaCfg).toLowerCase();
    if (zolaText.includes('base_url') && !fs.existsSync(path.join(dirPath, 'Cargo.toml'))) {
      return {
        language: 'Rust / Zola',
        framework: 'Zola',
        programType: 'Static Site Generator',
        techStack: ['Zola', 'Rust'],
        defaultPort: 1111,
        scripts: {},
        suggestedCommand: 'zola serve',
        recommendedCommand: 'zola serve',
        deployNote: 'Zola static site dev server'
      };
    }
  }

  const cargoPath = path.join(dirPath, 'Cargo.toml');
  if (!fs.existsSync(cargoPath)) return null;

  const cargo = readTextSafe(cargoPath).toLowerCase();
  const hasTrunk = fs.existsSync(path.join(dirPath, 'Trunk.toml'));

  if (hasTrunk || cargo.includes('leptos') || cargo.includes('yew')) {
    const fw = cargo.includes('leptos') ? 'Leptos' : cargo.includes('yew') ? 'Yew' : 'Trunk WASM';
    return {
      language: 'Rust',
      framework: fw,
      programType: 'Rust WASM Web App',
      techStack: ['Rust', fw, 'WebAssembly'],
      defaultPort: 8080,
      scripts: {},
      suggestedCommand: 'trunk serve',
      recommendedCommand: 'trunk serve',
      deployNote: 'Rust WebAssembly bundle via Trunk'
    };
  }

  if (cargo.includes('dioxus')) {
    return {
      language: 'Rust',
      framework: 'Dioxus',
      programType: 'Rust Full-Stack / Web App',
      techStack: ['Rust', 'Dioxus'],
      defaultPort: 8080,
      scripts: {},
      suggestedCommand: 'dx serve',
      recommendedCommand: 'dx serve',
      deployNote: 'Dioxus CLI web dev server'
    };
  }

  const fw = cargo.includes('axum')
    ? 'Axum'
    : cargo.includes('actix-web')
      ? 'Actix Web'
      : cargo.includes('rocket')
        ? 'Rocket'
        : cargo.includes('warp')
          ? 'Warp'
          : cargo.includes('poem')
            ? 'Poem'
            : 'Cargo';

  return {
    language: 'Rust',
    framework: fw,
    programType: 'Rust Web Server',
    techStack: ['Rust', fw].filter((v, i, a) => a.indexOf(v) === i),
    defaultPort: cargo.includes('axum') ? 3000 : cargo.includes('rocket') ? 8000 : 8080,
    scripts: {},
    suggestedCommand: 'cargo run',
    recommendedCommand: 'cargo run',
    deployNote: 'Builds & runs Rust binary via Cargo'
  };
}

function analyzePhpProject(dirPath) {
  if (fs.existsSync(path.join(dirPath, 'artisan'))) {
    return {
      language: 'PHP',
      framework: 'Laravel',
      programType: 'PHP Web Framework',
      techStack: ['PHP', 'Laravel'],
      defaultPort: readPortFromEnvFile(dirPath) || 8000,
      scripts: {},
      suggestedCommand: 'php artisan serve',
      recommendedCommand: 'php artisan serve',
      deployNote: 'Laravel Artisan development server'
    };
  }

  const composerPath = path.join(dirPath, 'composer.json');
  const publicIndex = path.join(dirPath, 'public', 'index.php');
  const rootIndex = path.join(dirPath, 'index.php');
  const hasComposer = fs.existsSync(composerPath);
  const hasPublicIndex = fs.existsSync(publicIndex);
  const hasRootIndex = fs.existsSync(rootIndex);

  if (!hasComposer && !hasPublicIndex && !hasRootIndex) return null;

  const composer = readTextSafe(composerPath).toLowerCase();
  const framework = composer.includes('symfony/')
    ? 'Symfony'
    : composer.includes('slim/')
      ? 'Slim'
      : fs.existsSync(path.join(dirPath, 'wp-config.php')) || fs.existsSync(path.join(dirPath, 'wp-login.php'))
        ? 'WordPress'
        : 'PHP';

  const docRootArg = hasPublicIndex && !hasRootIndex ? ' -t public' : '';
  const cmd = `php -S localhost:8000${docRootArg}`;

  return {
    language: 'PHP',
    framework,
    programType: 'PHP Web App',
    techStack: ['PHP', framework].filter((v, i, a) => a.indexOf(v) === i),
    defaultPort: 8000,
    scripts: {},
    suggestedCommand: cmd,
    recommendedCommand: cmd,
    deployNote: 'PHP built-in local web server'
  };
}

function analyzeRubyProject(dirPath) {
  const gemfilePath = path.join(dirPath, 'Gemfile');
  const hasGemfile = fs.existsSync(gemfilePath);
  const hasRails = fs.existsSync(path.join(dirPath, 'bin', 'rails'));
  const hasJekyllConfig = fs.existsSync(path.join(dirPath, '_config.yml'));
  const hasConfigRu = fs.existsSync(path.join(dirPath, 'config.ru'));
  const hasAppRb = fs.existsSync(path.join(dirPath, 'app.rb'));

  if (!hasGemfile && !hasRails && !hasConfigRu && !hasAppRb && !hasJekyllConfig) return null;

  const gemfile = readTextSafe(gemfilePath).toLowerCase();
  if (hasRails || gemfile.includes('rails')) {
    return {
      language: 'Ruby',
      framework: 'Ruby on Rails',
      programType: 'Full-Stack Ruby App',
      techStack: ['Ruby', 'Rails'],
      defaultPort: 3000,
      scripts: {},
      suggestedCommand: 'bundle exec rails server',
      recommendedCommand: 'bundle exec rails server',
      deployNote: 'Rails Puma development server'
    };
  }

  if (hasJekyllConfig || gemfile.includes('jekyll')) {
    return {
      language: 'Ruby / Jekyll',
      framework: 'Jekyll',
      programType: 'Static Site Generator',
      techStack: ['Ruby', 'Jekyll'],
      defaultPort: 4000,
      scripts: {},
      suggestedCommand: hasGemfile ? 'bundle exec jekyll serve' : 'jekyll serve',
      recommendedCommand: hasGemfile ? 'bundle exec jekyll serve' : 'jekyll serve',
      deployNote: 'Jekyll local dev server'
    };
  }

  if (gemfile.includes('sinatra') || hasConfigRu || hasAppRb) {
    const fw = gemfile.includes('sinatra') ? 'Sinatra' : 'Rack / Ruby';
    const cmd = hasConfigRu
      ? hasGemfile
        ? 'bundle exec rackup'
        : 'rackup'
      : `ruby ${hasAppRb ? 'app.rb' : 'server.rb'}`;
    return {
      language: 'Ruby',
      framework: fw,
      programType: 'Ruby Web App',
      techStack: ['Ruby', fw],
      defaultPort: hasConfigRu ? 9292 : 4567,
      scripts: {},
      suggestedCommand: cmd,
      recommendedCommand: cmd,
      deployNote: `${fw} local server`
    };
  }

  return null;
}

function analyzeJvmProject(dirPath) {
  const pomPath = path.join(dirPath, 'pom.xml');
  const gradlePath = path.join(dirPath, 'build.gradle');
  const gradleKtsPath = path.join(dirPath, 'build.gradle.kts');

  const isMaven = fs.existsSync(pomPath);
  const isGradle = fs.existsSync(gradlePath) || fs.existsSync(gradleKtsPath);
  if (!isMaven && !isGradle) return null;

  const manifest = `${readTextSafe(pomPath)}\n${readTextSafe(gradlePath)}\n${readTextSafe(gradleKtsPath)}`.toLowerCase();
  const isKotlin = fs.existsSync(gradleKtsPath) || manifest.includes('kotlin');
  const language = isKotlin ? 'Kotlin' : 'Java';

  const fw = manifest.includes('spring-boot')
    ? 'Spring Boot'
    : manifest.includes('quarkus')
      ? 'Quarkus'
      : manifest.includes('micronaut')
        ? 'Micronaut'
        : manifest.includes('ktor')
          ? 'Ktor'
          : isMaven
            ? 'Maven Web App'
            : 'Gradle Web App';

  let cmd = 'mvn spring-boot:run';
  if (isMaven) {
    const wrapper = fs.existsSync(path.join(dirPath, process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw'))
      ? process.platform === 'win32'
        ? 'mvnw.cmd'
        : './mvnw'
      : 'mvn';
    cmd = fw === 'Quarkus' ? `${wrapper} quarkus:dev` : `${wrapper} spring-boot:run`;
  } else {
    const wrapper = fs.existsSync(path.join(dirPath, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew'))
      ? process.platform === 'win32'
        ? 'gradlew.bat'
        : './gradlew'
      : 'gradle';
    cmd = fw === 'Spring Boot' ? `${wrapper} bootRun` : `${wrapper} run`;
  }

  return {
    language,
    framework: fw,
    programType: `${language} Web Service`,
    techStack: [language, fw],
    defaultPort: readPortFromEnvFile(dirPath) || 8080,
    scripts: {},
    suggestedCommand: cmd,
    recommendedCommand: cmd,
    deployNote: `${isMaven ? 'Maven' : 'Gradle'} development runner`
  };
}

function analyzeDotNetProject(dirPath) {
  const projFile = findFileByExt(dirPath, ['.csproj', '.fsproj']);
  if (!projFile) return null;

  const projText = readTextSafe(path.join(dirPath, projFile)).toLowerCase();
  const launchSettings = readTextSafe(path.join(dirPath, 'Properties', 'launchSettings.json'));
  const urlMatch = launchSettings.match(/https?:\/\/localhost:(\d{2,5})/i);
  const detectedPort = urlMatch ? Number(urlMatch[1]) : 5000;

  const isFSharp = projFile.toLowerCase().endsWith('.fsproj');
  const language = isFSharp ? 'F#' : 'C#';
  const fw = projText.includes('blazor') || projText.includes('microsoft.aspnetcore.components.webassembly')
    ? 'Blazor'
    : 'ASP.NET Core';

  return {
    language,
    framework: fw,
    programType: '.NET Web Application',
    techStack: [language, '.NET', fw],
    defaultPort: detectedPort,
    scripts: {},
    suggestedCommand: 'dotnet watch run',
    recommendedCommand: 'dotnet watch run',
    deployNote: '.NET hot-reload web runner (ASPNETCORE_URLS injected)'
  };
}

function analyzeElixirProject(dirPath) {
  const mixPath = path.join(dirPath, 'mix.exs');
  if (!fs.existsSync(mixPath)) return null;
  const mix = readTextSafe(mixPath).toLowerCase();
  const isPhoenix = mix.includes(':phoenix');
  return {
    language: 'Elixir',
    framework: isPhoenix ? 'Phoenix' : 'Elixir / Plug',
    programType: 'Elixir Web Application',
    techStack: ['Elixir', isPhoenix ? 'Phoenix' : 'OTP'],
    defaultPort: 4000,
    scripts: {},
    suggestedCommand: isPhoenix ? 'mix phx.server' : 'mix run --no-halt',
    recommendedCommand: isPhoenix ? 'mix phx.server' : 'mix run --no-halt',
    deployNote: isPhoenix ? 'Phoenix LiveReload server' : 'Mix application runner'
  };
}

function analyzeFlutterProject(dirPath) {
  const pubspecPath = path.join(dirPath, 'pubspec.yaml');
  if (!fs.existsSync(pubspecPath)) return null;
  const pubspec = readTextSafe(pubspecPath).toLowerCase();
  if (!pubspec.includes('flutter:') && !pubspec.includes('dart')) return null;

  return {
    language: 'Dart',
    framework: 'Flutter Web',
    programType: 'Flutter Web App',
    techStack: ['Dart', 'Flutter'],
    defaultPort: 8080,
    scripts: {},
    suggestedCommand: 'flutter run -d web-server --web-port 8080',
    recommendedCommand: 'flutter run -d web-server --web-port 8080',
    deployNote: 'Flutter Web development server'
  };
}

function analyzeDockerProject(dirPath) {
  const composeFile = findFirstExisting(dirPath, [
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
    'compose.yaml'
  ]);
  if (!composeFile) return null;

  const content = readTextSafe(path.join(dirPath, composeFile));
  const portMatch = content.match(/["']?(\d{2,5}):\d{2,5}["']?/);
  return {
    language: 'Docker',
    framework: 'Docker Compose',
    programType: 'Containerized Web App',
    techStack: ['Docker', 'Compose'],
    defaultPort: portMatch ? Number(portMatch[1]) : 8080,
    scripts: {},
    suggestedCommand: 'docker compose up',
    recommendedCommand: 'docker compose up',
    deployNote: `Container stack (${composeFile})`
  };
}

function inspectProjectPath(rawPath) {
  const cleaned = cleanPathInput(rawPath);
  if (!cleaned) {
    return { valid: false, error: 'Project path is required.' };
  }

  const resolved = path.resolve(cleaned);
  if (!fs.existsSync(resolved)) {
    return { valid: false, error: `Path does not exist: ${resolved}` };
  }

  let dirPath = resolved;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      dirPath = path.dirname(resolved);
    }
  } catch (err) {
    return { valid: false, error: `Cannot access path: ${err.message}` };
  }

  const pkgPath = path.join(dirPath, 'package.json');
  const htmlEntry = findFirstExisting(dirPath, ['index.html', 'index.htm', 'home.html', 'main.html']) ||
    findFileByExt(dirPath, ['.html', '.htm']);
  const hasPackageJson = fs.existsSync(pkgPath);
  const hasAnyHtml = Boolean(htmlEntry);

  let name = path.basename(dirPath) || dirPath;

  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(readTextSafe(pkgPath));
      if (pkg.name && typeof pkg.name === 'string') {
        name = pkg.name.trim() || name;
      }
      const analysis = analyzeNodePackage(dirPath, pkg, hasAnyHtml);
      return {
        valid: true,
        resolvedPath: dirPath,
        name,
        hasPackageJson: true,
        hasIndexHtml: hasAnyHtml,
        ...analysis
      };
    } catch (err) {
      return {
        valid: true,
        resolvedPath: dirPath,
        name,
        language: 'JavaScript',
        framework: 'Node.js',
        programType: 'Node.js Web App',
        techStack: [],
        defaultPort: 3000,
        scripts: {},
        suggestedCommand: 'npm run dev',
        recommendedCommand: 'npm run dev',
        deployNote: '',
        hasPackageJson: true,
        hasIndexHtml: hasAnyHtml,
        warning: `Failed to parse package.json: ${err.message}`
      };
    }
  }

  const languageAnalyzers = [
    analyzeDenoProject,
    analyzePythonProject,
    analyzeGoProject,
    analyzeRustProject,
    analyzePhpProject,
    analyzeRubyProject,
    analyzeJvmProject,
    analyzeDotNetProject,
    analyzeElixirProject,
    analyzeFlutterProject,
    analyzeDockerProject
  ];

  for (const analyzeFn of languageAnalyzers) {
    const analysis = analyzeFn(dirPath);
    if (analysis) {
      return {
        valid: true,
        resolvedPath: dirPath,
        name,
        hasPackageJson: false,
        hasIndexHtml: hasAnyHtml,
        ...analysis
      };
    }
  }

  if (hasAnyHtml) {
    return {
      valid: true,
      resolvedPath: dirPath,
      name,
      language: 'HTML / CSS',
      framework: 'Static HTML',
      programType: 'Static Website',
      techStack: ['HTML5', 'CSS', 'Static Assets'],
      defaultPort: 8080,
      scripts: {},
      suggestedCommand: `node "${STATIC_SERVER_SCRIPT}"`,
      recommendedCommand: `node "${STATIC_SERVER_SCRIPT}"`,
      deployNote: `Served with built-in zero-dependency static server (${htmlEntry})`,
      hasPackageJson: false,
      hasIndexHtml: true
    };
  }

  return {
    valid: true,
    resolvedPath: dirPath,
    name,
    language: 'Custom',
    framework: 'Custom',
    programType: 'Custom App',
    techStack: [],
    defaultPort: 3000,
    scripts: {},
    suggestedCommand: 'npm run dev',
    recommendedCommand: 'npm run dev',
    deployNote: '',
    hasPackageJson: false,
    hasIndexHtml: false
  };
}

function createInitialRuntimeState() {
  return {
    status: 'stopped',
    pid: null,
    startedAt: null,
    exitCode: null,
    detectedUrl: null,
    assignedPort: null,
    stopping: false,
    process: null,
    probeTimer: null,
    logs: [],
    // Set while a start is in progress (port search + spawn) so a second Start waits for it
    // instead of spawning a second, untracked server.
    startPromise: null,
    // Set while a stop is in progress; resolves when the child has really exited.
    stopPromise: null,
    // Resolves when the current child process exits (or fails to spawn).
    exitPromise: null,
    // Last few stderr/stdout lines, used to explain a crash on the card.
    lastErrorLine: null,
    crashReason: null,
    // Port we warned is in use by another program (custom ports only).
    portConflict: false,
    hasLog: undefined
  };
}

/** Clears everything about a run, leaving the project in `status`. */
function resetRuntimeState(state, status) {
  clearProbeTimer(state);
  state.status = status;
  state.pid = null;
  state.startedAt = null;
  state.detectedUrl = null;
  state.assignedPort = null;
  state.process = null;
  state.exitPromise = null;
  state.stopping = false;
  state.portConflict = false;
}

function getRuntimeState(id) {
  let state = runtimeState.get(id);
  if (!state) {
    state = createInitialRuntimeState();
    runtimeState.set(id, state);
  }
  return state;
}

function getLogFileBaseName(id) {
  const raw = String(id || '');
  // Project ids normally are UUIDs. Anything else (for example an id from an old or
  // hand-edited config) is hashed so it can never point outside the logs folder.
  return SAFE_ID_REGEX.test(raw)
    ? raw
    : `id-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function getLogFilePath(id) {
  const target = path.join(LOGS_DIR, `${getLogFileBaseName(id)}.log`);
  const rel = path.relative(LOGS_DIR, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Invalid project id.');
    err.statusCode = 400;
    throw err;
  }
  return target;
}

function getRotatedLogFilePath(id) {
  return path.join(LOGS_DIR, `${getLogFileBaseName(id)}.1.log`);
}

function saveProjects() {
  ensureDirectories();
  writeJsonAtomic(PROJECTS_FILE, projects);
}

const PROJECT_MARKER_FILES = [
  'package.json',
  'deno.json',
  'deno.jsonc',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'manage.py',
  'app.py',
  'main.py',
  'rxconfig.py',
  'mkdocs.yml',
  'go.mod',
  'main.go',
  'hugo.toml',
  'hugo.yaml',
  'Cargo.toml',
  'Trunk.toml',
  'composer.json',
  'artisan',
  'index.php',
  'Gemfile',
  '_config.yml',
  'config.ru',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'mix.exs',
  'pubspec.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'index.html'
];

function isSupportedProjectDir(dirPath) {
  if (PROJECT_MARKER_FILES.some((f) => fs.existsSync(path.join(dirPath, f)))) {
    return true;
  }
  return Boolean(findFileByExt(dirPath, ['.csproj', '.fsproj', '.html', '.htm']));
}

function scanDirectoryForProjects(parentDir) {
  const discovered = [];
  if (!fs.existsSync(parentDir)) return discovered;

  let entries = [];
  try {
    entries = fs.readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return discovered;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

    const fullPath = path.join(parentDir, entry.name);
    if (normalizePathKey(fullPath) === normalizePathKey(ROOT_DIR)) continue;

    if (isSupportedProjectDir(fullPath)) {
      discovered.push(fullPath);
    }
  }

  return discovered;
}

function applyInspectionToProject(project, inspection, overrideCommand = false) {
  project.language = inspection.language;
  project.framework = inspection.framework;
  project.programType = inspection.programType;
  project.techStack = inspection.techStack || [];
  project.defaultPort = inspection.defaultPort || 3000;
  project.recommendedCommand = inspection.recommendedCommand || inspection.suggestedCommand;
  project.deployNote = inspection.deployNote || '';
  project.scripts = inspection.scripts || {};

  if (overrideCommand && project.recommendedCommand) {
    project.command = project.recommendedCommand;
  }
}

function normalizePortInput(raw) {
  if (raw === undefined || raw === null) return '';
  const str = String(raw).trim();
  if (str === '') return '';
  const num = Number(str);
  if (!/^\d+$/.test(str) || num < 1 || num > 65535) {
    const err = new Error(`Invalid port "${str}". Use a number between 1 and 65535.`);
    err.statusCode = 400;
    throw err;
  }
  return String(num);
}

// Config files may come from other machines: drop bad ports instead of failing the import.
function lenientPort(raw) {
  try {
    return normalizePortInput(raw);
  } catch {
    return '';
  }
}

/**
 * Finds a project that would clash with a new one at this path. Stand-alone projects are
 * unique per folder. Services of a stack may share a folder (a Procfile's web and worker),
 * but not the same folder and command twice in one stack.
 */
function findDuplicateProject(resolvedPath, { stackId = null, command = null, excludeId = null } = {}) {
  const key = normalizePathKey(resolvedPath);
  return projects.find((p) => {
    if (p.id === excludeId || normalizePathKey(p.path) !== key) return false;
    if (!stackId) return !p.stackId;
    return p.stackId === stackId && command !== null && p.command === command;
  });
}

function createProjectRecord({
  path: rawPath,
  name,
  command,
  customPort,
  stackId,
  kind,
  hostname,
  _deferSave
}) {
  const inspection = inspectProjectPath(rawPath);
  if (!inspection.valid) {
    const err = new Error(inspection.error);
    err.statusCode = 400;
    throw err;
  }

  const finalCommand =
    command && String(command).trim()
      ? String(command).trim()
      : inspection.recommendedCommand || inspection.suggestedCommand;
  const duplicate = findDuplicateProject(inspection.resolvedPath, {
    stackId: stackId || null,
    command: finalCommand
  });
  if (duplicate) {
    const err = new Error(
      stackId
        ? `This stack already runs "${finalCommand}" in ${duplicate.path} (${duplicate.name}).`
        : `Project already registered: ${duplicate.name} (${duplicate.path})`
    );
    err.statusCode = 409;
    throw err;
  }
  if (stackId && !stacks.some((s) => s.id === stackId)) {
    const err = new Error('Stack not found.');
    err.statusCode = 404;
    throw err;
  }

  const portStr = normalizePortInput(customPort);

  const record = {
    id: crypto.randomUUID(),
    name: name && String(name).trim() ? String(name).trim() : inspection.name,
    path: inspection.resolvedPath,
    command: finalCommand,
    customPort: portStr,
    createdAt: new Date().toISOString(),
    lastStartedAt: null
  };
  if (stackId) {
    record.stackId = stackId;
    record.startAfter = [];
  }
  if (kind !== undefined) record.kind = cleanServiceKind(kind);
  record.hostname =
    hostname && String(hostname).trim()
      ? claimHostname(hostname, { projectId: record.id })
      : defaultHostnameFor(record);

  applyInspectionToProject(record, inspection, false);

  projects.push(record);
  getRuntimeState(record.id);
  if (!_deferSave) saveProjects();
  return record;
}

function readProjectsFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('projects.json does not contain a list of projects.');
  }
  return parsed.filter((p) => p && typeof p === 'object' && typeof p.path === 'string');
}

function loadOrSeedProjects() {
  ensureDirectories();
  const backupFile = `${PROJECTS_FILE}.bak`;

  if (fs.existsSync(PROJECTS_FILE)) {
    let loaded = null;
    try {
      loaded = readProjectsFile(PROJECTS_FILE);
      // This file parsed fine, so keep it as the last known good copy.
      try {
        fs.copyFileSync(PROJECTS_FILE, backupFile);
      } catch {
        // backup is best effort
      }
    } catch (err) {
      console.error('Failed to read projects.json:', err.message);
      const movedTo = quarantineCorruptFile(PROJECTS_FILE);
      let restored = null;
      if (fs.existsSync(backupFile)) {
        try {
          restored = readProjectsFile(backupFile);
        } catch {
          restored = null;
        }
      }
      if (restored) {
        loaded = restored;
        startupNotices.push({
          level: 'warning',
          message: `Your project list was damaged, so Portly restored it from the last backup (${restored.length} project${restored.length === 1 ? '' : 's'}).${movedTo ? ` The damaged file was kept at ${movedTo}.` : ''}`
        });
      } else {
        loaded = [];
        startupNotices.push({
          level: 'error',
          message: `Portly couldn't read your project list and found no backup, so it started empty.${movedTo ? ` The damaged file was kept at ${movedTo}.` : ''}`
        });
      }
    }

    projects = loaded;
    const before = JSON.stringify(projects);
    for (const p of projects) {
      if (!p.id || typeof p.id !== 'string') {
        p.id = crypto.randomUUID();
      }
      getRuntimeState(p.id);
      const inspection = inspectProjectPath(p.path);
      if (inspection.valid) {
        const shouldAutoFixCommand =
          p.command === 'npm run dev' &&
          inspection.recommendedCommand &&
          inspection.recommendedCommand !== 'npm run dev' &&
          inspection.framework.includes('Vite');
        applyInspectionToProject(p, inspection, shouldAutoFixCommand);
      }
    }
    // Only rewrite the file when something actually changed.
    if (JSON.stringify(projects) !== before) {
      saveProjects();
    }
    return;
  }

  // Fresh installs always start with an empty workspace. Nothing is auto-imported
  // from the app folder or its neighbours, so no personal paths leak into new installs.
  projects = [];
  if (fs.existsSync(backupFile)) {
    try {
      const restored = readProjectsFile(backupFile);
      if (restored.length > 0) {
        projects = restored;
        for (const p of projects) getRuntimeState(p.id);
        startupNotices.push({
          level: 'warning',
          message: `Your project list was missing, so Portly restored it from the last backup (${restored.length} project${restored.length === 1 ? '' : 's'}).`
        });
      }
    } catch {
      // ignore unreadable backup
    }
  }
  saveProjects();
}

function serializeProject(project) {
  const state = getRuntimeState(project.id);
  let logCount = state.logs.length;
  if (logCount === 0) {
    if (state.hasLog === undefined) {
      try {
        state.hasLog = fs.statSync(getLogFilePath(project.id)).size > 0;
      } catch {
        state.hasLog = false;
      }
    }
    if (state.hasLog) logCount = 1;
  }

  return {
    ...project,
    status: state.status,
    pid: state.pid,
    startedAt: state.startedAt,
    exitCode: state.exitCode,
    detectedUrl: state.detectedUrl,
    assignedPort: state.assignedPort,
    crashReason: state.status === 'crashed' ? state.crashReason : null,
    portConflict: Boolean(state.portConflict),
    logCount,
    kind: project.kind || 'server',
    startAfter: Array.isArray(project.startAfter) ? project.startAfter : [],
    namedUrl: getNamedUrlFor(project.hostname, project),
    env: envStore.summary(project.id)
  };
}

function broadcastEvent(eventName, payload) {
  const frame = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch {
      sseClients.delete(res);
    }
  }
}

/** In-process listeners (the Electron shell uses this for the tray and crash notifications). */
const projectStatusListeners = new Set();
const settingsListeners = new Set();

function onProjectStatus(listener) {
  if (typeof listener === 'function') projectStatusListeners.add(listener);
  return () => projectStatusListeners.delete(listener);
}

function onSettingsChanged(listener) {
  if (typeof listener === 'function') settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

function listProjectsWithStatus() {
  return projects.map(serializeProject);
}

function broadcastProjectStatus(project) {
  const payload = serializeProject(project);
  broadcastEvent('project-status', payload);
  if (project.stackId) broadcastStackStatus(project.stackId);
  for (const listener of projectStatusListeners) {
    try {
      listener(payload);
    } catch (err) {
      console.error('Project status listener failed:', err.message);
    }
  }
}

/** @type {Map<string, { stream: fs.WriteStream, bytes: number }>} */
const logWriters = new Map();
/** @type {Map<string, Array<object>>} */
const pendingLogBroadcasts = new Map();
let logBroadcastTimer = null;

function closeLogWriter(projectId) {
  const writer = logWriters.get(projectId);
  if (!writer) return Promise.resolve();
  logWriters.delete(projectId);
  return new Promise((resolve) => {
    writer.stream.end(() => resolve());
    writer.stream.once('error', () => resolve());
  });
}

function rotateLogFileIfNeeded(projectId, logPath, writer) {
  if (writer.bytes < MAX_LOG_FILE_BYTES) return writer;
  logWriters.delete(projectId);
  writer.stream.end();
  try {
    const rotated = getRotatedLogFilePath(projectId);
    fs.rmSync(rotated, { force: true });
    fs.renameSync(logPath, rotated);
  } catch (err) {
    // If the rename fails (file locked on Windows), keep appending to the same file.
    console.error(`Failed to rotate log for ${projectId}:`, err.message);
  }
  return getLogWriter(projectId);
}

function getLogWriter(projectId) {
  const existing = logWriters.get(projectId);
  if (existing) return existing;
  const logPath = getLogFilePath(projectId);
  let bytes = 0;
  try {
    bytes = fs.statSync(logPath).size;
  } catch {
    bytes = 0;
  }
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  const writer = { stream, bytes, logPath };
  stream.on('error', (err) => {
    console.error(`Failed to write log for ${projectId}:`, err.message);
    if (logWriters.get(projectId) === writer) logWriters.delete(projectId);
  });
  logWriters.set(projectId, writer);
  return writer;
}

function writeLogLine(projectId, logLine) {
  try {
    let writer = getLogWriter(projectId);
    writer = rotateLogFileIfNeeded(projectId, writer.logPath, writer);
    writer.stream.write(logLine);
    writer.bytes += Buffer.byteLength(logLine);
  } catch (err) {
    console.error(`Failed to write log for ${projectId}:`, err.message);
  }
}

function flushLogBroadcasts() {
  logBroadcastTimer = null;
  if (pendingLogBroadcasts.size === 0) return;
  const batches = Array.from(pendingLogBroadcasts.entries());
  pendingLogBroadcasts.clear();
  for (const [projectId, entries] of batches) {
    broadcastEvent('project-logs', { projectId, entries });
  }
}

function queueLogBroadcast(projectId, entry, immediate) {
  let list = pendingLogBroadcasts.get(projectId);
  if (!list) {
    list = [];
    pendingLogBroadcasts.set(projectId, list);
  }
  list.push(entry);
  if (list.length > MAX_MEMORY_LOGS) {
    list.splice(0, list.length - MAX_MEMORY_LOGS);
  }
  if (immediate) {
    if (logBroadcastTimer) {
      clearTimeout(logBroadcastTimer);
    }
    flushLogBroadcasts();
    return;
  }
  if (!logBroadcastTimer) {
    logBroadcastTimer = setTimeout(flushLogBroadcasts, LOG_BROADCAST_INTERVAL_MS);
  }
}

function appendLog(projectId, stream, rawText, alreadyClean = false) {
  const cleanText = alreadyClean ? String(rawText) : stripAnsi(rawText);
  if (!cleanText.trim() && stream !== 'system') {
    return null;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    stream,
    text: cleanText
  };

  const state = getRuntimeState(projectId);
  state.logs.push(entry);
  if (state.logs.length > MAX_MEMORY_LOGS) {
    state.logs.splice(0, state.logs.length - MAX_MEMORY_LOGS);
  }
  state.hasLog = true;
  if (stream === 'stderr' || stream === 'stdout') {
    if (stream === 'stderr' || /\b(error|err!|exception|traceback|panic|fatal|cannot find)\b/i.test(cleanText)) {
      state.lastErrorLine = cleanText.trim().slice(0, 300);
    }
  }

  writeLogLine(projectId, `[${entry.timestamp}] [${stream.toUpperCase()}] ${cleanText}\n`);
  // System messages (started, stopped, crashed) go out right away; output is batched.
  queueLogBroadcast(projectId, entry, stream === 'system');
  return entry;
}

function clearProbeTimer(state) {
  if (state.probeTimer) {
    clearTimeout(state.probeTimer);
    clearInterval(state.probeTimer);
    state.probeTimer = null;
  }
}

function detectAndRecordUrl(project, lineText) {
  if (project.kind === 'worker') return;
  const state = getRuntimeState(project.id);
  const match = lineText.match(LOCAL_URL_REGEX);
  if (match) {
    const normalizedUrl = match[0]
      .replace('0.0.0.0', 'localhost')
      .replace('127.0.0.1', 'localhost')
      .replace('[::1]', 'localhost')
      .replace(/\/+$/, '');

    const isExplicitLocalhost = /localhost|127\.0\.0\.1|\[::1\]/i.test(match[0]);
    if (!state.detectedUrl || (isExplicitLocalhost && state.detectedUrl !== normalizedUrl)) {
      state.detectedUrl = normalizedUrl;
      state.assignedPort = Number(match[1]) || state.assignedPort;
      clearProbeTimer(state);
      broadcastProjectStatus(project);
    }
    return;
  }

  if (!state.detectedUrl) {
    const portMatch = lineText.match(PORT_LISTEN_REGEX);
    if (portMatch) {
      const pNum = Number(portMatch[1]);
      if (pNum >= 80 && pNum <= 65535) {
        state.assignedPort = pNum;
        state.detectedUrl = `http://localhost:${pNum}`;
        clearProbeTimer(state);
        broadcastProjectStatus(project);
      }
    }
  }
}

function attachStreamReader(project, streamObj, streamName) {
  let buffer = '';

  const processLine = (line) => {
    const cleaned = stripAnsi(line);
    if (!cleaned.trim()) return;
    detectAndRecordUrl(project, cleaned);
    appendLog(project.id, streamName, cleaned, true);
  };

  streamObj.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      processLine(line);
    }
  });

  return () => {
    if (buffer.trim()) {
      processLine(buffer);
      buffer = '';
    }
  };
}

function checkHostPort(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const done = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function isPortListening(port) {
  if (!port || port < 1 || port > 65535) return false;
  const [v4, v6] = await Promise.all([
    checkHostPort('127.0.0.1', port),
    checkHostPort('::1', port)
  ]);
  return v4 || v6;
}

/** Fast check: can we bind the port ourselves? Fails at once if anything holds it. */
function canBindPort(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', (err) => {
      // No IPv6 on this machine: that address can't be in use.
      resolve(err && (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT'));
    });
    tester.listen({ port, host, exclusive: true }, () => {
      tester.close(() => resolve(true));
    });
  });
}

async function isPortFree(port) {
  if (!(await canBindPort(port, '127.0.0.1'))) return false;
  if (!(await canBindPort(port, '::1'))) return false;
  // Some servers bind in ways a test bind doesn't collide with (notably on Windows),
  // so finish with a real connection attempt.
  return !(await isPortListening(port));
}

/** Ports handed to a project whose start is still in progress (filled before any await). */
const pendingPorts = new Map();

function getReservedPorts(excludeId) {
  const reserved = new Set();
  for (const [id, st] of runtimeState.entries()) {
    if (id !== excludeId && (st.process || st.startPromise) && st.assignedPort) {
      reserved.add(Number(st.assignedPort));
    }
  }
  for (const [port, id] of pendingPorts.entries()) {
    if (id !== excludeId) reserved.add(port);
  }
  return reserved;
}

async function findAvailablePort(startPort, excludeId) {
  const candidate = Number(startPort) || 3000;
  for (let offset = 0; offset < 40; offset++) {
    const p = candidate + offset;
    if (p > 65535) break;
    if (p === PORT || p === getListeningPortSafe()) continue; // Skip Portly's own port
    if (getReservedPorts(excludeId).has(p)) continue;
    pendingPorts.set(p, excludeId);
    let free = false;
    try {
      free = await isPortFree(p);
    } finally {
      if (!free) pendingPorts.delete(p);
    }
    if (free) return p;
  }
  const err = new Error(
    `No free port found between ${candidate} and ${candidate + 39}. Stop something using those ports, or set a custom port for this project.`
  );
  err.statusCode = 409;
  throw err;
}

function releasePendingPort(port, id) {
  if (pendingPorts.get(port) === id) pendingPorts.delete(port);
}

function getListeningPortSafe() {
  try {
    const addr = server.address();
    return typeof addr === 'object' && addr ? addr.port : PORT;
  } catch {
    return PORT;
  }
}

function buildEffectiveCommand(project, assignedPort) {
  let cmd = (project.command || project.recommendedCommand || 'npm run dev').trim();
  if (!assignedPort) return cmd;

  const fw = project.framework || '';

  // Vite / Astro / SvelteKit / Angular default dev commands
  if (
    ['Vite', 'Astro', 'SvelteKit', 'Angular'].includes(fw) &&
    /^(npm|pnpm|yarn|bun)\s+(?:run\s+)?(dev|start)$/i.test(cmd)
  ) {
    const defaultPortMap = { Vite: 5173, Astro: 4321, SvelteKit: 5173, Angular: 4200 };
    if (assignedPort !== defaultPortMap[fw] && !/--port\b|-p\b/.test(cmd)) {
      cmd = /^yarn\s+/i.test(cmd)
        ? `${cmd} --port ${assignedPort}`
        : `${cmd} -- --port ${assignedPort}`;
    }
  } else if (fw === 'Django' && /^python3?\s+manage\.py\s+runserver$/i.test(cmd)) {
    const binMatch = cmd.match(/^(python3?)/i);
    cmd = `${binMatch ? binMatch[1] : 'python'} manage.py runserver ${assignedPort}`;
  } else if (/\buvicorn\b/i.test(cmd) && !/--port\b/.test(cmd)) {
    cmd = `${cmd} --port ${assignedPort}`;
  } else if (/\bflask\s+run\b/i.test(cmd) && !/--port\b|-p\b/.test(cmd)) {
    cmd = `${cmd} --port ${assignedPort}`;
  } else if (/\bstreamlit\s+run\b/i.test(cmd) && !/--server\.port\b/.test(cmd)) {
    cmd = `${cmd} --server.port ${assignedPort}`;
  } else if (/\bphp\s+artisan\s+serve\b/i.test(cmd) && !/--port\b/.test(cmd)) {
    cmd = `${cmd} --port=${assignedPort}`;
  } else if (/\bphp\s+-S\s+(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+/i.test(cmd)) {
    cmd = cmd.replace(
      /(php\s+-S\s+(?:localhost|127\.0\.0\.1|0\.0\.0\.0):)\d+/i,
      `$1${assignedPort}`
    );
  } else if (/\brails\s+s(?:erver)?\b/i.test(cmd) && !/\s-p\b|--port\b/.test(cmd)) {
    cmd = `${cmd} -p ${assignedPort}`;
  } else if (/\bjekyll\s+serve\b/i.test(cmd) && !/--port\b|-P\b/.test(cmd)) {
    cmd = `${cmd} --port ${assignedPort}`;
  } else if (/\bhugo\s+server\b/i.test(cmd) && !/--port\b|-p\b/.test(cmd)) {
    cmd = `${cmd} --port ${assignedPort}`;
  } else if (/\btrunk\s+serve\b/i.test(cmd) && !/--port\b/.test(cmd)) {
    cmd = `${cmd} --port ${assignedPort}`;
  } else if (/\bflutter\s+run\b/i.test(cmd) && /--web-port\s+\d+/.test(cmd)) {
    cmd = cmd.replace(/(--web-port\s+)\d+/, `$1${assignedPort}`);
  }

  return cmd;
}

function startActivePortProbe(project, state, targetPort) {
  clearProbeTimer(state);
  if (!targetPort) return;

  const child = state.process;
  const startedAt = Date.now();
  let delay = 500;
  const tick = async () => {
    state.probeTimer = null;
    // Give up after ~60 s, or if this run has ended or a URL was already found.
    if (state.process !== child || state.status !== 'running' || state.detectedUrl || Date.now() - startedAt > 60000) {
      return;
    }
    const open = await isPortListening(targetPort);
    if (state.process !== child) return;
    if (open && state.status === 'running' && !state.detectedUrl) {
      state.detectedUrl = `http://localhost:${targetPort}`;
      appendLog(project.id, 'system', `Live server detected at ${state.detectedUrl}`);
      broadcastProjectStatus(project);
      return;
    }
    delay = Math.min(2000, Math.round(delay * 1.4));
    state.probeTimer = setTimeout(tick, delay);
  };
  state.probeTimer = setTimeout(tick, delay);
}

function findProjectOrThrow(id) {
  const project = projects.find((p) => p.id === id);
  if (!project) {
    const err = new Error('Project not found.');
    err.statusCode = 404;
    throw err;
  }
  return project;
}

/** PATH from the user's login shell (macOS/Linux), so nvm, volta, fnm, asdf and pyenv work. */
let loginShellPath = null;
let loginShellPathPromise = null;

function loadLoginShellPath() {
  if (process.platform === 'win32') return Promise.resolve(null);
  if (loginShellPathPromise) return loginShellPathPromise;
  loginShellPathPromise = new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/sh';
    const marker = '__PORTLY_PATH__';
    let out = '';
    let child;
    try {
      child = spawn(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true' }
      });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve(null);
    }, 4000);
    child.stdout.on('data', (d) => {
      out += d.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const match = out.match(new RegExp(`${marker}(.*?)${marker}`, 's'));
      loginShellPath = match && match[1].trim() ? match[1].trim() : null;
      resolve(loginShellPath);
    });
  });
  return loginShellPathPromise;
}

function buildCrossPlatformEnv(assignedPort, projectPath = '', extraEnv = {}) {
  const existingPath =
    process.env.PATH || process.env.Path || process.env.path || '';
  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    BROWSER: 'none'
  };
  // The project's own variables (stack, then service). PATH is never taken from here.
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (key.toLowerCase() === 'path') continue;
    if (process.platform === 'win32') {
      // Windows variable names ignore case: replace the existing spelling instead of adding a twin.
      for (const existing of Object.keys(env)) {
        if (existing !== key && existing.toLowerCase() === key.toLowerCase()) delete env[existing];
      }
    }
    env[key] = value;
  }
  // Portly's port variables always win, so the app listens where Portly expects it.
  if (assignedPort) {
    const portStr = String(assignedPort);
    Object.assign(env, {
      PORT: portStr,
      SERVER_PORT: portStr,
      FLASK_RUN_PORT: portStr,
      STREAMLIT_SERVER_PORT: portStr,
      GRADIO_SERVER_PORT: portStr,
      ROCKET_PORT: portStr,
      ASPNETCORE_URLS: `http://localhost:${portStr}`
    });
  }

  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') {
      delete env[key];
    }
  }

  const localBins = [];
  if (projectPath) {
    const isWin = process.platform === 'win32';
    const venvSub = isWin ? 'Scripts' : 'bin';
    const candidates = [
      path.join(projectPath, '.venv', venvSub),
      path.join(projectPath, 'venv', venvSub),
      path.join(projectPath, 'node_modules', '.bin')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) localBins.push(c);
    }
  }

  const currentParts = existingPath.split(path.delimiter).filter(Boolean);

  if (process.platform !== 'win32') {
    const home = os.homedir();
    const shellParts = loginShellPath ? loginShellPath.split(path.delimiter).filter(Boolean) : [];
    const extraPaths = [
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.deno', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, 'go', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, '.pyenv', 'shims'),
      path.join(home, '.rbenv', 'shims'),
      '/snap/bin'
    ];
    // The user's own PATH (and their login shell's) comes first, so the Node or Python
    // version they picked wins; the fixed folders are only a fallback.
    env.PATH = Array.from(
      new Set([...localBins, ...shellParts, ...currentParts, ...extraPaths])
    ).join(path.delimiter);
  } else {
    const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const winDefaults = [
      path.join(sysRoot, 'System32'),
      sysRoot,
      path.join(sysRoot, 'System32', 'Wbem'),
      path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0'),
      'C:\\Program Files\\nodejs',
      process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : ''
    ].filter(Boolean);
    env.PATH = Array.from(new Set([...localBins, ...currentParts, ...winDefaults])).join(
      path.delimiter
    );
  }

  return env;
}

function spawnProjectCommand(command, cwd, env) {
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const defaultCmd = path.join(sysRoot, 'System32', 'cmd.exe');
    const cmdExe =
      process.env.ComSpec && fs.existsSync(process.env.ComSpec)
        ? process.env.ComSpec
        : fs.existsSync(defaultCmd)
          ? defaultCmd
          : 'cmd.exe';
    // Same as Node's own `shell: true` on Windows: wrap the whole command in one pair of quotes
    // and pass it verbatim. Without this, Node escapes inner quotes as \" which cmd.exe does not
    // understand, so any command with a quoted path containing spaces fails to start.
    return spawn(cmdExe, ['/d', '/s', '/c', `"${command}"`], {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: true
    });
  }

  const shell = process.env.SHELL || '/bin/sh';
  return spawn(shell, ['-c', command], {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function describePortOwner(port, excludeId) {
  for (const p of projects) {
    if (p.id === excludeId) continue;
    const st = getRuntimeState(p.id);
    if ((st.process || st.startPromise) && Number(st.assignedPort) === Number(port)) {
      return p;
    }
  }
  return null;
}

async function startProject(id) {
  const project = findProjectOrThrow(id);
  const state = getRuntimeState(id);

  // A start is already in progress: wait for it instead of spawning a second server.
  if (state.startPromise) {
    return state.startPromise;
  }
  // Stop in progress (for example a restart): let it finish first.
  if (state.stopPromise) {
    await state.stopPromise.catch(() => {});
    return startProject(id);
  }
  if (state.process) {
    return serializeProject(project);
  }

  state.startPromise = runStart(project, state).finally(() => {
    state.startPromise = null;
  });
  return state.startPromise;
}

async function runStart(project, state) {
  if (!fs.existsSync(project.path)) {
    const err = new Error(
      `Can't find this project's folder. It may have been moved or renamed: ${project.path}`
    );
    err.statusCode = 400;
    throw err;
  }

  if (process.platform !== 'win32') {
    await loadLoginShellPath();
  }

  // Re-inspect right before start so fresh projects/edits get optimal defaults
  const inspection = inspectProjectPath(project.path);
  if (inspection.valid) {
    const shouldAutoUpgrade =
      project.command === 'npm run dev' &&
      inspection.recommendedCommand &&
      inspection.recommendedCommand !== 'npm run dev' &&
      inspection.framework.includes('Vite');
    applyInspectionToProject(project, inspection, shouldAutoUpgrade);
  }

  const desiredPort = Number(project.customPort || project.defaultPort || 3000);
  let assignedPort;
  let portBusyByOtherProgram = false;
  if (project.kind === 'worker') {
    // Workers (queues, schedulers, watchers) don't serve a page: no port, no Open link.
    assignedPort = null;
  } else if (project.customPort) {
    assignedPort = desiredPort;
    if (assignedPort === PORT || assignedPort === getListeningPortSafe()) {
      const err = new Error(
        `Port ${assignedPort} is used by Portly itself. Pick a different custom port for this project.`
      );
      err.statusCode = 409;
      throw err;
    }
    const owner = describePortOwner(assignedPort, project.id);
    if (owner || pendingPorts.has(assignedPort)) {
      const err = new Error(
        `Port ${assignedPort} is already used by ${owner ? `"${owner.name}"` : 'another project that is starting'}. Stop it first or change one of the custom ports.`
      );
      err.statusCode = 409;
      throw err;
    }
    pendingPorts.set(assignedPort, project.id);
    portBusyByOtherProgram = !(await isPortFree(assignedPort));
  } else {
    assignedPort = await findAvailablePort(desiredPort, project.id);
  }

  const command = buildEffectiveCommand(project, assignedPort);
  let env;
  try {
    env = buildCrossPlatformEnv(assignedPort, project.path, composeProjectEnv(project, assignedPort));
  } catch (err) {
    if (assignedPort) releasePendingPort(assignedPort, project.id);
    throw err;
  }

  state.status = 'running';
  state.startedAt = Date.now();
  state.exitCode = null;
  state.detectedUrl = null;
  state.assignedPort = assignedPort;
  state.stopping = false;
  state.lastErrorLine = null;
  state.crashReason = null;
  state.portConflict = portBusyByOtherProgram;

  let child;
  try {
    child = spawnProjectCommand(command, project.path, env);
  } catch (err) {
    releasePendingPort(assignedPort, project.id);
    resetRuntimeState(state, 'crashed');
    state.exitCode = -1;
    state.crashReason = `Couldn't start: ${err.message}`;
    appendLog(project.id, 'system', `Failed to start process: ${err.message}`);
    broadcastProjectStatus(project);
    throw err;
  }
  releasePendingPort(assignedPort, project.id);

  state.process = child;
  state.pid = child.pid || null;
  let resolveExit;
  state.exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  project.lastStartedAt = new Date().toISOString();
  saveProjects();

  const portNotice = !assignedPort
    ? ' [worker, no port]'
    : !project.customPort && assignedPort !== desiredPort
      ? ` [Port ${desiredPort} was busy -> assigned PORT=${assignedPort}]`
      : ` [PORT=${assignedPort}]`;
  const userEnvCount =
    Object.keys(envStore.activeVars(project.id)).length +
    (project.stackId ? Object.keys(envStore.activeVars(project.stackId)).length : 0);

  appendLog(
    project.id,
    'system',
    `Started "${command}" (${project.programType || project.framework})${portNotice} in ${project.path} (PID: ${child.pid || 'unknown'})`
  );
  if (userEnvCount > 0) {
    // Names only: values can be secrets and logs end up in crash reports.
    const profile = envStore.summary(project.id).activeProfile;
    appendLog(project.id, 'system', `Added ${userEnvCount} environment variable${userEnvCount === 1 ? '' : 's'} (profile: ${profile}).`);
  }
  if (portBusyByOtherProgram) {
    appendLog(
      project.id,
      'system',
      `Warning: port ${assignedPort} was already in use by another program before this project started. The app may fail to start, and the Open link may show that other program.`
    );
  }
  broadcastProjectStatus(project);

  // Only probe for "is it up yet" when we know nothing else was answering on the port.
  if (!portBusyByOtherProgram) {
    startActivePortProbe(project, state, assignedPort);
  }

  const flushStdout = child.stdout
    ? attachStreamReader(project, child.stdout, 'stdout')
    : () => {};
  const flushStderr = child.stderr
    ? attachStreamReader(project, child.stderr, 'stderr')
    : () => {};

  let exited = false;
  const onExit = (code, signal, spawnError) => {
    if (exited) return;
    exited = true;
    flushStdout();
    flushStderr();
    resolveExit();

    // This exit belongs to an older run (the project was stopped and started again in the
    // meantime): record it in the log only, and leave the new run's state alone.
    if (state.process !== child) {
      return;
    }

    const wasStopping = state.stopping;
    let reason;
    let nextStatus;
    if (spawnError) {
      nextStatus = 'crashed';
      reason = `Failed to start process: ${spawnError.message}`;
      state.exitCode = -1;
      state.crashReason = `Couldn't start: ${spawnError.message}`;
    } else {
      nextStatus = wasStopping || code === 0 ? 'stopped' : 'crashed';
      state.exitCode = typeof code === 'number' ? code : null;
      reason = wasStopping
        ? 'Process stopped by user.'
        : `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
      if (nextStatus === 'crashed') {
        const last = state.lastErrorLine ? `: ${state.lastErrorLine}` : '';
        state.crashReason = `Exited (code ${code === null ? signal || 'unknown' : code})${last}`;
      }
    }
    resetRuntimeState(state, nextStatus);
    appendLog(project.id, 'system', reason);
    broadcastProjectStatus(project);
    // Release the log file handle while nothing is running (Windows locks open files).
    closeLogWriter(project.id);
  };

  child.on('error', (err) => onExit(null, null, err));
  child.on('close', (code, signal) => onExit(code, signal, null));

  return serializeProject(project);
}

function killProcessTree(pidToKill, child) {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const taskkillDefault = path.join(sysRoot, 'System32', 'taskkill.exe');
      const taskkillBin = fs.existsSync(taskkillDefault) ? taskkillDefault : 'taskkill';
      let killer;
      try {
        killer = spawn(taskkillBin, ['/PID', String(pidToKill), '/T', '/F'], {
          windowsHide: true
        });
      } catch {
        killer = null;
      }
      if (!killer) {
        try {
          child?.kill();
        } catch {
          // ignore
        }
        resolve(false);
        return;
      }
      killer.on('close', (code) => resolve(code === 0));
      killer.on('error', () => {
        // taskkill unavailable: this only ends cmd.exe, so the server under it may survive.
        try {
          child?.kill();
        } catch {
          // ignore
        }
        resolve(false);
      });
    });
  }

  // POSIX (macOS / Linux): terminate process group (-pid) first, then escalate to SIGKILL
  const signalGroupOrPid = (sig) => {
    try {
      process.kill(-pidToKill, sig);
      return true;
    } catch {
      try {
        process.kill(pidToKill, sig);
        return true;
      } catch {
        return false;
      }
    }
  };

  const isGroupOrPidAlive = () => {
    try {
      process.kill(-pidToKill, 0);
      return true;
    } catch {
      try {
        process.kill(pidToKill, 0);
        return true;
      } catch {
        return false;
      }
    }
  };

  return new Promise((resolve) => {
    signalGroupOrPid('SIGTERM');
    try {
      spawn('pkill', ['-TERM', '-P', String(pidToKill)], { stdio: 'ignore' }).on('error', () => {});
    } catch {
      // pkill optional
    }

    let elapsed = 0;
    const pollInterval = setInterval(() => {
      elapsed += 120;
      if (!isGroupOrPidAlive()) {
        clearInterval(pollInterval);
        resolve(true);
        return;
      }
      if (elapsed >= 1200) {
        clearInterval(pollInterval);
        signalGroupOrPid('SIGKILL');
        try {
          spawn('pkill', ['-KILL', '-P', String(pidToKill)], { stdio: 'ignore' }).on(
            'error',
            () => {}
          );
        } catch {
          // pkill optional
        }
        setTimeout(() => resolve(true), 120);
      }
    }, 120);
  });
}

async function stopProject(id) {
  const project = findProjectOrThrow(id);
  const state = getRuntimeState(id);

  // Let an in-flight start finish so its process can be stopped too.
  if (state.startPromise) {
    await state.startPromise.catch(() => {});
  }
  if (state.stopPromise) {
    return state.stopPromise;
  }

  if (!state.process) {
    resetRuntimeState(state, 'stopped');
    broadcastProjectStatus(project);
    return serializeProject(project);
  }

  state.stopPromise = runStop(project, state).finally(() => {
    state.stopPromise = null;
  });
  return state.stopPromise;
}

async function runStop(project, state) {
  clearProbeTimer(state);
  const child = state.process;
  const pidToKill = state.pid;
  const exitPromise = state.exitPromise || Promise.resolve();
  state.stopping = true;
  appendLog(project.id, 'system', `Stopping process tree (PID: ${pidToKill || 'unknown'})...`);

  let killed = true;
  if (pidToKill) {
    killed = await killProcessTree(pidToKill, child);
  } else {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }

  // Wait for the child's real exit; fall back to a timeout if it never reports one.
  let timer;
  const exitedInTime = await Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), 5000);
    })
  ]);
  clearTimeout(timer);

  if (state.process === child) {
    // The close event never came: mark it stopped ourselves. A late close is ignored,
    // because it no longer matches state.process.
    resetRuntimeState(state, 'stopped');
    if (!exitedInTime || !killed) {
      appendLog(
        project.id,
        'system',
        `Portly couldn't confirm that process ${pidToKill} exited. If the port stays busy, end it in your task manager.`
      );
    } else {
      appendLog(project.id, 'system', 'Process stopped by user.');
    }
    broadcastProjectStatus(project);
    closeLogWriter(project.id);
  }
  return serializeProject(project);
}

async function restartProject(id) {
  const project = findProjectOrThrow(id);
  const state = getRuntimeState(id);
  if (state.process || state.startPromise) {
    await stopProject(id);
    await new Promise((r) => setTimeout(r, 250));
  }
  appendLog(project.id, 'system', 'Restarting project...');
  return startProject(id);
}

async function stopAllProjects() {
  const runningIds = [];
  for (const p of projects) {
    const state = getRuntimeState(p.id);
    if (state.process || state.startPromise) {
      runningIds.push(p.id);
    }
  }
  await Promise.all(runningIds.map((id) => stopProject(id).catch(() => null)));
  return projects.map(serializeProject);
}

// ---------------------------------------------------------------------------------------
// Stacks, per-project environment variables and named URLs (Nov 2026 roadmap items 1-3).
//
// A Stack groups several services (frontend, API, worker, database...) under one name.
// Each service is an ordinary project record with a `stackId`, so logs, ports, crash
// reports and the MCP tools keep working per service. A project without `stackId` is a
// stand-alone project, exactly as before.
// ---------------------------------------------------------------------------------------

const SERVICE_KINDS = new Set(['server', 'worker']);

/** @type {Map<string, { startPromise: Promise|null, runToken: number }>} */
const stackRuntime = new Map();

const envStore = envStoreLib.createEnvStore(ENV_VARS_FILE, null);

/** Electron sets this to its safeStorage so env values are encrypted at rest. */
function setSecretCodec(codec) {
  envStore.setCodec(codec);
}

const namedUrlProxy = namedUrls.createNamedUrlProxy({
  resolve: resolveNamedHost,
  listNames: listNamedHosts,
  forbiddenPorts: () => [PORT, getListeningPortSafe()]
});

function getStackRuntime(id) {
  let rt = stackRuntime.get(id);
  if (!rt) {
    rt = { startPromise: null, runToken: 0 };
    stackRuntime.set(id, rt);
  }
  return rt;
}

function saveStacks() {
  ensureDirectories();
  writeJsonAtomic(STACKS_FILE, stacks);
}

function loadStacks() {
  stacks = [];
  if (fs.existsSync(STACKS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(STACKS_FILE, 'utf8').replace(/^﻿/, ''));
      if (Array.isArray(parsed)) {
        stacks = parsed.filter(
          (s) => s && typeof s === 'object' && typeof s.id === 'string' && typeof s.name === 'string'
        );
      }
    } catch (err) {
      const movedTo = quarantineCorruptFile(STACKS_FILE);
      startupNotices.push({
        level: 'warning',
        message: `Portly couldn't read your stacks, so their services now show as separate projects.${movedTo ? ` The damaged file was kept at ${movedTo}.` : ''}`
      });
    }
  }
  repairStacksAndHostnames();
}

/** Drops broken links (missing stacks, unknown start-after ids) and fills in web addresses. */
function repairStacksAndHostnames() {
  let projectsChanged = false;
  let stacksChanged = false;
  const stackIds = new Set(stacks.map((s) => s.id));
  for (const p of projects) {
    if (p.stackId && !stackIds.has(p.stackId)) {
      delete p.stackId;
      delete p.startAfter;
      projectsChanged = true;
    }
    if (p.kind !== undefined && !SERVICE_KINDS.has(p.kind)) {
      p.kind = 'server';
      projectsChanged = true;
    }
  }
  for (const p of projects) {
    if (!p.stackId) continue;
    const siblings = new Set(projects.filter((o) => o.stackId === p.stackId && o.id !== p.id).map((o) => o.id));
    const cleaned = (Array.isArray(p.startAfter) ? p.startAfter : []).filter((id) => siblings.has(id));
    if (!Array.isArray(p.startAfter) || cleaned.length !== p.startAfter.length) {
      p.startAfter = cleaned;
      projectsChanged = true;
    }
  }
  for (const s of stacks) {
    if (!s.hostname) {
      s.hostname = uniqueHostname(namedUrls.slugifyHostname(s.name), { stackId: s.id });
      stacksChanged = true;
    }
    const services = projects.filter((p) => p.stackId === s.id);
    if (s.primaryServiceId && !services.some((p) => p.id === s.primaryServiceId)) {
      s.primaryServiceId = null;
      stacksChanged = true;
    }
  }
  for (const p of projects) {
    if (!p.hostname) {
      p.hostname = defaultHostnameFor(p);
      projectsChanged = true;
    }
  }
  if (projectsChanged) saveProjects();
  if (stacksChanged) saveStacks();
}

function isHostnameTaken(name, { projectId = null, stackId = null } = {}) {
  return (
    projects.some((p) => p.id !== projectId && p.hostname === name) ||
    stacks.some((s) => s.id !== stackId && s.hostname === name)
  );
}

function uniqueHostname(base, owner = {}) {
  let candidate = base;
  let i = 2;
  while (isHostnameTaken(candidate, owner)) {
    candidate = `${base}-${i++}`;
  }
  return candidate;
}

function defaultHostnameFor(project) {
  const own = namedUrls.slugifyHostname(project.name);
  const stack = project.stackId ? stacks.find((s) => s.id === project.stackId) : null;
  const base = stack && stack.hostname ? `${own}.${stack.hostname}` : own;
  return uniqueHostname(base, { projectId: project.id });
}

/** Validates a web address the user typed and checks that nothing else uses it. */
function claimHostname(raw, owner) {
  const name = namedUrls.normalizeHostnameInput(raw);
  if (isHostnameTaken(name, owner)) {
    const err = new Error(`${name}.localhost is already used by another project.`);
    err.statusCode = 409;
    throw err;
  }
  return name;
}

function findStackOrThrow(id) {
  const stack = stacks.find((s) => s.id === id);
  if (!stack) {
    const err = new Error('Stack not found.');
    err.statusCode = 404;
    throw err;
  }
  return stack;
}

function getStackServices(stackId) {
  return projects.filter((p) => p.stackId === stackId);
}

/**
 * Orders services so that each comes after everything in its startAfter list.
 * Throws a 400 error naming the loop when the rules go round in a circle.
 */
function orderStackServices(services) {
  const byId = new Map(services.map((s) => [s.id, s]));
  const ordered = [];
  const mark = new Map(); // id -> 1 visiting, 2 done
  const visit = (svc, trail) => {
    const m = mark.get(svc.id);
    if (m === 2) return;
    if (m === 1) {
      const loop = [...trail.slice(trail.indexOf(svc.id)), svc.id].map((id) => byId.get(id).name);
      const err = new Error(`These services wait for each other in a loop: ${loop.join(' → ')}. Remove one of the "start after" rules.`);
      err.statusCode = 400;
      throw err;
    }
    mark.set(svc.id, 1);
    for (const depId of svc.startAfter || []) {
      const dep = byId.get(depId);
      if (dep) visit(dep, [...trail, svc.id]);
    }
    mark.set(svc.id, 2);
    ordered.push(svc);
  };
  // Keep the saved order where the rules allow it.
  for (const svc of services) visit(svc, []);
  return ordered;
}

function isServiceProcessUp(state) {
  return Boolean(state.process || state.startPromise);
}

function serializeStack(stack) {
  const services = getStackServices(stack.id);
  let ordered = services;
  try {
    ordered = orderStackServices(services);
  } catch {
    // a loop is reported when the user tries to start it
  }
  const rt = getStackRuntime(stack.id);
  let running = 0;
  let crashed = 0;
  let starting = 0;
  for (const svc of services) {
    const st = getRuntimeState(svc.id);
    if (st.status === 'crashed') crashed += 1;
    if (isServiceProcessUp(st) && st.status === 'running') {
      running += 1;
      if (svc.kind !== 'worker' && !st.detectedUrl) starting += 1;
    }
  }
  let status = 'stopped';
  if (rt.startPromise) status = 'starting';
  else if (crashed > 0) status = 'crashed';
  else if (running > 0 && running === services.length) status = starting > 0 ? 'starting' : 'running';
  else if (running > 0) status = 'partial';

  const primary = getPrimaryService(stack);
  return {
    id: stack.id,
    name: stack.name,
    path: stack.path || '',
    hostname: stack.hostname,
    namedUrl: getNamedUrlFor(stack.hostname, primary),
    primaryServiceId: primary ? primary.id : null,
    primaryServiceIsDefault: !stack.primaryServiceId,
    serviceIds: ordered.map((s) => s.id),
    status,
    counts: { total: services.length, running, crashed },
    env: envStore.summary(stack.id),
    createdAt: stack.createdAt || null
  };
}

function listStacksSerialized() {
  return stacks.map(serializeStack);
}

function broadcastStackStatus(stackId) {
  const stack = stacks.find((s) => s.id === stackId);
  if (stack) broadcastEvent('stack-status', serializeStack(stack));
}

/** The service a stack's own address (shop.localhost) opens: chosen, else the last web service. */
function getPrimaryService(stack) {
  const services = getStackServices(stack.id);
  if (stack.primaryServiceId) {
    const chosen = services.find((s) => s.id === stack.primaryServiceId);
    if (chosen) return chosen;
  }
  let ordered = services;
  try {
    ordered = orderStackServices(services);
  } catch {
    // keep saved order
  }
  const web = ordered.filter((s) => s.kind !== 'worker');
  return web.length ? web[web.length - 1] : null;
}

// ------------------------------ named URLs ------------------------------

function getNamedUrlFor(hostname, project) {
  if (!settings.namedUrls || !namedUrlProxy.isRunning() || !hostname) return null;
  if (project && project.kind === 'worker') return null;
  return namedUrls.buildNamedUrl(hostname, namedUrlProxy.getPort());
}

function routeTargetFor(project) {
  if (!project) return null;
  const st = getRuntimeState(project.id);
  return {
    name: project.name,
    port: st.assignedPort || null,
    running: Boolean(st.process) && st.status === 'running' && project.kind !== 'worker'
  };
}

function resolveNamedHost(name) {
  const project = projects.find((p) => p.hostname === name);
  if (project) return routeTargetFor(project);
  const stack = stacks.find((s) => s.hostname === name);
  if (stack) {
    const primary = getPrimaryService(stack);
    if (!primary) return { name: stack.name, port: null, running: false };
    return { ...routeTargetFor(primary), name: stack.name };
  }
  return null;
}

function listNamedHosts() {
  const out = [];
  for (const s of stacks) {
    const target = resolveNamedHost(s.hostname);
    out.push({ hostname: s.hostname, name: s.name, running: Boolean(target && target.running) });
  }
  for (const p of projects) {
    if (p.kind === 'worker') continue;
    const t = routeTargetFor(p);
    out.push({ hostname: p.hostname, name: p.name, running: t.running });
  }
  return out;
}

/** Starts, restarts or stops the proxy to match the settings. Never throws. */
async function syncNamedUrlProxy() {
  // PORTLY_PROXY_PORT overrides the setting (tests and side-by-side dev copies use it).
  const wantPort = process.env.PORTLY_PROXY_PORT !== undefined
    ? normalizeProxyPort(process.env.PORTLY_PROXY_PORT, 0)
    : normalizeProxyPort(settings.proxyPort);
  let result;
  if (!settings.namedUrls) {
    await namedUrlProxy.stop();
    result = { ok: true, running: false };
  } else if (namedUrlProxy.isRunning() && (namedUrlProxy.getPort() === wantPort || wantPort === 0)) {
    result = { ok: true, running: true, port: wantPort };
  } else if (wantPort === PORT || wantPort === getListeningPortSafe()) {
    await namedUrlProxy.stop();
    result = { ok: false, running: false, error: `Port ${wantPort} is Portly's own port. Pick another port for named URLs.` };
  } else {
    const started = await namedUrlProxy.start(wantPort);
    result = started.ok
      ? { ok: true, running: true, port: started.port }
      : { ok: false, running: false, error: started.error };
  }
  broadcastEvent('named-urls', getNamedUrlStatus());
  broadcastEvent('projects-refresh', { projects: listProjectsWithStatus(), stacks: listStacksSerialized() });
  return result;
}

function getNamedUrlStatus() {
  return {
    enabled: Boolean(settings.namedUrls),
    running: namedUrlProxy.isRunning(),
    port: namedUrlProxy.getPort() || normalizeProxyPort(settings.proxyPort),
    error: settings.namedUrls && !namedUrlProxy.isRunning() ? namedUrlProxy.getError() : null
  };
}

// ------------------------------ environment ------------------------------

/** Turns "Payments API" into "PAYMENTS_API" for PORTLY_<NAME>_URL style variables. */
function envNameFor(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug ? (/^[0-9]/.test(slug) ? `S_${slug}` : slug) : 'SERVICE';
}

/**
 * Variables Portly adds for a project, then the user's own (stack first, then the service),
 * with ${NAME} references expanded. Portly's port variables are added later and win.
 */
function composeProjectEnv(project, assignedPort) {
  const portlyVars = { PORTLY_PROJECT: project.name };
  const ownNamed = getNamedUrlFor(project.hostname, project);
  if (assignedPort) {
    portlyVars.PORTLY_URL = `http://localhost:${assignedPort}`;
  }
  if (ownNamed) portlyVars.PORTLY_NAMED_URL = ownNamed;

  if (project.stackId) {
    const stack = stacks.find((s) => s.id === project.stackId);
    if (stack) {
      portlyVars.PORTLY_STACK = stack.name;
      const stackUrl = getNamedUrlFor(stack.hostname, getPrimaryService(stack));
      if (stackUrl) portlyVars.PORTLY_STACK_URL = stackUrl;
    }
    // Siblings that are already up (anything this service starts after is up by now).
    for (const sib of getStackServices(project.stackId)) {
      if (sib.id === project.id || sib.kind === 'worker') continue;
      const st = getRuntimeState(sib.id);
      if (!st.process || !st.assignedPort) continue;
      const key = envNameFor(sib.name);
      portlyVars[`PORTLY_${key}_PORT`] = String(st.assignedPort);
      portlyVars[`PORTLY_${key}_URL`] = `http://localhost:${st.assignedPort}`;
      const sibNamed = getNamedUrlFor(sib.hostname, sib);
      if (sibNamed) portlyVars[`PORTLY_${key}_NAMED_URL`] = sibNamed;
    }
  }

  const composed = { ...portlyVars };
  const portStr = assignedPort ? String(assignedPort) : undefined;
  const lookup = (name) => {
    if (composed[name] !== undefined) return composed[name];
    if (portStr && (name === 'PORT' || name === 'SERVER_PORT')) return portStr;
    return process.env[name];
  };
  const layers = [];
  if (project.stackId) layers.push(envStore.activeVars(project.stackId));
  layers.push(envStore.activeVars(project.id));
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      composed[key] = envStoreLib.expandReferences(value, lookup);
    }
  }
  return composed;
}

function getEnvOwner(ownerId) {
  const project = projects.find((p) => p.id === ownerId);
  if (project) return { kind: 'project', owner: project, dir: project.path };
  const stack = stacks.find((s) => s.id === ownerId);
  if (stack) return { kind: 'stack', owner: stack, dir: stack.path || '' };
  const err = new Error('Project or stack not found.');
  err.statusCode = 404;
  throw err;
}

function describeEnv(ownerId) {
  const { kind, dir } = getEnvOwner(ownerId);
  const cfg = envStore.get(ownerId);
  return {
    ownerId,
    ownerKind: kind,
    activeProfile: cfg.activeProfile,
    profiles: cfg.profiles,
    envFiles: dir && fs.existsSync(dir) ? envStoreLib.listEnvFiles(dir) : [],
    encrypted: envStore.isEncrypted()
  };
}

function afterEnvChange(ownerId) {
  const project = projects.find((p) => p.id === ownerId);
  if (project) broadcastProjectStatus(project);
  else broadcastStackStatus(ownerId);
}

// ------------------------------ stack lifecycle ------------------------------

function waitMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolves when a service can be relied on: a web service answers on its port (or printed
 * its URL), a worker has stayed up briefly, or the service finished with exit code 0
 * (one-off tasks such as migrations). Returns 'ready' | 'done' | 'failed' | 'timeout'.
 */
async function waitForServiceReady(project, isCancelled) {
  const state = getRuntimeState(project.id);
  const child = state.process;
  const started = Date.now();
  const limit = project.kind === 'worker' ? WORKER_READY_MS : STACK_READY_TIMEOUT_MS;
  while (true) {
    if (isCancelled()) return 'failed';
    if (state.process !== child || !state.process) {
      return state.status === 'crashed' ? 'failed' : 'done';
    }
    if (project.kind === 'worker') {
      if (Date.now() - started >= limit) return 'ready';
    } else {
      if (state.detectedUrl) return 'ready';
      if (state.assignedPort && (await isPortListening(state.assignedPort))) return 'ready';
      if (Date.now() - started >= limit) return 'timeout';
    }
    await waitMs(250);
  }
}

async function startStack(stackId) {
  const stack = findStackOrThrow(stackId);
  const rt = getStackRuntime(stackId);
  if (rt.startPromise) return rt.startPromise;
  const services = getStackServices(stackId);
  if (services.length === 0) {
    const err = new Error(`${stack.name} has no services yet. Add one first.`);
    err.statusCode = 400;
    throw err;
  }
  const ordered = orderStackServices(services); // throws on a loop before anything starts
  rt.runToken += 1;
  const token = rt.runToken;
  rt.startPromise = runStackStart(stack, ordered, () => rt.runToken !== token).finally(() => {
    rt.startPromise = null;
    broadcastStackStatus(stackId);
  });
  broadcastStackStatus(stackId);
  return rt.startPromise;
}

async function runStackStart(stack, ordered, isCancelled) {
  const outcome = new Map(); // id -> Promise<'ready'|'done'|'failed'|'timeout'|'skipped'>
  const problems = [];

  const startOne = (svc) => {
    if (outcome.has(svc.id)) return outcome.get(svc.id);
    const promise = (async () => {
      const deps = (svc.startAfter || [])
        .map((id) => ordered.find((o) => o.id === id))
        .filter(Boolean);
      const depResults = await Promise.all(deps.map((d) => startOne(d)));
      if (isCancelled()) return 'skipped';
      const failedDeps = deps.filter((d, i) => depResults[i] === 'failed' || depResults[i] === 'skipped');
      if (failedDeps.length) {
        const names = failedDeps.map((d) => d.name).join(', ');
        appendLog(svc.id, 'system', `Not started, because ${names} didn't start.`);
        problems.push(`${svc.name} wasn't started because ${names} didn't start.`);
        return 'skipped';
      }
      deps.forEach((d, i) => {
        if (depResults[i] === 'timeout') {
          appendLog(
            svc.id,
            'system',
            `${d.name} didn't answer on its port within ${Math.round(STACK_READY_TIMEOUT_MS / 1000)} s. Starting anyway.`
          );
        }
      });
      const st = getRuntimeState(svc.id);
      if (!st.process) {
        try {
          await startProject(svc.id);
        } catch (err) {
          problems.push(`${svc.name}: ${err.message}`);
          return 'failed';
        }
      }
      const result = await waitForServiceReady(svc, isCancelled);
      if (result === 'failed' && !isCancelled()) {
        const reason = getRuntimeState(svc.id).crashReason;
        problems.push(`${svc.name} stopped while starting${reason ? `: ${reason}` : '.'}`);
      }
      broadcastStackStatus(stack.id);
      return result;
    })();
    outcome.set(svc.id, promise);
    return promise;
  };

  await Promise.all(ordered.map((svc) => startOne(svc)));
  const result = serializeStack(stack);
  return { ...result, ok: problems.length === 0, problems, cancelled: isCancelled() };
}

async function stopStack(stackId) {
  const stack = findStackOrThrow(stackId);
  const rt = getStackRuntime(stackId);
  rt.runToken += 1; // cancels a start in progress: nothing new is started after this
  const services = getStackServices(stackId);
  let ordered = services;
  try {
    ordered = orderStackServices(services);
  } catch {
    // stop in saved order
  }
  // Frontends and workers first, databases last.
  for (const svc of [...ordered].reverse()) {
    await stopProject(svc.id).catch(() => null);
  }
  if (rt.startPromise) await rt.startPromise.catch(() => null);
  broadcastStackStatus(stackId);
  return serializeStack(stack);
}

async function restartStack(stackId) {
  await stopStack(stackId);
  await waitMs(250);
  return startStack(stackId);
}

// ------------------------------ stack records ------------------------------

function cleanServiceKind(value) {
  return SERVICE_KINDS.has(value) ? value : 'server';
}

/**
 * Creates a stack and its services in one step.
 * body: { name, path?, hostname?, services: [{ name, path, command, kind, customPort, hostname, startAfter: [names or ids] }] }
 */
function createStackRecord(body = {}) {
  const name = String(body.name || '').trim();
  if (!name) {
    const err = new Error('Give the stack a name.');
    err.statusCode = 400;
    throw err;
  }
  const rawServices = Array.isArray(body.services) ? body.services : [];
  if (rawServices.length > 20) {
    const err = new Error('A stack can hold at most 20 services.');
    err.statusCode = 400;
    throw err;
  }
  let rootPath = '';
  if (body.path) {
    const cleaned = cleanPathInput(body.path);
    if (cleaned && fs.existsSync(cleaned) && fs.statSync(cleaned).isDirectory()) {
      rootPath = path.resolve(cleaned);
    }
  }
  const stack = {
    id: crypto.randomUUID(),
    name,
    path: rootPath,
    hostname: body.hostname
      ? claimHostname(body.hostname, { stackId: null })
      : uniqueHostname(namedUrls.slugifyHostname(name), {}),
    primaryServiceId: null,
    createdAt: new Date().toISOString()
  };

  // Validate every service before saving anything.
  const projectsBefore = projects;
  const stacksBefore = stacks;
  stacks = [...stacks, stack];
  projects = [...projects];
  const created = [];
  try {
    for (const raw of rawServices) {
      created.push(createProjectRecord({ ...raw, stackId: stack.id, _deferSave: true }));
    }
    // startAfter may name other services of this request by name, or by index.
    const lookup = (ref) => {
      if (typeof ref === 'number') return created[ref] || null;
      const key = String(ref || '').trim().toLowerCase();
      return created.find((c) => c.id === ref || c.name.toLowerCase() === key) || null;
    };
    rawServices.forEach((raw, i) => {
      const refs = Array.isArray(raw && raw.startAfter) ? raw.startAfter : [];
      created[i].startAfter = Array.from(
        new Set(refs.map(lookup).filter((c) => c && c.id !== created[i].id).map((c) => c.id))
      );
    });
    orderStackServices(created); // reject loops
    const primaryRef = body.primaryService;
    if (primaryRef !== undefined && primaryRef !== null && primaryRef !== '') {
      const primary = lookup(primaryRef);
      if (primary) stack.primaryServiceId = primary.id;
    }
  } catch (err) {
    projects = projectsBefore;
    stacks = stacksBefore;
    throw err;
  }
  for (const c of created) getRuntimeState(c.id);
  saveProjects();
  saveStacks();
  for (const c of created) broadcastProjectStatus(c);
  broadcastStackStatus(stack.id);
  return stack;
}

function updateStackRecord(stackId, body = {}) {
  const stack = findStackOrThrow(stackId);
  if (body.name !== undefined) {
    const n = String(body.name).trim();
    if (!n) {
      const err = new Error('Give the stack a name.');
      err.statusCode = 400;
      throw err;
    }
    stack.name = n;
  }
  if (body.hostname !== undefined && body.hostname !== stack.hostname) {
    const next = claimHostname(body.hostname, { stackId });
    const old = stack.hostname;
    stack.hostname = next;
    // Services that still use the default "<service>.<old>" pattern follow the rename.
    for (const svc of getStackServices(stackId)) {
      if (old && svc.hostname && svc.hostname.endsWith(`.${old}`)) {
        const base = `${svc.hostname.slice(0, -old.length - 1)}.${next}`;
        svc.hostname = uniqueHostname(base, { projectId: svc.id });
      }
    }
    saveProjects();
  }
  if (body.primaryServiceId !== undefined) {
    if (body.primaryServiceId === null || body.primaryServiceId === '') {
      stack.primaryServiceId = null;
    } else {
      const svc = getStackServices(stackId).find((s) => s.id === body.primaryServiceId);
      if (!svc) {
        const err = new Error('That service is not part of this stack.');
        err.statusCode = 400;
        throw err;
      }
      stack.primaryServiceId = svc.id;
    }
  }
  if (body.serviceOrder !== undefined && Array.isArray(body.serviceOrder)) {
    // Reorders the services inside the saved project list (start-after rules still win).
    const ids = body.serviceOrder.filter((id) => projects.some((p) => p.id === id && p.stackId === stackId));
    const inStack = projects.filter((p) => p.stackId === stackId);
    const rest = inStack.filter((p) => !ids.includes(p.id));
    const sorted = [...ids.map((id) => projects.find((p) => p.id === id)), ...rest];
    let k = 0;
    projects = projects.map((p) => (p.stackId === stackId ? sorted[k++] : p));
    saveProjects();
  }
  saveStacks();
  broadcastStackStatus(stackId);
  for (const svc of getStackServices(stackId)) broadcastProjectStatus(svc);
  return serializeStack(stack);
}

/** Deletes a stack. keepServices=true turns its services into stand-alone projects. */
async function deleteStackRecord(stackId, { keepServices = false } = {}) {
  const stack = findStackOrThrow(stackId);
  await stopStack(stackId);
  const services = getStackServices(stackId);
  if (keepServices) {
    for (const svc of services) {
      delete svc.stackId;
      delete svc.startAfter;
      svc.hostname = uniqueHostname(namedUrls.slugifyHostname(svc.name), { projectId: svc.id });
    }
  } else {
    for (const svc of services) {
      await removeProjectRecord(svc.id);
    }
  }
  stacks = stacks.filter((s) => s.id !== stackId);
  stackRuntime.delete(stackId);
  envStore.remove(stackId);
  saveStacks();
  saveProjects();
  if (keepServices) for (const svc of services) broadcastProjectStatus(svc);
  broadcastEvent('stack-deleted', { id: stack.id, keptServices: keepServices });
  return { ok: true, id: stack.id };
}

/** Removes one project (or service) and everything Portly kept for it. */
async function removeProjectRecord(id) {
  const project = findProjectOrThrow(id);
  const state = getRuntimeState(id);
  if (state.process || state.startPromise || state.stopPromise) {
    await stopProject(id);
  }
  projects = projects.filter((p) => p.id !== id);
  for (const p of projects) {
    if (Array.isArray(p.startAfter) && p.startAfter.includes(id)) {
      p.startAfter = p.startAfter.filter((x) => x !== id);
    }
  }
  for (const s of stacks) {
    if (s.primaryServiceId === id) s.primaryServiceId = null;
  }
  runtimeState.delete(id);
  pendingLogBroadcasts.delete(id);
  await closeLogWriter(id);
  envStore.remove(id);
  saveProjects();
  if (project.stackId) saveStacks();
  broadcastEvent('project-deleted', { id });
  if (project.stackId) broadcastStackStatus(project.stackId);
  return project;
}

/** Applies stack-related fields from a project edit (kind, startAfter, hostname, stackId). */
function applyServiceFields(project, body) {
  if (body.stackId !== undefined) {
    const next = body.stackId ? findStackOrThrow(body.stackId).id : null;
    if (next !== (project.stackId || null)) {
      const prevStack = project.stackId;
      if (next) project.stackId = next;
      else delete project.stackId;
      project.startAfter = [];
      for (const p of projects) {
        if (p.id !== project.id && Array.isArray(p.startAfter) && p.startAfter.includes(project.id)) {
          p.startAfter = p.startAfter.filter((x) => x !== project.id);
        }
      }
      for (const s of stacks) {
        if (s.id === prevStack && s.primaryServiceId === project.id) s.primaryServiceId = null;
      }
      if (body.hostname === undefined) project.hostname = '';
      if (!project.stackId) delete project.startAfter;
      if (prevStack) broadcastStackStatus(prevStack);
    }
  }
  if (body.kind !== undefined) {
    project.kind = cleanServiceKind(body.kind);
  }
  if (body.startAfter !== undefined) {
    if (!project.stackId) {
      const err = new Error('"Start after" only applies to services in a stack.');
      err.statusCode = 400;
      throw err;
    }
    const siblings = getStackServices(project.stackId);
    const ids = (Array.isArray(body.startAfter) ? body.startAfter : []).filter(
      (id) => id !== project.id && siblings.some((s) => s.id === id)
    );
    const before = project.startAfter;
    project.startAfter = Array.from(new Set(ids));
    try {
      orderStackServices(siblings);
    } catch (err) {
      project.startAfter = before;
      throw err;
    }
  }
  if (body.hostname !== undefined && String(body.hostname).trim()) {
    project.hostname = claimHostname(body.hostname, { projectId: project.id });
  }
  if (!project.hostname) {
    project.hostname = defaultHostnameFor(project);
  }
}

/** Suggests a stack's services from one folder (does not save anything). */
function suggestStackFromPath(rawPath) {
  const cleaned = cleanPathInput(rawPath);
  if (!cleaned) {
    const err = new Error('Choose the stack\'s main folder first.');
    err.statusCode = 400;
    throw err;
  }
  const resolved = path.resolve(cleaned);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    const err = new Error('That folder doesn\'t exist, or Portly can\'t read it.');
    err.statusCode = 400;
    throw err;
  }
  const suggestion = stackDetect.suggestStack(resolved, {
    inspect: inspectProjectPath,
    isProjectDir: isSupportedProjectDir
  });
  return suggestion;
}

function parseLogLine(line) {
  const match = line.match(/^\[([^\]]+)\]\s+\[(STDOUT|STDERR|SYSTEM)\]\s?(.*)$/);
  if (match) {
    return {
      timestamp: match[1],
      stream: match[2].toLowerCase(),
      text: match[3]
    };
  }
  return {
    timestamp: null,
    stream: 'stdout',
    text: stripAnsi(line)
  };
}

/** Reads only the last `maxLines` lines of a file, working backwards in 64 KB chunks. */
async function readTailLines(filePath, maxLines) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const chunkSize = 64 * 1024;
    let position = size;
    let text = '';
    let lineCount = 0;
    while (position > 0 && lineCount <= maxLines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buf = Buffer.alloc(readSize);
      await handle.read(buf, 0, readSize, position);
      text = buf.toString('utf8') + text;
      lineCount = (text.match(/\n/g) || []).length;
      if (text.length > 4 * 1024 * 1024) break;
    }
    let lines = text.split(/\r?\n/);
    // The first line may be cut in the middle when we didn't read from the start.
    if (position > 0) lines = lines.slice(1);
    return { lines: lines.filter((l) => l.length > 0).slice(-maxLines), size };
  } finally {
    await handle.close();
  }
}

async function readProjectLogs(id) {
  findProjectOrThrow(id);
  const logFilePath = getLogFilePath(id);
  const state = getRuntimeState(id);
  let fileSize = 0;

  try {
    const { lines, size } = await readTailLines(logFilePath, MAX_READ_LOG_LINES);
    fileSize = size;
    const parsed = lines.map(parseLogLine);
    // Lines still queued in the write stream are not on disk yet; add them from memory.
    const writer = logWriters.get(id);
    if (writer && writer.stream.writableLength > 0 && state.logs.length > 0) {
      const lastTs = parsed.length ? parsed[parsed.length - 1].timestamp : null;
      const extra = lastTs ? state.logs.filter((e) => e.timestamp > lastTs) : state.logs;
      parsed.push(...extra);
    }
    return { logs: parsed.slice(-MAX_READ_LOG_LINES), logFilePath, fileSize };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Failed reading logs for ${id}:`, err.message);
    }
  }

  return {
    logs: state.logs.slice(-MAX_READ_LOG_LINES),
    logFilePath,
    fileSize
  };
}

async function clearProjectLogs(id) {
  findProjectOrThrow(id);
  const state = getRuntimeState(id);
  state.logs = [];
  state.hasLog = false;
  pendingLogBroadcasts.delete(id);
  await closeLogWriter(id);
  const logFilePath = getLogFilePath(id);
  fs.writeFileSync(logFilePath, '', 'utf8');
  fs.rmSync(getRotatedLogFilePath(id), { force: true });
  return { ok: true, logFilePath };
}

function buildCrashReport(targetProjectId = null) {
  ensureDirectories();
  const generatedAt = new Date().toISOString();
  const safeStamp = generatedAt.replace(/[:.]/g, '-');
  const system = getSystemInfo();
  const crashedProjects = projects.filter((p) => getRuntimeState(p.id).status === 'crashed');

  let selected = [];
  if (targetProjectId) {
    selected = [findProjectOrThrow(targetProjectId)];
  } else if (crashedProjects.length > 0) {
    selected = crashedProjects;
  } else {
    selected = [...projects];
  }

  const slug = targetProjectId && selected[0]
    ? `${String(selected[0].name || 'project').toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}-`
    : '';
  const fileName = `portly-crash-report-${slug}${safeStamp}.log`;

  const lines = [
    '====================================================================',
    'PORTLY — LOCAL CRASH & DIAGNOSTIC REPORT',
    '====================================================================',
    `Generated At     : ${generatedAt}`,
    `Scope            : ${targetProjectId ? `Project (${selected[0].name})` : crashedProjects.length > 0 ? `Crashed Projects (${crashedProjects.length})` : `All Registered Projects (${selected.length})`}`,
    `Host OS          : ${system.osName} (${system.platform}/${system.arch})`,
    `OS Version       : ${system.osVersion || system.release}`,
    `Node.js          : ${process.version}`,
    `Portly PID       : ${process.pid}`,
    `Server Uptime    : ${Math.round(process.uptime())}s`,
    `Crash Archives   : ${CRASH_REPORTS_DIR}`,
    ''
  ];

  const includedProjects = [];
  if (selected.length === 0) {
    lines.push('No projects are currently registered in Portly.');
  } else {
    for (const project of selected) {
      const state = getRuntimeState(project.id);
      const logData = readProjectLogs(project.id);
      const allEntries = Array.isArray(logData.logs) ? logData.logs : [];
      const errorEntries = allEntries.filter(
        (entry) =>
          entry.stream === 'stderr' ||
          (entry.stream === 'system' &&
            /fail|error|enoent|exit|crash|exception|unhandled/i.test(String(entry.text || '')))
      );
      const tailEntries = allEntries.slice(-100);

      includedProjects.push({
        id: project.id,
        name: project.name,
        status: state.status,
        exitCode: state.exitCode !== undefined ? state.exitCode : null,
        errorLineCount: errorEntries.length
      });

      lines.push('--------------------------------------------------------------------');
      lines.push(`PROJECT          : ${project.name} (${project.id})`);
      lines.push(`Path             : ${project.path}`);
      lines.push(`Stack            : ${project.programType || project.framework || 'Unknown'}${project.language ? ` [${project.language}]` : ''}`);
      lines.push(`Command          : ${project.command}`);
      lines.push(`Status           : ${String(state.status || 'stopped').toUpperCase()}`);
      lines.push(`Last Exit Code   : ${state.exitCode !== null && state.exitCode !== undefined ? state.exitCode : 'n/a'}`);
      lines.push(`Assigned Port    : ${state.assignedPort || project.customPort || project.defaultPort || 'n/a'}`);
      lines.push(`Log File         : ${logData.logFilePath} (${logData.fileSize || 0} bytes)`);
      lines.push('');

      if (errorEntries.length > 0) {
        lines.push(`--- Highlighted Errors / Crash Lines (${errorEntries.length}) ---`);
        for (const entry of errorEntries.slice(-60)) {
          lines.push(`[${entry.timestamp || generatedAt}] [${String(entry.stream || 'stderr').toUpperCase()}] ${entry.text}`);
        }
        lines.push('');
      } else {
        lines.push('--- Highlighted Errors / Crash Lines (0 stderr/failure lines in recent tail) ---');
        lines.push('');
      }

      lines.push(`--- Recent Console Tail (last ${tailEntries.length} lines) ---`);
      if (tailEntries.length === 0) {
        lines.push('(No recorded log lines yet for this project.)');
      } else {
        for (const entry of tailEntries) {
          lines.push(`[${entry.timestamp || generatedAt}] [${String(entry.stream || 'stdout').toUpperCase()}] ${entry.text}`);
        }
      }
      lines.push('');
    }
  }

  return {
    fileName,
    content: lines.join('\n'),
    crashedCount: crashedProjects.length,
    includedProjects,
    generatedAt
  };
}

function buildEnvironmentConfig(clientLayout = null) {
  ensureDirectories();
  if (clientLayout && typeof clientLayout === 'object') {
    saveLayout(clientLayout);
  }
  const generatedAt = new Date().toISOString();
  const safeStamp = generatedAt.replace(/[:.]/g, '-');
  const userSlug = settings.userName
    ? String(settings.userName)
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
    : '';
  const fileName = `portly-config-${userSlug ? `${userSlug}-` : ''}${safeStamp}.json`;

  const configObj = {
    app: 'Portly',
    schemaVersion: 1,
    exportedAt: generatedAt,
    settings: {
      userName: settings.userName,
      theme: settings.theme,
      defaultExpanded: Boolean(settings.defaultExpanded),
      allowMultipleInstances: Boolean(settings.allowMultipleInstances),
      exitClosesCompletely: Boolean(settings.exitClosesCompletely),
      onboarded: Boolean(settings.onboarded)
    },
    layout: { ...savedLayout },
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      command: p.command,
      customPort: p.customPort || '',
      framework: p.framework,
      language: p.language,
      programType: p.programType,
      techStack: Array.isArray(p.techStack) ? p.techStack : [],
      defaultPort: p.defaultPort || 3000,
      recommendedCommand: p.recommendedCommand || p.command,
      deployNote: p.deployNote || '',
      hostname: p.hostname || '',
      ...(p.kind ? { kind: p.kind } : {}),
      ...(p.stackId ? { stackId: p.stackId, startAfter: Array.isArray(p.startAfter) ? p.startAfter : [] } : {})
    })),
    // Environment variable values are never exported: they often hold secrets.
    stacks: stacks.map((s) => ({
      id: s.id,
      name: s.name,
      path: s.path || '',
      hostname: s.hostname || '',
      primaryServiceId: s.primaryServiceId || null
    }))
  };

  return {
    fileName,
    content: JSON.stringify(configObj, null, 2),
    config: configObj,
    generatedAt
  };
}

/**
 * The existing project an imported item updates, if any: the same id, else the same
 * folder (stand-alone projects) or the same folder and command in the same stack.
 */
function findImportMatch(itemObj, resolvedPath, command, mapStackId) {
  if (typeof itemObj.id === 'string') {
    const byId = projects.find((p) => p.id === itemObj.id);
    if (byId && normalizePathKey(byId.path) === normalizePathKey(resolvedPath)) return byId;
  }
  const stackId = itemObj.stackId ? mapStackId(itemObj.stackId) : null;
  return (
    findDuplicateProject(resolvedPath, {
      stackId: stackId || null,
      command: command || itemObj.command || null
    }) || null
  );
}

/** Creates or updates the stacks listed in a config file. Returns oldId -> newId. */
function importStacks(rawStacks, mode) {
  const map = new Map();
  if (!Array.isArray(rawStacks)) return map;
  for (const raw of rawStacks) {
    if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) continue;
    const oldId = typeof raw.id === 'string' ? raw.id : null;
    let stack = mode === 'merge' && oldId ? stacks.find((s) => s.id === oldId) : null;
    if (stack) {
      stack.name = raw.name.trim();
    } else {
      stack = {
        id: oldId && UUID_REGEX.test(oldId) && !stacks.some((s) => s.id === oldId) ? oldId : crypto.randomUUID(),
        name: raw.name.trim(),
        path: '',
        hostname: '',
        primaryServiceId: null,
        createdAt: new Date().toISOString()
      };
      stacks.push(stack);
    }
    const cleanedRoot = cleanPathInput(raw.path);
    if (cleanedRoot && fs.existsSync(cleanedRoot)) stack.path = path.resolve(cleanedRoot);
    let wanted = '';
    try {
      wanted = raw.hostname ? namedUrls.normalizeHostnameInput(raw.hostname) : '';
    } catch {
      wanted = '';
    }
    if (!stack.hostname || (wanted && wanted !== stack.hostname)) {
      stack.hostname = wanted && !isHostnameTaken(wanted, { stackId: stack.id })
        ? wanted
        : uniqueHostname(namedUrls.slugifyHostname(stack.name), { stackId: stack.id });
    }
    stack._importPrimary = raw.primaryServiceId || null;
    if (oldId) map.set(oldId, stack.id);
  }
  return map;
}

/**
 * Lists what an import would do to start commands, without changing anything.
 * Returns { mode, replacesProjects, commandChanges: [{ name, path, from, to, isNew }] }.
 */
function reviewConfigImport(src, rawPayload = {}) {
  const result = { mode: 'replace', replacesProjects: 0, commandChanges: [] };
  if (!src || (!Array.isArray(src.projects) && !Array.isArray(src.paths))) {
    return result;
  }
  const rawItems = Array.isArray(src.projects)
    ? src.projects
    : src.paths.map((p) => (typeof p === 'string' ? { path: p } : p));
  const mode = rawPayload.mode === 'merge' || src.mode === 'merge' ? 'merge' : 'replace';
  result.mode = mode;
  if (mode === 'replace') {
    result.replacesProjects = projects.length;
  }

  for (const item of rawItems) {
    const itemObj = item && typeof item === 'object' ? item : {};
    const cleaned = cleanPathInput(typeof item === 'string' ? item : itemObj.path);
    if (!cleaned) continue;
    const command = itemObj.command ? String(itemObj.command).trim() : '';
    if (!command) continue;
    const resolvedPath = path.resolve(cleaned);
    if (!fs.existsSync(resolvedPath)) continue;
    const existing =
      mode === 'merge' || projects.length > 0
        ? findImportMatch(itemObj, resolvedPath, command, (id) => id)
        : null;
    if (existing && existing.command === command) continue;
    const name = (itemObj.name && String(itemObj.name).trim()) || path.basename(resolvedPath);
    result.commandChanges.push({
      name,
      path: resolvedPath,
      from: existing ? existing.command : null,
      to: command,
      isNew: !existing
    });
  }
  return result;
}

async function applyEnvironmentConfig(rawPayload = {}) {
  const src =
    rawPayload && typeof rawPayload.config === 'object' && rawPayload.config
      ? rawPayload.config
      : rawPayload;

  const hasValidSection =
    src &&
    typeof src === 'object' &&
    !Array.isArray(src) &&
    (src.settings !== undefined ||
      src.layout !== undefined ||
      src.projects !== undefined ||
      src.paths !== undefined ||
      typeof src.userName === 'string');

  if (!hasValidSection) {
    const err = new Error('Invalid Portly config file.');
    err.statusCode = 400;
    throw err;
  }

  // Config files are meant to be shared between machines, so treat them as untrusted:
  // any command they would add or change must be confirmed by the user before it is saved.
  const review = reviewConfigImport(src, rawPayload);
  if (
    (review.commandChanges.length > 0 || review.replacesProjects > 0) &&
    rawPayload.confirmCommands !== true
  ) {
    const err = new Error(
      review.commandChanges.length > 0
        ? 'This config adds or changes start commands. Review them before importing.'
        : 'This config replaces your current project list. Confirm before importing.'
    );
    err.statusCode = 409;
    err.details = {
      needsConfirmation: true,
      commandChanges: review.commandChanges,
      replacesProjects: review.replacesProjects,
      mode: review.mode
    };
    throw err;
  }

  if (
    (src.settings && typeof src.settings === 'object') ||
    src.userName !== undefined ||
    src.theme !== undefined ||
    src.defaultExpanded !== undefined ||
    src.allowMultipleInstances !== undefined ||
    src.exitClosesCompletely !== undefined
  ) {
    const sSrc = src.settings && typeof src.settings === 'object' ? src.settings : {};
    const nextUserName =
      typeof sSrc.userName === 'string'
        ? sSrc.userName
        : typeof src.userName === 'string'
          ? src.userName
          : settings.userName;
    const nextTheme =
      sSrc.theme !== undefined
        ? sSrc.theme
        : src.theme !== undefined
          ? src.theme
          : settings.theme;
    const nextDefaultExpanded =
      sSrc.defaultExpanded !== undefined
        ? sSrc.defaultExpanded
        : src.defaultExpanded !== undefined
          ? src.defaultExpanded
          : settings.defaultExpanded;
    const nextAllowMultipleInstances =
      sSrc.allowMultipleInstances !== undefined
        ? sSrc.allowMultipleInstances
        : src.allowMultipleInstances !== undefined
          ? src.allowMultipleInstances
          : settings.allowMultipleInstances;
    const nextExitClosesCompletely =
      sSrc.exitClosesCompletely !== undefined
        ? sSrc.exitClosesCompletely
        : src.exitClosesCompletely !== undefined
          ? src.exitClosesCompletely
          : settings.exitClosesCompletely;
    const hasName = Boolean(nextUserName && String(nextUserName).trim());
    const nextOnboarded =
      sSrc.onboarded !== undefined ? Boolean(sSrc.onboarded) && hasName : hasName;

    saveSettings({
      userName: nextUserName,
      theme: nextTheme,
      defaultExpanded: nextDefaultExpanded,
      allowMultipleInstances: nextAllowMultipleInstances,
      exitClosesCompletely: nextExitClosesCompletely,
      onboarded: nextOnboarded
    });
  }

  if (src.layout && typeof src.layout === 'object') {
    saveLayout(src.layout);
  }

  let importedProjectsCount = 0;
  const skippedMissingPaths = [];
  const brokenProjects = [];

  if (Array.isArray(src.projects) || Array.isArray(src.paths)) {
    const rawItems = Array.isArray(src.projects)
      ? src.projects
      : src.paths.map((p) => (typeof p === 'string' ? { path: p } : p));
    const mode = rawPayload.mode === 'merge' || src.mode === 'merge' ? 'merge' : 'replace';

    if (mode === 'replace') {
      await stopAllProjects();
      projects = [];
      runtimeState.clear();
      stacks = [];
      stackRuntime.clear();
    }
    const stackIdMap = importStacks(src.stacks, mode);
    const mapStackId = (oldId) => stackIdMap.get(oldId) || null;
    const projectIdMap = new Map(); // id in the file -> id here
    const importedItems = []; // [record, itemObj]

    for (const item of rawItems) {
      const rawPath = typeof item === 'string' ? item : item && item.path;
      const cleaned = cleanPathInput(rawPath);
      if (!cleaned) continue;

      const resolvedPath = path.resolve(cleaned);
      const itemObj = item && typeof item === 'object' ? item : {};
      const exists = fs.existsSync(resolvedPath);
      const isDir = exists && fs.statSync(resolvedPath).isDirectory();
      if (!exists || !isDir) {
        skippedMissingPaths.push(resolvedPath);
        brokenProjects.push({
          name:
            (itemObj.name && String(itemObj.name).trim()) ||
            path.basename(resolvedPath) ||
            'Project',
          brokenPath: resolvedPath,
          rawPath: cleaned,
          command:
            (itemObj.command && String(itemObj.command).trim()) || 'npm run dev',
          customPort: lenientPort(itemObj.customPort),
          language: itemObj.language || '',
          framework: itemObj.framework || '',
          programType: itemObj.programType || '',
          defaultPort: Number(itemObj.defaultPort) || 3000,
          error: !exists
            ? 'Directory does not exist on this machine.'
            : 'Path is not a directory.'
        });
        continue;
      }
      const importCommand = itemObj.command ? String(itemObj.command).trim() : '';
      const existing = findImportMatch(itemObj, resolvedPath, importCommand, mapStackId);
      const inspection = inspectProjectPath(resolvedPath);

      if (existing) {
        if (itemObj.name && String(itemObj.name).trim()) {
          existing.name = String(itemObj.name).trim();
        }
        if (itemObj.command && String(itemObj.command).trim()) {
          existing.command = String(itemObj.command).trim();
        }
        if (itemObj.customPort !== undefined) {
          existing.customPort = lenientPort(itemObj.customPort);
        }
        if (inspection.valid) {
          applyInspectionToProject(existing, inspection, false);
        }
        if (typeof itemObj.id === 'string') projectIdMap.set(itemObj.id, existing.id);
        importedItems.push([existing, itemObj]);
        importedProjectsCount += 1;
        continue;
      }

      const portStr = lenientPort(itemObj.customPort);

      const fallbackName = path.basename(resolvedPath) || 'project';
      const record = {
        // Config files can come from other machines, so only keep an id that is a plain UUID.
        id:
          typeof itemObj.id === 'string' &&
          UUID_REGEX.test(itemObj.id) &&
          !projects.some((p) => p.id === itemObj.id)
            ? itemObj.id
            : crypto.randomUUID(),
        name:
          itemObj.name && String(itemObj.name).trim()
            ? String(itemObj.name).trim()
            : inspection.valid
              ? inspection.name
              : fallbackName,
        path: resolvedPath,
        command:
          itemObj.command && String(itemObj.command).trim()
            ? String(itemObj.command).trim()
            : inspection.valid
              ? inspection.recommendedCommand || inspection.suggestedCommand
              : 'npm run dev',
        customPort: portStr,
        createdAt: new Date().toISOString(),
        lastStartedAt: null
      };

      if (inspection.valid) {
        applyInspectionToProject(record, inspection, false);
      } else {
        record.language = itemObj.language || 'Unknown';
        record.framework = itemObj.framework || 'Custom';
        record.programType = itemObj.programType || 'Local App';
        record.techStack = Array.isArray(itemObj.techStack) ? itemObj.techStack : [];
        record.defaultPort = Number(itemObj.defaultPort) || 3000;
        record.recommendedCommand = itemObj.recommendedCommand || record.command;
        record.deployNote = itemObj.deployNote || '';
        record.scripts = {};
      }

      projects.push(record);
      getRuntimeState(record.id);
      if (typeof itemObj.id === 'string') projectIdMap.set(itemObj.id, record.id);
      importedItems.push([record, itemObj]);
      importedProjectsCount += 1;
    }

    // Stack membership, start order, kind and web address, now that every id is known.
    for (const [record, itemObj] of importedItems) {
      const mapped = itemObj.stackId ? mapStackId(itemObj.stackId) : null;
      if (mapped) {
        record.stackId = mapped;
        record.startAfter = (Array.isArray(itemObj.startAfter) ? itemObj.startAfter : [])
          .map((id) => projectIdMap.get(id))
          .filter((id) => id && id !== record.id);
      } else if (itemObj.stackId === undefined && !record.stackId) {
        delete record.startAfter;
      }
      if (itemObj.kind !== undefined) record.kind = cleanServiceKind(itemObj.kind);
      let wanted = '';
      try {
        wanted = itemObj.hostname ? namedUrls.normalizeHostnameInput(itemObj.hostname) : '';
      } catch {
        wanted = '';
      }
      if (wanted && wanted !== record.hostname && !isHostnameTaken(wanted, { projectId: record.id })) {
        record.hostname = wanted;
      } else if (!record.hostname) {
        record.hostname = defaultHostnameFor(record);
      }
    }
    for (const s of stacks) {
      if (s._importPrimary !== undefined) {
        const mappedPrimary = s._importPrimary ? projectIdMap.get(s._importPrimary) : null;
        if (mappedPrimary) s.primaryServiceId = mappedPrimary;
        delete s._importPrimary;
      }
      // A start-after loop from a hand-edited file would block the stack: drop the rules.
      try {
        orderStackServices(getStackServices(s.id));
      } catch {
        for (const svc of getStackServices(s.id)) svc.startAfter = [];
      }
    }
    // Stacks from the file whose services were all missing are dropped.
    const importedStackIds = new Set(stackIdMap.values());
    stacks = stacks.filter((s) => !importedStackIds.has(s.id) || getStackServices(s.id).length > 0);
    repairStacksAndHostnames();
    saveProjects();
    saveStacks();
  }

  const serializedProjects = projects.map(serializeProject);
  const serializedStacks = listStacksSerialized();
  broadcastEvent('settings-updated', settings);
  broadcastEvent('config-imported', {
    settings,
    layout: savedLayout,
    projects: serializedProjects,
    stacks: serializedStacks,
    brokenProjects
  });

  return {
    ok: true,
    settings,
    layout: savedLayout,
    projects: serializedProjects,
    stacks: serializedStacks,
    importedProjectsCount,
    skippedMissingPaths,
    brokenProjects
  };
}

function runPickerCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      const selected = stdout.trim();
      if (selected) {
        resolve({ path: selected });
        return;
      }
      if (code === 0 || code === 1) {
        resolve({ path: null });
        return;
      }
      if (stderr && /user canceled|-128/i.test(stderr)) {
        resolve({ path: null });
        return;
      }
      reject(new Error((stderr || '').trim() || `Folder picker exited with code ${code}`));
    });
  });
}

function getWindowsModernPickerScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$code = @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    '[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]',
    'internal class FileOpenDialogRCW {}',
    '[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    'public interface IFileOpenDialog {',
    '    [PreserveSig] int Show([In] IntPtr parent);',
    '    void SetFileTypes();',
    '    void SetFileTypeIndex([In] uint iFileType);',
    '    void GetFileTypeIndex(out uint piFileType);',
    '    void Advise();',
    '    void Unadvise();',
    '    void SetOptions([In] uint fos);',
    '    void GetOptions(out uint pfos);',
    '    void SetDefaultFolder([In, MarshalAs(UnmanagedType.Interface)] IShellItem psi);',
    '    void SetFolder([In, MarshalAs(UnmanagedType.Interface)] IShellItem psi);',
    '    void GetFolder([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);',
    '    void GetCurrentSelection([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);',
    '    void SetFileName([In, MarshalAs(UnmanagedType.LPWStr)] string pszName);',
    '    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);',
    '    void SetTitle([In, MarshalAs(UnmanagedType.LPWStr)] string pszTitle);',
    '    void SetOkButtonLabel([In, MarshalAs(UnmanagedType.LPWStr)] string pszText);',
    '    void SetFileNameLabel([In, MarshalAs(UnmanagedType.LPWStr)] string pszLabel);',
    '    void GetResult([MarshalAs(UnmanagedType.Interface)] out IShellItem ppsi);',
    '}',
    '[ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]',
    'public interface IShellItem {',
    '    void BindToHandler();',
    '    void GetParent();',
    '    void GetDisplayName([In] uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);',
    '    void GetAttributes();',
    '    void Compare();',
    '}',
    'public static class ModernFolderPicker {',
    '    [DllImport("user32.dll")]',
    '    private static extern IntPtr GetForegroundWindow();',
    '    public static IFileOpenDialog CreateConfigured() {',
    '        var dlg = (IFileOpenDialog)new FileOpenDialogRCW();',
    '        uint opts;',
    '        dlg.GetOptions(out opts);',
    '        dlg.SetOptions(opts | 0x00000020 | 0x00000040 | 0x00000800);',
    '        dlg.SetTitle("Select Project Folder");',
    '        dlg.SetOkButtonLabel("Select Folder");',
    '        return dlg;',
    '    }',
    '    public static string PickFolder() {',
    '        var dlg = CreateConfigured();',
    '        try {',
    '            IntPtr hwnd = GetForegroundWindow();',
    '            int hr = dlg.Show(hwnd);',
    '            if (hr != 0) return "";',
    '            IShellItem item;',
    '            dlg.GetResult(out item);',
    '            if (item == null) return "";',
    '            string path;',
    '            item.GetDisplayName(0x80058000, out path);',
    '            return path ?? "";',
    '        } finally {',
    '            if (Marshal.IsComObject(dlg)) Marshal.FinalReleaseComObject(dlg);',
    '        }',
    '    }',
    '}',
    "'@",
    'try {',
    '    Add-Type -TypeDefinition $code -Language CSharp',
    '    $selected = [ModernFolderPicker]::PickFolder()',
    '    if ($selected) { Write-Output $selected }',
    '} catch {',
    '    Add-Type -AssemblyName System.Windows.Forms',
    '    $owner = New-Object System.Windows.Forms.Form',
    '    $owner.TopMost = $true',
    '    $f = New-Object System.Windows.Forms.FolderBrowserDialog',
    '    $f.Description = "Select Project Folder"',
    '    $f.UseDescriptionForTitle = $true',
    '    if ($f.ShowDialog($owner) -eq "OK") { Write-Output $f.SelectedPath }',
    '    $owner.Dispose()',
    '}'
  ].join('\n');
}

async function pickFolderDialog() {
  if (customFolderPicker) {
    return await customFolderPicker();
  }

  if (process.platform === 'win32') {
    const encoded = Buffer.from(getWindowsModernPickerScript(), 'utf16le').toString('base64');
    return runPickerCommand('powershell.exe', ['-NoProfile', '-Sta', '-EncodedCommand', encoded]);
  }

  if (process.platform === 'darwin') {
    return runPickerCommand('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "Select Project Folder")'
    ]);
  }

  const linuxCandidates = [
    ['zenity', ['--file-selection', '--directory', '--title=Select Project Folder']],
    ['kdialog', ['--getexistingdirectory', os.homedir(), 'Select Project Folder']],
    [
      'python3',
      [
        '-c',
        'import tkinter as tk; from tkinter import filedialog; r = tk.Tk(); r.withdraw(); print(filedialog.askdirectory(title="Select Project Folder") or "")'
      ]
    ]
  ];

  for (const [cmd, args] of linuxCandidates) {
    try {
      return await runPickerCommand(cmd, args);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    'No native folder dialog found (tried zenity, kdialog, python3 tkinter). Paste the path directly.'
  );
}

function openFolderInOS(targetPath) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', [targetPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    }).unref();
    return;
  }

  if (process.platform === 'darwin') {
    spawn('open', [targetPath], {
      detached: true,
      stdio: 'ignore'
    }).unref();
    return;
  }

  spawn('xdg-open', [targetPath], {
    detached: true,
    stdio: 'ignore'
  }).unref();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('Request payload too large.');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error('Invalid JSON body.');
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStaticFile(res, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(PUBLIC_DIR, relativePath);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff'
  };
  if (ext === '.html') {
    // The UI can add and start commands, so lock it down: no inline or third-party scripts.
    headers['Content-Security-Policy'] =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
  }
  const stream = fs.createReadStream(resolved);
  stream.on('error', (err) => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: `Could not read ${relativePath}: ${err.code || err.message}` });
    } else {
      res.destroy();
    }
  });
  stream.once('open', () => {
    res.writeHead(200, headers);
    stream.pipe(res);
  });
}

async function handleApi(req, res, pathname) {
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    res.write('event: connected\ndata: {"ok":true}\n\n');
    sseClients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(heartbeat);
        sseClients.delete(res);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/projects') {
    sendJson(res, 200, projects.map(serializeProject));
    return;
  }

  if (method === 'GET' && pathname === '/api/notices') {
    sendJson(res, 200, { notices: startupNotices });
    return;
  }

  if (method === 'GET' && pathname === '/api/system') {
    sendJson(res, 200, getSystemInfo());
    return;
  }

  if (method === 'GET' && pathname === '/api/settings') {
    sendJson(res, 200, settings);
    return;
  }

  if (method === 'PUT' && pathname === '/api/settings') {
    const body = await readJsonBody(req);
    const updated = saveSettings({
      userName: body.userName !== undefined ? body.userName : settings.userName,
      theme: body.theme !== undefined ? body.theme : settings.theme,
      defaultExpanded:
        body.defaultExpanded !== undefined ? body.defaultExpanded : settings.defaultExpanded,
      allowMultipleInstances:
        body.allowMultipleInstances !== undefined
          ? body.allowMultipleInstances
          : settings.allowMultipleInstances,
      exitClosesCompletely:
        body.exitClosesCompletely !== undefined
          ? body.exitClosesCompletely
          : settings.exitClosesCompletely,
      onboarded: body.onboarded !== undefined ? body.onboarded : settings.onboarded,
      namedUrls: body.namedUrls !== undefined ? body.namedUrls : settings.namedUrls,
      proxyPort: body.proxyPort !== undefined ? validateProxyPortInput(body.proxyPort) : settings.proxyPort
    });
    broadcastEvent('settings-updated', updated);
    let namedUrlResult = null;
    if (body.namedUrls !== undefined || body.proxyPort !== undefined) {
      namedUrlResult = await syncNamedUrlProxy();
    }
    sendJson(res, 200, namedUrlResult ? { ...updated, namedUrlStatus: getNamedUrlStatus() } : updated);
    return;
  }

  if (method === 'POST' && pathname === '/api/settings/reset') {
    const reset = resetSettings();
    sendJson(res, 200, reset);
    return;
  }

  if (method === 'POST' && pathname === '/api/inspect') {
    const body = await readJsonBody(req);
    const result = inspectProjectPath(body.path);
    sendJson(res, 200, result);
    return;
  }

  if (method === 'POST' && pathname === '/api/projects') {
    const body = await readJsonBody(req);
    const created = createProjectRecord(body);
    broadcastProjectStatus(created);
    sendJson(res, 201, serializeProject(created));
    return;
  }

  if (method === 'POST' && pathname === '/api/projects/bulk') {
    const body = await readJsonBody(req);
    const rawPaths = Array.isArray(body.paths) ? body.paths : [];
    const scanSubfolders = Boolean(body.scanSubfolders);

    const added = [];
    const skipped = [];
    const errors = [];

    const candidateDirs = [];
    for (const raw of rawPaths) {
      const cleaned = cleanPathInput(raw);
      if (!cleaned) continue;

      const resolved = path.resolve(cleaned);
      if (!fs.existsSync(resolved)) {
        errors.push({ path: cleaned, error: 'Path does not exist.' });
        continue;
      }

      const stat = fs.statSync(resolved);
      const targetDir = stat.isDirectory() ? resolved : path.dirname(resolved);

      if (scanSubfolders) {
        const isProjectRoot = isSupportedProjectDir(targetDir);
        if (isProjectRoot && normalizePathKey(targetDir) !== normalizePathKey(ROOT_DIR)) {
          candidateDirs.push(targetDir);
        }
        const subProjects = scanDirectoryForProjects(targetDir);
        for (const sub of subProjects) {
          candidateDirs.push(sub);
        }
        if (!isProjectRoot && subProjects.length === 0) {
          errors.push({
            path: targetDir,
            error: 'No supported web project files found in folder or subfolders.'
          });
        }
      } else {
        candidateDirs.push(targetDir);
      }
    }

    const seenInBatch = new Set();
    for (const dir of candidateDirs) {
      const key = normalizePathKey(dir);
      if (seenInBatch.has(key)) continue;
      seenInBatch.add(key);

      try {
        const created = createProjectRecord({ path: dir });
        broadcastProjectStatus(created);
        added.push(serializeProject(created));
      } catch (err) {
        if (err.statusCode === 409) {
          skipped.push({ path: dir, reason: 'Already registered' });
        } else {
          errors.push({ path: dir, error: err.message });
        }
      }
    }

    sendJson(res, 200, { added, skipped, errors });
    return;
  }

  if (method === 'POST' && pathname === '/api/projects/stop-all') {
    const updated = await stopAllProjects();
    sendJson(res, 200, updated);
    return;
  }

  if (method === 'POST' && pathname === '/api/pick-folder') {
    const picked = await pickFolderDialog();
    sendJson(res, 200, picked);
    return;
  }

  if (method === 'POST' && pathname === '/api/window-control') {
    const body = await readJsonBody(req);
    const action = String(body.action || 'status');
    if (typeof customWindowController === 'function') {
      const result = await customWindowController(action, body);
      sendJson(res, 200, { ok: true, frameless: true, ...(result || {}) });
    } else if (action === 'focus') {
      if (!settings.allowMultipleInstances) {
        const notice = notifyInstanceActivation({
          restoredFrom: 'desktop',
          allowMultipleInstances: false,
          message:
            'Only 1 instance of Portly can be used at a time (enable Multiple Instances in Settings to run more).'
        });
        sendJson(res, 200, {
          ok: true,
          frameless: false,
          action,
          handledSingleInstance: true,
          allowMultipleInstances: false,
          restoredFrom: notice.restoredFrom,
          activeClients: sseClients.size
        });
      } else {
        sendJson(res, 200, {
          ok: true,
          frameless: false,
          action,
          handledSingleInstance: true,
          allowMultipleInstances: true,
          openedNewWindow: true,
          activeClients: sseClients.size
        });
      }
    } else if (action === 'close') {
      sendJson(res, 200, {
        ok: true,
        frameless: false,
        action,
        quitting: Boolean(settings.exitClosesCompletely),
        hiddenToTray: !settings.exitClosesCompletely
      });
    } else {
      sendJson(res, 200, { ok: true, frameless: false, action });
    }
    return;
  }

  if (pathname === '/api/crash-reports/export' && (method === 'POST' || method === 'GET')) {
    const reqUrl = new URL(req.url || '/', 'http://localhost');
    let body = {};
    if (method === 'POST') {
      body = await readJsonBody(req);
    }
    const targetProjectId =
      (body.projectId && String(body.projectId).trim()) ||
      reqUrl.searchParams.get('projectId') ||
      null;
    const report = buildCrashReport(targetProjectId);
    const archivePath = path.join(CRASH_REPORTS_DIR, report.fileName);
    fs.writeFileSync(archivePath, report.content, 'utf8');

    if (method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="${report.fileName}"`,
        'X-Portly-Archive-Path': archivePath,
        'Cache-Control': 'no-store'
      });
      res.end(report.content);
      return;
    }

    if (body.saveDialog !== false && typeof customCrashReportSaver === 'function') {
      const dialogResult = await customCrashReportSaver({
        defaultFileName: report.fileName,
        content: report.content
      });
      if (dialogResult && !dialogResult.canceled && dialogResult.filePath) {
        fs.mkdirSync(path.dirname(dialogResult.filePath), { recursive: true });
        fs.writeFileSync(dialogResult.filePath, report.content, 'utf8');
        sendJson(res, 200, {
          ok: true,
          savedPath: dialogResult.filePath,
          archivePath,
          fileName: report.fileName,
          content: report.content,
          crashedCount: report.crashedCount,
          includedProjects: report.includedProjects,
          dialogUsed: true,
          canceled: false
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        canceled: true,
        savedPath: archivePath,
        archivePath,
        fileName: report.fileName,
        content: report.content,
        crashedCount: report.crashedCount,
        includedProjects: report.includedProjects,
        dialogUsed: true
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      savedPath: archivePath,
      archivePath,
      fileName: report.fileName,
      content: report.content,
      crashedCount: report.crashedCount,
      includedProjects: report.includedProjects,
      dialogUsed: false
    });
    return;
  }

  if (pathname === '/api/config/export' && (method === 'POST' || method === 'GET')) {
    let body = {};
    if (method === 'POST') {
      body = await readJsonBody(req);
    }
    const configExport = buildEnvironmentConfig(body.layout || null);
    const archivePath = path.join(CONFIGS_DIR, configExport.fileName);
    fs.writeFileSync(archivePath, configExport.content, 'utf8');

    if (method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${configExport.fileName}"`,
        'X-Portly-Archive-Path': archivePath,
        'Cache-Control': 'no-store'
      });
      res.end(configExport.content);
      return;
    }

    if (body.saveDialog !== false && typeof customConfigSaver === 'function') {
      const dialogResult = await customConfigSaver({
        defaultFileName: configExport.fileName,
        content: configExport.content
      });
      if (dialogResult && !dialogResult.canceled && dialogResult.filePath) {
        fs.mkdirSync(path.dirname(dialogResult.filePath), { recursive: true });
        fs.writeFileSync(dialogResult.filePath, configExport.content, 'utf8');
        sendJson(res, 200, {
          ok: true,
          savedPath: dialogResult.filePath,
          archivePath,
          fileName: configExport.fileName,
          config: configExport.config,
          content: configExport.content,
          dialogUsed: true,
          canceled: false
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        canceled: true,
        savedPath: archivePath,
        archivePath,
        fileName: configExport.fileName,
        config: configExport.config,
        content: configExport.content,
        dialogUsed: true
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      savedPath: archivePath,
      archivePath,
      fileName: configExport.fileName,
      config: configExport.config,
      content: configExport.content,
      dialogUsed: false
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/config/import') {
    const body = await readJsonBody(req);
    const result = await applyEnvironmentConfig(body);
    sendJson(res, 200, result);
    return;
  }

  // ---------------- stacks ----------------
  if (method === 'GET' && pathname === '/api/stacks') {
    sendJson(res, 200, listStacksSerialized());
    return;
  }

  if (method === 'POST' && pathname === '/api/stacks/suggest') {
    const body = await readJsonBody(req);
    sendJson(res, 200, suggestStackFromPath(body.path));
    return;
  }

  if (method === 'POST' && pathname === '/api/stacks') {
    const body = await readJsonBody(req);
    const stack = createStackRecord(body);
    sendJson(res, 201, {
      stack: serializeStack(stack),
      services: getStackServices(stack.id).map(serializeProject)
    });
    return;
  }

  const stackActionMatch = pathname.match(/^\/api\/stacks\/([^/]+)(?:\/(start|stop|restart))?$/);
  if (stackActionMatch) {
    const stackId = decodeURIComponent(stackActionMatch[1]);
    const action = stackActionMatch[2] || '';
    if (!action && method === 'GET') {
      sendJson(res, 200, serializeStack(findStackOrThrow(stackId)));
      return;
    }
    if (!action && method === 'PUT') {
      const body = await readJsonBody(req);
      sendJson(res, 200, updateStackRecord(stackId, body));
      return;
    }
    if (!action && method === 'DELETE') {
      const keepServices = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('keepServices') === '1';
      sendJson(res, 200, await deleteStackRecord(stackId, { keepServices }));
      return;
    }
    if (action === 'start' && method === 'POST') {
      sendJson(res, 200, await startStack(stackId));
      return;
    }
    if (action === 'stop' && method === 'POST') {
      sendJson(res, 200, await stopStack(stackId));
      return;
    }
    if (action === 'restart' && method === 'POST') {
      sendJson(res, 200, await restartStack(stackId));
      return;
    }
  }

  // ---------------- environment variables ----------------
  const envMatch = pathname.match(/^\/api\/env\/([^/]+)(?:\/(import-file|profile))?$/);
  if (envMatch) {
    const ownerId = decodeURIComponent(envMatch[1]);
    const action = envMatch[2] || '';
    if (!action && method === 'GET') {
      sendJson(res, 200, describeEnv(ownerId));
      return;
    }
    if (!action && method === 'PUT') {
      getEnvOwner(ownerId);
      const body = await readJsonBody(req);
      envStore.set(ownerId, body);
      afterEnvChange(ownerId);
      sendJson(res, 200, describeEnv(ownerId));
      return;
    }
    if (action === 'profile' && method === 'POST') {
      getEnvOwner(ownerId);
      const body = await readJsonBody(req);
      envStore.setActiveProfile(ownerId, String(body.profile || ''));
      afterEnvChange(ownerId);
      sendJson(res, 200, describeEnv(ownerId));
      return;
    }
    if (action === 'import-file' && method === 'POST') {
      // Reads one of the known .env files from the project's folder. Nothing is saved:
      // the UI shows the rows so the user can review them before saving.
      const { dir } = getEnvOwner(ownerId);
      const body = await readJsonBody(req);
      if (!dir) {
        sendJson(res, 400, { error: 'This stack has no main folder to read .env files from.' });
        return;
      }
      sendJson(res, 200, { file: String(body.file || ''), vars: envStoreLib.readEnvFile(dir, String(body.file || '')) });
      return;
    }
  }

  // ---------------- named URLs ----------------
  if (method === 'GET' && pathname === '/api/named-urls') {
    sendJson(res, 200, getNamedUrlStatus());
    return;
  }

  const projectActionMatch = pathname.match(
    /^\/api\/projects\/([^/]+)(?:\/(start|stop|restart|reanalyze|logs|open-folder))?$/
  );

  if (projectActionMatch) {
    const id = decodeURIComponent(projectActionMatch[1]);
    const action = projectActionMatch[2] || '';

    if (!action && method === 'PUT') {
      const project = findProjectOrThrow(id);
      const body = await readJsonBody(req);

      let nextPath = project.path;
      let inspection = null;
      if (body.path !== undefined) {
        inspection = inspectProjectPath(body.path);
        if (!inspection.valid) {
          sendJson(res, 400, { error: inspection.error });
          return;
        }
        const dup = findDuplicateProject(inspection.resolvedPath, {
          stackId: project.stackId || null,
          command: body.command !== undefined ? String(body.command).trim() : project.command,
          excludeId: id
        });
        if (dup) {
          sendJson(res, 409, { error: `Another project already uses ${dup.path}` });
          return;
        }
        nextPath = inspection.resolvedPath;
      } else {
        inspection = inspectProjectPath(project.path);
      }

      // Check the stack fields first, so a bad value changes nothing.
      const before = JSON.stringify(project);
      try {
        applyServiceFields(project, body);
      } catch (err) {
        Object.keys(project).forEach((k) => delete project[k]);
        Object.assign(project, JSON.parse(before));
        throw err;
      }

      project.path = nextPath;
      if (body.name !== undefined && String(body.name).trim()) {
        project.name = String(body.name).trim();
      }
      if (body.command !== undefined && String(body.command).trim()) {
        project.command = String(body.command).trim();
      }
      if (body.customPort !== undefined) {
        project.customPort = normalizePortInput(body.customPort);
      }
      if (inspection && inspection.valid) {
        applyInspectionToProject(project, inspection, false);
      }

      saveProjects();
      saveStacks();
      broadcastProjectStatus(project);
      sendJson(res, 200, serializeProject(project));
      return;
    }

    if (!action && method === 'DELETE') {
      await removeProjectRecord(id);
      sendJson(res, 200, { ok: true, id });
      return;
    }

    if (action === 'reanalyze' && method === 'POST') {
      const project = findProjectOrThrow(id);
      const inspection = inspectProjectPath(project.path);
      if (!inspection.valid) {
        sendJson(res, 400, { error: inspection.error });
        return;
      }
      applyInspectionToProject(project, inspection, true);
      saveProjects();
      broadcastProjectStatus(project);
      sendJson(res, 200, serializeProject(project));
      return;
    }

    if (action === 'start' && method === 'POST') {
      const updated = await startProject(id);
      sendJson(res, 200, updated);
      return;
    }

    if (action === 'stop' && method === 'POST') {
      const updated = await stopProject(id);
      sendJson(res, 200, updated);
      return;
    }

    if (action === 'restart' && method === 'POST') {
      const updated = await restartProject(id);
      sendJson(res, 200, updated);
      return;
    }

    if (action === 'logs' && method === 'GET') {
      const result = await readProjectLogs(id);
      sendJson(res, 200, result);
      return;
    }

    if (action === 'logs' && method === 'DELETE') {
      const result = await clearProjectLogs(id);
      sendJson(res, 200, result);
      return;
    }

    if (action === 'open-folder' && method === 'POST') {
      const project = findProjectOrThrow(id);
      if (!fs.existsSync(project.path)) {
        sendJson(res, 400, { error: `Folder not found: ${project.path}` });
        return;
      }
      openFolderInOS(project.path);
      sendJson(res, 200, { ok: true, fileManager: getSystemInfo().fileManagerLabel });
      return;
    }
  }

  sendJson(res, 404, { error: 'API endpoint not found.' });
}

function cleanupAllRunningChildrenSync() {
  const pids = [];
  for (const [, state] of runtimeState.entries()) {
    clearProbeTimer(state);
    if (state.pid) pids.push(state.pid);
  }
  if (pids.length === 0) return;

  if (process.platform === 'win32') {
    // One taskkill call for every tree instead of one blocking call per project.
    const args = [];
    for (const pid of pids) args.push('/PID', String(pid));
    args.push('/T', '/F');
    try {
      execFileSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 15000 });
    } catch {
      // Ignore errors if some children already exited
    }
    return;
  }

  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Ignore errors if child already exited
      }
    }
  }
}

/** Last-resort handler: write the error to the crash-reports folder instead of dying silently. */
function recordInternalError(kind, err) {
  const text = err && err.stack ? err.stack : String(err);
  console.error(`Portly ${kind}:`, text);
  try {
    ensureDirectories();
    fs.appendFileSync(
      path.join(CRASH_REPORTS_DIR, 'portly-internal-errors.log'),
      `[${new Date().toISOString()}] ${kind}: ${text}\n`,
      'utf8'
    );
  } catch {
    // nothing else we can do
  }
}

loadSettings();
loadLayout();
loadOrSeedProjects();
loadStacks();

/**
 * Blocks cross-site and DNS-rebinding requests to the local API.
 * Portly can run arbitrary shell commands, so any web page the user visits must not be
 * able to talk to it. Only the Portly UI itself (same origin) and local non-browser
 * clients (no Origin header, e.g. the Electron main process or tests) are allowed.
 */
function getListeningPort() {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : PORT;
}

function isAllowedHostHeader(hostHeader) {
  if (!hostHeader) return false;
  const port = getListeningPort();
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  return allowed.includes(String(hostHeader).toLowerCase());
}

function isAllowedOrigin(origin) {
  const port = getListeningPort();
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(
    String(origin).toLowerCase()
  );
}

function rejectUntrustedRequest(req) {
  if (!isAllowedHostHeader(req.headers.host)) {
    return 'Invalid Host header.';
  }
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== 'null' && !isAllowedOrigin(origin)) {
    return 'Cross-origin requests are not allowed.';
  }
  if (origin === 'null') {
    return 'Cross-origin requests are not allowed.';
  }
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    return 'Cross-site requests are not allowed.';
  }
  return null;
}

const server = http.createServer(handleHttpRequest);
// The named URL proxy only makes sense while Portly itself is up.
server.on('close', () => {
  namedUrlProxy.stop().catch(() => {});
});

async function handleHttpRequest(req, res) {
  try {
    const rejection = rejectUntrustedRequest(req);
    if (rejection) {
      sendJson(res, 403, { error: rejection });
      return;
    }
    const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = reqUrl.pathname;

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }

    serveStaticFile(res, pathname);
  } catch (err) {
    const statusCode = err.statusCode || 500;
    if (statusCode >= 500) {
      console.error('Portly API error:', err && err.stack ? err.stack : err);
    }
    if (!res.headersSent) {
      sendJson(res, statusCode, {
        error: err.message || 'Internal Server Error',
        ...(err.details && typeof err.details === 'object' ? err.details : {})
      });
    } else {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
  }
}

let signalsRegistered = false;
function registerShutdownSignals() {
  if (signalsRegistered) return;
  signalsRegistered = true;
  process.on('SIGINT', () => {
    cleanupAllRunningChildrenSync();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanupAllRunningChildrenSync();
    process.exit(0);
  });
  if (process.platform !== 'win32') {
    // Closing the terminal that runs `node server.js` sends SIGHUP.
    process.on('SIGHUP', () => {
      cleanupAllRunningChildrenSync();
      process.exit(0);
    });
  }
  // Only take over uncaught errors when Portly is its own process; inside Electron the
  // main process installs its own handler.
  if (!process.versions.electron) {
    process.on('uncaughtException', (err) => recordInternalError('uncaughtException', err));
  }
  process.on('unhandledRejection', (err) => recordInternalError('unhandledRejection', err));
}

function startServer(listenPort = PORT) {
  registerShutdownSignals();
  // Warm up the login-shell PATH lookup (macOS/Linux) so the first Start doesn't wait on it.
  loadLoginShellPath();
  return new Promise((resolve, reject) => {
    if (server.listening) {
      const addr = server.address();
      const activePort = typeof addr === 'object' && addr ? addr.port : listenPort;
      resolve({ server, port: activePort, url: `http://localhost:${activePort}` });
      return;
    }

    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };

    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const activePort = typeof addr === 'object' && addr ? addr.port : listenPort;
      console.log(`Portly Local App Studio running at http://localhost:${activePort}`);
      console.log(`Platform: ${getSystemInfo().osName} (${process.platform}/${os.arch()})`);
      console.log(`Loaded ${projects.length} project(s) from ${PROJECTS_FILE}`);
      // Named URLs are a convenience: if the proxy can't start, Portly still runs.
      syncNamedUrlProxy()
        .then((r) => {
          if (r && !r.ok && r.error) startupNotices.push({ level: 'warning', message: r.error });
          else if (r && r.running) console.log(`Named URLs: http://<name>.localhost:${r.port}`);
        })
        .catch((err) => recordInternalError('namedUrlProxy', err))
        .finally(() => resolve({ server, port: activePort, url: `http://localhost:${activePort}` }));
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(listenPort, HOST);
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error(`Failed to start Portly server: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  PORT,
  HOST,
  server,
  startServer,
  stopAllProjects,
  cleanupAllRunningChildrenSync,
  getSystemInfo,
  getSettings,
  notifyInstanceActivation,
  inspectProjectPath,
  cleanPathInput,
  normalizePathKey,
  buildEffectiveCommand,
  buildCrossPlatformEnv,
  openFolderInOS,
  setCustomFolderPicker,
  setCustomWindowController,
  setCustomCrashReportSaver,
  setCustomConfigSaver,
  buildCrashReport,
  buildEnvironmentConfig,
  applyEnvironmentConfig,
  reviewConfigImport,
  recordInternalError,
  getWindowsModernPickerScript,
  startProject,
  stopProject,
  startStack,
  stopStack,
  restartStack,
  listStacksSerialized,
  setSecretCodec,
  syncNamedUrlProxy,
  stopNamedUrlProxy: () => namedUrlProxy.stop(),
  getNamedUrlStatus,
  composeProjectEnv,
  onProjectStatus,
  onSettingsChanged,
  listProjectsWithStatus
};
