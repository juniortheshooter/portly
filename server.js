'use strict';

const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { URL } = require('node:url');

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
// In packaged builds the app lives inside app.asar, which plain `node` cannot read, so the
// static server is shipped unpacked next to it (see build.asarUnpack in package.json).
const STATIC_SERVER_SCRIPT = path
  .join(ROOT_DIR, 'static-server.js')
  .replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

const MAX_MEMORY_LOGS = 500;
const MAX_READ_LOG_LINES = 200;
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
  fs.writeFileSync(LAYOUT_FILE, JSON.stringify(savedLayout, null, 2), 'utf8');
  return savedLayout;
}

function getDefaultSettings() {
  return {
    userName: '',
    theme: 'light',
    defaultExpanded: false,
    allowMultipleInstances: false,
    exitClosesCompletely: false,
    onboarded: false
  };
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
        theme: parsed.theme === 'dark' ? 'dark' : 'light',
        defaultExpanded: Boolean(parsed.defaultExpanded),
        allowMultipleInstances: Boolean(parsed.allowMultipleInstances),
        exitClosesCompletely: Boolean(parsed.exitClosesCompletely),
        onboarded: Boolean(parsed.onboarded) && Boolean(cleanName)
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
    theme: nextSettings.theme === 'dark' ? 'dark' : 'light',
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
        : Boolean(cleanName)
  };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

function resetSettings() {
  const defaults = getDefaultSettings();
  settings = { ...defaults };
  savedLayout = getDefaultLayout();
  ensureDirectories();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  fs.writeFileSync(LAYOUT_FILE, JSON.stringify(savedLayout, null, 2), 'utf8');
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
    logs: []
  };
}

function getRuntimeState(id) {
  let state = runtimeState.get(id);
  if (!state) {
    state = createInitialRuntimeState();
    runtimeState.set(id, state);
  }
  return state;
}

function getLogFilePath(id) {
  return path.join(LOGS_DIR, `${id}.log`);
}

