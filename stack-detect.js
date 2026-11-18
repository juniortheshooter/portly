'use strict';

// Suggests the services of a Stack from one root folder. Sources, in order of trust:
//   1. Procfile.dev / Procfile          (one service per line, same folder)
//   2. pnpm / npm / yarn workspaces     (Turborepo and Nx repos use these too)
//   3. docker-compose / compose files   (one `docker compose up <service>` per service)
//   4. common sub-folders               (frontend/, backend/, api/, web/, server/, client/, apps/*)
// Nothing is saved here: the user reviews the list before the stack is created.

const fs = require('node:fs');
const path = require('node:path');

const MAX_SERVICES = 12;
const COMMON_SUBFOLDERS = [
  'frontend',
  'client',
  'web',
  'app',
  'ui',
  'site',
  'backend',
  'server',
  'api',
  'worker',
  'workers',
  'jobs',
  'db',
  'database'
];
const WORKER_NAME_REGEX = /\b(worker|workers|jobs?|queue|sidekiq|celery|scheduler|cron|bull|resque)\b/i;
const BACKEND_NAME_REGEX = /\b(api|backend|server|svc|service)\b/i;
const DB_NAME_REGEX = /\b(db|database|postgres|postgresql|mysql|mariadb|mongo|mongodb|redis|valkey|memcached|rabbitmq|kafka|elasticsearch|opensearch|minio|mailpit|mailhog)\b/i;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseProcfile(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*:\s*(.+?)\s*$/);
    if (m && !line.trim().startsWith('#')) out.push({ name: m[1], command: m[2] });
  }
  return out;
}

