'use strict';

// Per-project (and per-stack) environment variables, with named profiles such as Dev and Test.
//
// Values live in their own file (data/env-vars.json), never in projects.json, so a config
// export or a shared workspace file never carries them. When Portly runs inside Electron the
// values are encrypted with the OS keychain (safeStorage); in plain `node server.js` mode they
// are stored as text in a file only the current user can read.

const fs = require('node:fs');
const path = require('node:path');

const KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/;
const PROFILE_REGEX = /^[A-Za-z0-9 _.-]{1,40}$/;
const MAX_VARS_PER_PROFILE = 200;
const MAX_PROFILES = 10;
const MAX_VALUE_LENGTH = 32 * 1024;
const DEFAULT_PROFILE = 'Dev';

// .env files Portly lists for a folder (and can import from). Fixed names only, so a
// request can never read an arbitrary file.
const ENV_FILE_NAMES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.dev',
  '.env.test',
  '.env.test.local',
  '.env.example'
];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

/** Parses the common .env format: KEY=value, `export KEY=value`, quotes, # comments. */
function parseDotEnv(text) {
  const out = [];
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_REGEX.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === '`') && value.length >= 1) {
      // A quoted value may span several lines.
      let body = value.slice(1);
      let closeAt = body.indexOf(quote);
      while (closeAt === -1 && i + 1 < lines.length) {
        i += 1;
        body += `\n${lines[i]}`;
        closeAt = body.indexOf(quote);
      }
      value = closeAt === -1 ? body : body.slice(0, closeAt);
      if (quote === '"') {
        value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"');
      }
    } else {
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out.push({ key, value });
  }
  return out;
}

/** Lists the known .env files that exist in a folder. */
function listEnvFiles(dirPath) {
  if (!dirPath) return [];
  const found = [];
  for (const name of ENV_FILE_NAMES) {
    try {
      const st = fs.statSync(path.join(dirPath, name));
      if (st.isFile()) found.push(name);
    } catch {
      // not there
    }
  }
  return found;
}

function readEnvFile(dirPath, fileName) {
  if (!ENV_FILE_NAMES.includes(fileName)) {
    throw badRequest(`Portly can only import these files: ${ENV_FILE_NAMES.join(', ')}`);
  }
  const target = path.join(dirPath, fileName);
  let text;
  try {
    const st = fs.statSync(target);
    if (!st.isFile() || st.size > 1024 * 1024) throw new Error('not a small file');
    text = fs.readFileSync(target, 'utf8');
  } catch {
    throw badRequest(`Couldn't read ${fileName} in ${dirPath}.`);
  }
  return parseDotEnv(text);
}

/** Validates and normalizes { activeProfile, profiles: { name: [{ key, value }] } }. */
function normalizeEnvConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawProfiles = src.profiles && typeof src.profiles === 'object' ? src.profiles : {};
  const names = Object.keys(rawProfiles);
  if (names.length > MAX_PROFILES) {
    throw badRequest(`Use at most ${MAX_PROFILES} profiles.`);
  }
  const profiles = {};
  for (const rawName of names) {
    const name = String(rawName).trim();
    if (!PROFILE_REGEX.test(name)) {
      throw badRequest(
        `Profile name "${rawName}" isn't valid. Use up to 40 letters, numbers, spaces, dots, dashes or underscores.`
      );
    }
    const rows = Array.isArray(rawProfiles[rawName]) ? rawProfiles[rawName] : [];
    if (rows.length > MAX_VARS_PER_PROFILE) {
      throw badRequest(`A profile can hold at most ${MAX_VARS_PER_PROFILE} variables.`);
    }
    const seen = new Set();
    const vars = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const key = String(row.key || '').trim();
      if (!key && !row.value) continue; // empty row left in the editor
      if (!KEY_REGEX.test(key)) {
        throw badRequest(
          `"${key || '(empty)'}" isn't a valid variable name. Start with a letter or underscore, then letters, numbers or underscores.`
        );
      }
      if (/^path$/i.test(key)) {
        throw badRequest('PATH is managed by Portly and the system, so it can\'t be set here.');
      }
      if (seen.has(key)) {
        throw badRequest(`${key} is listed twice in the ${name} profile.`);
      }
      seen.add(key);
      const value = row.value === undefined || row.value === null ? '' : String(row.value);
      if (value.length > MAX_VALUE_LENGTH) {
        throw badRequest(`The value of ${key} is too long (32 KB at most).`);
      }
      vars.push({ key, value });
    }
    profiles[name] = vars;
  }
  if (Object.keys(profiles).length === 0) {
    profiles[DEFAULT_PROFILE] = [];
  }
  let activeProfile = String(src.activeProfile || '').trim();
  if (!profiles[activeProfile]) activeProfile = Object.keys(profiles)[0];
  return { activeProfile, profiles };
}

/**
 * Expands ${NAME} references in user values, using the variables composed so far.
 * Unknown names expand to an empty string, like a shell would. $${NAME} keeps the text.
 */