function saveProjects() {
  ensureDirectories();
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf8');
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

function createProjectRecord({ path: rawPath, name, command, customPort }) {
  const inspection = inspectProjectPath(rawPath);
  if (!inspection.valid) {
    const err = new Error(inspection.error);
    err.statusCode = 400;
    throw err;
  }

  const normalizedKey = normalizePathKey(inspection.resolvedPath);
  const duplicate = projects.find((p) => normalizePathKey(p.path) === normalizedKey);
  if (duplicate) {
    const err = new Error(`Project already registered: ${duplicate.name} (${duplicate.path})`);
    err.statusCode = 409;
    throw err;
  }

  const portStr = normalizePortInput(customPort);

  const record = {
    id: crypto.randomUUID(),
    name: name && String(name).trim() ? String(name).trim() : inspection.name,
    path: inspection.resolvedPath,
    command:
      command && String(command).trim()
        ? String(command).trim()
        : inspection.recommendedCommand || inspection.suggestedCommand,
    customPort: portStr,
    createdAt: new Date().toISOString(),
    lastStartedAt: null
  };

  applyInspectionToProject(record, inspection, false);

  projects.push(record);
  getRuntimeState(record.id);
  saveProjects();
  return record;
}

function loadOrSeedProjects() {
  ensureDirectories();
  if (fs.existsSync(PROJECTS_FILE)) {
    try {
      const raw = fs.readFileSync(PROJECTS_FILE, 'utf8').replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      projects = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      console.error('Failed to read projects.json, starting empty:', err.message);
      projects = [];
    }

    let migrated = false;
    for (const p of projects) {
      getRuntimeState(p.id);
      const inspection = inspectProjectPath(p.path);
      if (inspection.valid) {
        const shouldAutoFixCommand =
          p.command === 'npm run dev' &&
          inspection.recommendedCommand &&
          inspection.recommendedCommand !== 'npm run dev' &&
          inspection.framework.includes('Vite');
        applyInspectionToProject(p, inspection, shouldAutoFixCommand);
        migrated = true;
      }
    }
    if (migrated) {
      saveProjects();
    }
    return;
  }

  // Fresh installs always start with an empty workspace. Nothing is auto-imported
  // from the app folder or its neighbours, so no personal paths leak into new installs.
  projects = [];
  saveProjects();
}

function serializeProject(project) {
  const state = getRuntimeState(project.id);
  const logPath = getLogFilePath(project.id);
  let logCount = state.logs.length;
  if (logCount === 0 && fs.existsSync(logPath)) {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > 0) {
        logCount = 1;
      }
    } catch {
      // Ignore stat error
    }
  }

  return {
    ...project,
    status: state.status,
    pid: state.pid,
    startedAt: state.startedAt,
    exitCode: state.exitCode,
    detectedUrl: state.detectedUrl,
    assignedPort: state.assignedPort,
    logCount
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

function broadcastProjectStatus(project) {
  broadcastEvent('project-status', serializeProject(project));
}

function appendLog(projectId, stream, rawText) {
  const cleanText = stripAnsi(rawText);
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

  const logLine = `[${entry.timestamp}] [${stream.toUpperCase()}] ${cleanText}\n`;
  try {
    fs.appendFileSync(getLogFilePath(projectId), logLine, 'utf8');
  } catch (err) {
    console.error(`Failed to write log for ${projectId}:`, err.message);
  }

  broadcastEvent('project-log', { projectId, entry });
  return entry;
}

function clearProbeTimer(state) {
  if (state.probeTimer) {
    clearInterval(state.probeTimer);
    state.probeTimer = null;
  }
}

function detectAndRecordUrl(project, lineText) {
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
    appendLog(project.id, streamName, cleaned);
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

async function findAvailablePort(startPort, excludeId) {
  const reserved = new Set();
  for (const [id, st] of runtimeState.entries()) {
    if (id !== excludeId && st.status === 'running' && st.assignedPort) {
      reserved.add(Number(st.assignedPort));
    }
  }

  let candidate = Number(startPort) || 3000;
  for (let offset = 0; offset < 40; offset++) {
    const p = candidate + offset;
    if (p === PORT) continue; // Skip DevDeck's own port
    if (reserved.has(p)) continue;
    const busy = await isPortListening(p);
    if (!busy) return p;
  }
  return candidate;
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

  let attempts = 0;
  state.probeTimer = setInterval(async () => {
    attempts += 1;
    if (state.status !== 'running' || state.detectedUrl || attempts > 45) {
      clearProbeTimer(state);
      return;
    }

    const open = await isPortListening(targetPort);
    if (open && state.status === 'running' && !state.detectedUrl) {
      state.detectedUrl = `http://localhost:${targetPort}`;
      clearProbeTimer(state);
      appendLog(project.id, 'system', `Live server detected at ${state.detectedUrl}`);
      broadcastProjectStatus(project);
    }
  }, 800);
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

function buildCrossPlatformEnv(assignedPort, projectPath = '') {
  const portStr = String(assignedPort);
  const existingPath =
    process.env.PATH || process.env.Path || process.env.path || '';
  const env = {
    ...process.env,
    FORCE_COLOR: '0',
    BROWSER: 'none',
    PORT: portStr,
    SERVER_PORT: portStr,
    FLASK_RUN_PORT: portStr,
    STREAMLIT_SERVER_PORT: portStr,
    GRADIO_SERVER_PORT: portStr,
    ROCKET_PORT: portStr,
    ASPNETCORE_URLS: `http://localhost:${portStr}`
  };

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
      '/snap/bin'
    ];
    env.PATH = Array.from(new Set([...localBins, ...extraPaths, ...currentParts])).join(
      path.delimiter
    );
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

async function startProject(id) {
  const project = findProjectOrThrow(id);
  const state = getRuntimeState(id);

  if (state.status === 'running' && state.process) {
    return serializeProject(project);
  }

  if (!fs.existsSync(project.path)) {
    const err = new Error(`Project directory does not exist: ${project.path}`);
    err.statusCode = 400;
    throw err;
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
  const assignedPort = project.customPort
    ? desiredPort
    : await findAvailablePort(desiredPort, project.id);

  const command = buildEffectiveCommand(project, assignedPort);
  const env = buildCrossPlatformEnv(assignedPort, project.path);

  state.status = 'running';
  state.startedAt = Date.now();
  state.exitCode = null;
  state.detectedUrl = null;
  state.assignedPort = assignedPort;
  state.stopping = false;

  const child = spawnProjectCommand(command, project.path, env);

  state.process = child;
  state.pid = child.pid || null;

  project.lastStartedAt = new Date().toISOString();
  saveProjects();

  const portNotice =
    !project.customPort && assignedPort !== desiredPort
      ? ` [Port ${desiredPort} was busy -> assigned PORT=${assignedPort}]`
      : ` [PORT=${assignedPort}]`;

  appendLog(
    project.id,
    'system',
    `Started "${command}" (${project.programType || project.framework})${portNotice} in ${project.path} (PID: ${child.pid || 'unknown'})`
  );
  broadcastProjectStatus(project);

  startActivePortProbe(project, state, assignedPort);

  const flushStdout = child.stdout
    ? attachStreamReader(project, child.stdout, 'stdout')
    : () => {};
  const flushStderr = child.stderr
    ? attachStreamReader(project, child.stderr, 'stderr')
    : () => {};

  child.on('error', (err) => {
    clearProbeTimer(state);
    flushStdout();
    flushStderr();
    state.status = 'crashed';
    state.pid = null;
    state.startedAt = null;
    state.detectedUrl = null;
    state.assignedPort = null;
    state.process = null;
    state.exitCode = -1;
    appendLog(project.id, 'system', `Failed to start process: ${err.message}`);
    broadcastProjectStatus(project);
  });

  child.on('close', (code, signal) => {
    clearProbeTimer(state);
    flushStdout();
    flushStderr();

    const wasStopping = state.stopping;
    state.stopping = false;
    state.status = wasStopping ? 'stopped' : code === 0 ? 'stopped' : 'crashed';
    state.pid = null;
    state.startedAt = null;
    state.detectedUrl = null;
    state.assignedPort = null;
    state.process = null;
    state.exitCode = typeof code === 'number' ? code : null;

    const reason = wasStopping
      ? 'Process stopped by user.'
      : `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
    appendLog(project.id, 'system', reason);
    broadcastProjectStatus(project);
  });

  return serializeProject(project);
}

function stopProject(id) {
  const project = findProjectOrThrow(id);
  const state = getRuntimeState(id);
  clearProbeTimer(state);

  if (!state.process || !state.pid) {
    state.status = 'stopped';
    state.pid = null;
    state.startedAt = null;
    state.detectedUrl = null;
    state.assignedPort = null;
    state.process = null;
    state.stopping = false;
    broadcastProjectStatus(project);
    return Promise.resolve(serializeProject(project));
  }

  const pidToKill = state.pid;
  state.stopping = true;
  appendLog(project.id, 'system', `Stopping process tree (PID: ${pidToKill})...`);

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearProbeTimer(state);
      state.status = 'stopped';
      state.pid = null;
      state.startedAt = null;
      state.detectedUrl = null;
      state.assignedPort = null;
      state.process = null;
      state.stopping = false;
      broadcastProjectStatus(project);
      resolve(serializeProject(project));
    };

    if (process.platform === 'win32') {
      const sysRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
      const taskkillDefault = path.join(sysRoot, 'System32', 'taskkill.exe');
      const taskkillBin = fs.existsSync(taskkillDefault) ? taskkillDefault : 'taskkill';
      const killer = spawn(taskkillBin, ['/PID', String(pidToKill), '/T', '/F'], {
        windowsHide: true
      });

      const timeout = setTimeout(() => {
        finish();
      }, 4000);

      killer.on('close', () => {
        clearTimeout(timeout);
        setTimeout(finish, 120);
      });

      killer.on('error', () => {
        clearTimeout(timeout);
        try {
          state.process?.kill();
        } catch {
          // Ignore fallback kill error
        }
        finish();
      });
      return;
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
        finish();
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
        setTimeout(finish, 120);
      }
    }, 120);
  });
}

async function restartProject(id) {
  const project = findProjectOrThrow(id);
  const state = getRuntimeState(id);
  if (state.status === 'running' && state.pid) {
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
    if (state.status === 'running' && state.pid) {
      runningIds.push(p.id);
    }
  }
  await Promise.all(runningIds.map((id) => stopProject(id)));
  return projects.map(serializeProject);
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

function readProjectLogs(id) {
  findProjectOrThrow(id);
  const logFilePath = getLogFilePath(id);
  let fileSize = 0;

  if (fs.existsSync(logFilePath)) {
    try {
      const stat = fs.statSync(logFilePath);
      fileSize = stat.size;
      const content = fs.readFileSync(logFilePath, 'utf8');
      const rawLines = content.split(/\r?\n/).filter((l) => l.length > 0);
      const tailLines = rawLines.slice(-MAX_READ_LOG_LINES);
      const parsed = tailLines.map(parseLogLine);
      return { logs: parsed, logFilePath, fileSize };
    } catch (err) {
      console.error(`Failed reading logs for ${id}:`, err.message);
    }
  }

  const state = getRuntimeState(id);
  return {
    logs: state.logs.slice(-MAX_READ_LOG_LINES),
    logFilePath,
    fileSize
  };
}

function clearProjectLogs(id) {
  findProjectOrThrow(id);
  const state = getRuntimeState(id);
  state.logs = [];
  const logFilePath = getLogFilePath(id);
  fs.writeFileSync(logFilePath, '', 'utf8');
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
      deployNote: p.deployNote || ''
    }))
  };

  return {
    fileName,
    content: JSON.stringify(configObj, null, 2),
    config: configObj,
    generatedAt
  };
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
    }

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
      const normalizedKey = normalizePathKey(resolvedPath);
      const existing = projects.find((p) => normalizePathKey(p.path) === normalizedKey);
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
        importedProjectsCount += 1;
        continue;
      }

      const portStr = lenientPort(itemObj.customPort);

      const fallbackName = path.basename(resolvedPath) || 'project';
      const record = {
        id:
          itemObj.id &&
          typeof itemObj.id === 'string' &&
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
      importedProjectsCount += 1;
    }

    saveProjects();
  }

  const serializedProjects = projects.map(serializeProject);
  broadcastEvent('settings-updated', settings);
  broadcastEvent('config-imported', {
    settings,
    layout: savedLayout,
    projects: serializedProjects,
    brokenProjects
  });

  return {
    ok: true,
    settings,
    layout: savedLayout,
    projects: serializedProjects,
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
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(resolved).pipe(res);
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
      onboarded: body.onboarded !== undefined ? body.onboarded : settings.onboarded
    });
    broadcastEvent('settings-updated', updated);
    sendJson(res, 200, updated);
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
        const key = normalizePathKey(inspection.resolvedPath);
        const dup = projects.find(
          (p) => p.id !== id && normalizePathKey(p.path) === key
        );
        if (dup) {
          sendJson(res, 409, { error: `Another project already uses ${dup.path}` });
          return;
        }
        nextPath = inspection.resolvedPath;
      } else {
        inspection = inspectProjectPath(project.path);
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
      broadcastProjectStatus(project);
      sendJson(res, 200, serializeProject(project));
      return;
    }

    if (!action && method === 'DELETE') {
      findProjectOrThrow(id);
      const state = getRuntimeState(id);
      if (state.status === 'running' && state.pid) {
        await stopProject(id);
      }
      projects = projects.filter((p) => p.id !== id);
      runtimeState.delete(id);
      saveProjects();
      broadcastEvent('project-deleted', { id });
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
      const result = readProjectLogs(id);
      sendJson(res, 200, result);
      return;
    }

    if (action === 'logs' && method === 'DELETE') {
      const result = clearProjectLogs(id);
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
  for (const [, state] of runtimeState.entries()) {
    clearProbeTimer(state);
    if (state.pid) {
      if (process.platform === 'win32') {
        try {
          execFileSync('taskkill', ['/PID', String(state.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
          });
        } catch {
          // Ignore errors if child already exited
        }
      } else {
        try {
          process.kill(-state.pid, 'SIGKILL');
        } catch {
          try {
            process.kill(state.pid, 'SIGKILL');
          } catch {
            // Ignore errors if child already exited
          }
        }
      }
    }
  }
}

loadSettings();
loadLayout();
loadOrSeedProjects();

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

const server = http.createServer(async (req, res) => {
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
    if (!res.headersSent) {
      sendJson(res, statusCode, { error: err.message || 'Internal Server Error' });
    }
  }
});

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
}

function startServer(listenPort = PORT) {
  registerShutdownSignals();
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
      resolve({ server, port: activePort, url: `http://localhost:${activePort}` });
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
  getWindowsModernPickerScript
};