/** Reads top-level service names (and whether they publish ports) from a compose file. */
function parseComposeServices(text) {
  const services = [];
  let inServices = false;
  let serviceIndent = null;
  let propIndent = null;
  let current = null;
  let currentKey = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const indent = rawLine.match(/^\s*/)[0].length;
    if (indent === 0) {
      inServices = /^services\s*:\s*$/.test(line);
      serviceIndent = null;
      current = null;
      continue;
    }
    if (!inServices) continue;
    if (serviceIndent === null) serviceIndent = indent;
    if (indent <= serviceIndent) {
      const m = line.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*:\s*$/);
      current = m ? { name: m[1], hasPorts: false, image: '', dependsOn: [] } : null;
      if (current) services.push(current);
      propIndent = null;
      currentKey = null;
      continue;
    }
    if (!current) continue;
    if (propIndent === null) propIndent = indent;
    if (indent === propIndent) {
      const km = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
      currentKey = km ? km[1] : null;
      if (!km) continue;
      const rest = km[2];
      if (currentKey === 'ports') current.hasPorts = true;
      if (currentKey === 'image') current.image = rest.replace(/^["']|["']$/g, '');
      if (currentKey === 'depends_on' && /^\[.*\]$/.test(rest)) {
        current.dependsOn.push(
          ...rest
            .slice(1, -1)
            .split(',')
            .map((x) => x.trim().replace(/^["']|["']$/g, ''))
            .filter(Boolean)
        );
      }
      continue;
    }
    if (currentKey === 'depends_on') {
      const item = line.match(/^-\s*["']?([A-Za-z0-9_.-]+)["']?\s*$/) || line.match(/^["']?([A-Za-z0-9_.-]+)["']?\s*:\s*$/);
      if (item) current.dependsOn.push(item[1]);
    }
  }
  return services;
}

/** Expands simple workspace globs such as "apps/*" and "packages/web". */
function expandWorkspaceGlobs(root, patterns) {
  const dirs = [];
  for (const raw of patterns) {
    const pattern = String(raw || '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!pattern || pattern.startsWith('!') || pattern.includes('..')) continue;
    if (pattern.endsWith('/*') || pattern.endsWith('/**')) {
      const base = path.join(root, pattern.replace(/\/\*\*?$/, ''));
      let entries = [];
      try {
        entries = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          dirs.push(path.join(base, e.name));
        }
      }
    } else if (!pattern.includes('*')) {
      const dir = path.join(root, pattern);
      try {
        if (fs.statSync(dir).isDirectory()) dirs.push(dir);
      } catch {
        // missing
      }
    }
  }
  return dirs;
}

function readWorkspacePatterns(root) {
  const patterns = [];
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg && Array.isArray(pkg.workspaces)) patterns.push(...pkg.workspaces);
  if (pkg && pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
    patterns.push(...pkg.workspaces.packages);
  }
  const pnpm = readText(path.join(root, 'pnpm-workspace.yaml'));
  if (pnpm) {
    let inPackages = false;
    for (const line of pnpm.split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) {
        inPackages = true;
        continue;
      }
      if (inPackages) {
        const m = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/);
        if (m) patterns.push(m[1]);
        else if (/^\S/.test(line)) inPackages = false;
      }
    }
  }
  return patterns;
}

function guessKind(name, command) {
  if (DB_NAME_REGEX.test(name)) return 'server';
  return WORKER_NAME_REGEX.test(name) || WORKER_NAME_REGEX.test(command || '') ? 'worker' : 'server';
}

/** Lower number starts first: databases, then APIs, then frontends; workers after their API. */
function startRank(svc) {
  if (DB_NAME_REGEX.test(svc.name) || DB_NAME_REGEX.test(svc.image || '')) return 0;
  if (BACKEND_NAME_REGEX.test(svc.name)) return 1;
  if (svc.kind === 'worker') return 2;
  return 3;
}

/**
 * Adds "start after" rules from the rank: each service waits for the services of the
 * nearest lower rank that holds any. Compose depends_on wins when present.
 */
function addStartOrder(services) {
  const byName = new Map(services.map((s) => [s.name, s]));
  for (const s of services) {
    if (Array.isArray(s.dependsOn) && s.dependsOn.length) {
      s.startAfter = s.dependsOn.filter((n) => byName.has(n) && n !== s.name);
    }
  }
  if (services.some((s) => Array.isArray(s.dependsOn) && s.dependsOn.length)) {
    for (const s of services) s.startAfter = s.startAfter || [];
    return services;
  }
  for (const s of services) {
    const rank = startRank(s);
    let deps = [];
    for (let r = rank - 1; r >= 0 && deps.length === 0; r--) {
      // Workers wait for the API, not for each other; frontends wait for the API too.
      if (r === 2) continue;
      deps = services.filter((o) => o !== s && startRank(o) === r).map((o) => o.name);
    }
    s.startAfter = deps;
  }
  return services;
}

/** Puts services in an order that respects their startAfter names (stable otherwise). */
function sortByStartOrder(services) {
  const byName = new Map(services.map((s) => [s.name, s]));
  const done = new Set();
  const visiting = new Set();
  const out = [];
  const visit = (s) => {
    if (done.has(s.name) || visiting.has(s.name)) return;
    visiting.add(s.name);
    for (const dep of s.startAfter || []) {
      const d = byName.get(dep);
      if (d) visit(d);
    }
    visiting.delete(s.name);
    done.add(s.name);
    out.push(s);
  };
  services.forEach(visit);
  services.splice(0, services.length, ...out);
  return services;
}

function uniqueName(name, used) {
  let base = String(name || 'service').trim() || 'service';
  let candidate = base;
  let i = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base}-${i++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * @param {string} rootPath an existing folder
 * @param {{ inspect: (dir: string) => object, isProjectDir: (dir: string) => boolean }} helpers
 * @returns {{ name: string, source: string, services: Array<object>, notes: string[] }}
 */
function suggestStack(rootPath, helpers) {
  const root = path.resolve(rootPath);
  const notes = [];
  const used = new Set();
  const services = [];
  const add = (svc) => {
    if (services.length >= MAX_SERVICES) return;
    services.push({ ...svc, name: uniqueName(svc.name, used) });
  };
  const fromFolder = (dir, nameHint) => {
    const inspection = helpers.inspect(dir);
    if (!inspection || !inspection.valid) return;
    const name = nameHint || path.basename(dir);
    const command = inspection.recommendedCommand || inspection.suggestedCommand || '';
    if (!command) return;
    add({
      name,
      path: dir,
      command,
      kind: guessKind(name, command),
      framework: inspection.framework || '',
      defaultPort: inspection.defaultPort || null
    });
  };

  let source = '';

  // 1. Procfile
  const procName = ['Procfile.dev', 'Procfile'].find((f) => fs.existsSync(path.join(root, f)));
  if (procName) {
    const entries = parseProcfile(readText(path.join(root, procName)) || '');
    for (const e of entries) {
      add({ name: e.name, path: root, command: e.command, kind: e.name === 'web' ? 'server' : guessKind(e.name, e.command) });
    }
    if (services.length) source = procName;
  }

  // 2. Workspaces
  if (!services.length) {
    const patterns = readWorkspacePatterns(root);
    if (patterns.length) {
      for (const dir of expandWorkspaceGlobs(root, patterns)) {
        const pkg = readJson(path.join(dir, 'package.json'));
        // Libraries without a dev/start/serve script aren't services.
        const scripts = (pkg && pkg.scripts) || {};
        if (!scripts.dev && !scripts.start && !scripts.serve && !scripts.worker) continue;
        fromFolder(dir, path.basename(dir));
      }
      if (services.length) {
        source = 'workspaces';
        if (fs.existsSync(path.join(root, 'turbo.json'))) notes.push('Found a Turborepo setup.');
        if (fs.existsSync(path.join(root, 'nx.json'))) notes.push('Found an Nx setup.');
      }
    }
  }

  // 3. Docker Compose
  if (!services.length) {
    const composeFile = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'].find(
      (f) => fs.existsSync(path.join(root, f))
    );
    if (composeFile) {
      for (const s of parseComposeServices(readText(path.join(root, composeFile)) || '')) {
        add({
          name: s.name,
          path: root,
          command: `docker compose -f ${composeFile} up ${s.name}`,
          kind: s.hasPorts || DB_NAME_REGEX.test(s.name) ? 'server' : 'worker',
          image: s.image,
          dependsOn: s.dependsOn
        });
      }
      if (services.length) {
        source = composeFile;
        notes.push('Docker services choose their own ports from the compose file, so Portly opens them as listed there.');
      }
    }
  }

  // 4. Sub-folders
  if (!services.length) {
    const candidates = [];
    for (const sub of COMMON_SUBFOLDERS) {
      const dir = path.join(root, sub);
      try {
        if (fs.statSync(dir).isDirectory() && helpers.isProjectDir(dir)) candidates.push(dir);
      } catch {
        // missing
      }
    }
    for (const group of ['apps', 'services', 'packages']) {
      for (const dir of expandWorkspaceGlobs(root, [`${group}/*`])) {
        if (helpers.isProjectDir(dir)) candidates.push(dir);
      }
    }
    for (const dir of candidates) fromFolder(dir, path.basename(dir));
    if (services.length) source = 'folders';
  }

  // Nothing found: a stack of one, from the root itself.
  if (!services.length) {
    fromFolder(root, path.basename(root));
    if (services.length) {
      source = 'single';
      notes.push('Only one app was found here. Add more services with "Add service".');
    }
  }

  addStartOrder(services);
  for (const s of services) delete s.dependsOn;
  sortByStartOrder(services);

  let name = path.basename(root);
  const rootPkg = readJson(path.join(root, 'package.json'));
  if (rootPkg && typeof rootPkg.name === 'string' && rootPkg.name.trim()) {
    name = rootPkg.name.replace(/^@[^/]+\//, '').trim();
  }
  return { name, path: root, source, services, notes };
}

module.exports = {
  suggestStack,
  parseProcfile,
  parseComposeServices,
  expandWorkspaceGlobs,
  addStartOrder,
  guessKind
};