function expandReferences(value, lookup) {
  return String(value).replace(/\$(\$?)\{([A-Za-z_][A-Za-z0-9_.]*)\}/g, (whole, escaped, name) => {
    if (escaped) return `\${${name}}`;
    const v = lookup(name);
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * @param {string} filePath where the store is kept
 * @param {{ available: () => boolean, encrypt: (s: string) => string, decrypt: (s: string) => string } | null} codec
 */
function createEnvStore(filePath, codec = null) {
  let data = null; // { version, entries: { ownerId: { activeProfile, profiles: { name: [{ key, value: {t, d} }] } } } }
  let loadError = null;
  let activeCodec = codec;

  function canEncrypt() {
    try {
      return Boolean(activeCodec && activeCodec.available());
    } catch {
      return false;
    }
  }

  function encodeValue(plain) {
    if (canEncrypt()) {
      try {
        return { t: 'safe', d: activeCodec.encrypt(plain) };
      } catch {
        // fall through to plain text
      }
    }
    return { t: 'plain', d: plain };
  }

  function decodeValue(stored) {
    if (!stored || typeof stored !== 'object') return '';
    if (stored.t === 'safe') {
      if (!activeCodec) return '';
      try {
        return activeCodec.decrypt(stored.d);
      } catch {
        return '';
      }
    }
    return typeof stored.d === 'string' ? stored.d : '';
  }

  function load() {
    if (data) return data;
    data = { version: 1, entries: {} };
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
        if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
          data = { version: 1, entries: parsed.entries };
        }
      }
    } catch (err) {
      loadError = err;
      // Keep the unreadable file for the user, start empty.
      try {
        fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      } catch {
        // ignore
      }
    }
    return data;
  }

  function save() {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Windows: user profile folders are already private
    }
  }

  /** Returns the decrypted config for an owner (project or stack id). */
  function get(ownerId) {
    const entry = load().entries[ownerId];
    if (!entry) {
      return { activeProfile: DEFAULT_PROFILE, profiles: { [DEFAULT_PROFILE]: [] } };
    }
    const profiles = {};
    for (const [name, rows] of Object.entries(entry.profiles || {})) {
      profiles[name] = (Array.isArray(rows) ? rows : []).map((r) => ({
        key: r.key,
        value: decodeValue(r.value)
      }));
    }
    if (Object.keys(profiles).length === 0) profiles[DEFAULT_PROFILE] = [];
    const activeProfile = profiles[entry.activeProfile] ? entry.activeProfile : Object.keys(profiles)[0];
    return { activeProfile, profiles };
  }

  function set(ownerId, rawConfig) {
    const config = normalizeEnvConfig(rawConfig);
    const stored = { activeProfile: config.activeProfile, profiles: {} };
    for (const [name, rows] of Object.entries(config.profiles)) {
      stored.profiles[name] = rows.map((r) => ({ key: r.key, value: encodeValue(r.value) }));
    }
    load().entries[ownerId] = stored;
    save();
    return get(ownerId);
  }

  function setActiveProfile(ownerId, profileName) {
    const current = get(ownerId);
    if (!current.profiles[profileName]) {
      throw badRequest(`There's no profile called "${profileName}".`);
    }
    current.activeProfile = profileName;
    return set(ownerId, current);
  }

  function remove(ownerId) {
    const d = load();
    if (d.entries[ownerId]) {
      delete d.entries[ownerId];
      save();
    }
  }

  /** The active profile's variables for an owner, as a plain object. */
  function activeVars(ownerId) {
    const entry = load().entries[ownerId];
    if (!entry) return {};
    const cfg = get(ownerId);
    const out = {};
    for (const row of cfg.profiles[cfg.activeProfile] || []) out[row.key] = row.value;
    return out;
  }

  /** A summary safe to send with the project list: names and counts, no values. */
  function summary(ownerId) {
    const entry = load().entries[ownerId];
    if (!entry) return { activeProfile: DEFAULT_PROFILE, profileNames: [DEFAULT_PROFILE], count: 0 };
    const names = Object.keys(entry.profiles || {});
    const active = entry.profiles && entry.profiles[entry.activeProfile] ? entry.activeProfile : names[0];
    return {
      activeProfile: active || DEFAULT_PROFILE,
      profileNames: names.length ? names : [DEFAULT_PROFILE],
      count: active && Array.isArray(entry.profiles[active]) ? entry.profiles[active].length : 0
    };
  }

  return {
    get,
    set,
    setActiveProfile,
    remove,
    activeVars,
    summary,
    isEncrypted: canEncrypt,
    setCodec(nextCodec) {
      activeCodec = nextCodec;
    },
    getLoadError: () => loadError,
    _reset() {
      data = null;
    }
  };
}

module.exports = {
  createEnvStore,
  parseDotEnv,
  listEnvFiles,
  readEnvFile,
  normalizeEnvConfig,
  expandReferences,
  ENV_FILE_NAMES,
  DEFAULT_PROFILE
};
