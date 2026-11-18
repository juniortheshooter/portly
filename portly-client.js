'use strict';

/**
 * Tiny zero-dependency client for Portly's local API. Shared by the MCP server
 * (portly-mcp.js) and the command line tool (portly-cli.js).
 *
 * It only ever talks to a Portly running on this computer (127.0.0.1 / localhost).
 * Set PORTLY_URL to use a different port, e.g. PORTLY_URL=http://127.0.0.1:4600
 */

const http = require('node:http');
const { URL } = require('node:url');

const DEFAULT_URL = 'http://127.0.0.1:4567';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function getBaseUrl() {
  const raw = process.env.PORTLY_URL || DEFAULT_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PORTLY_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname)) {
    throw new Error('PORTLY_URL must point to Portly on this computer (http://127.0.0.1:<port>).');
  }
  return url;
}

function request(method, pathname, body) {
  const base = getBaseUrl();
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: base.hostname.replace(/^\[|\]$/g, ''),
        port: base.port || 80,
        path: pathname,
        method,
        timeout: 30000,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = raw;
          }
          if (res.statusCode >= 400) {
            const msg = (data && data.error) || `Portly returned HTTP ${res.statusCode}`;
            reject(new Error(msg));
            return;
          }
          resolve(data);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Timed out talking to Portly.')));
    req.on('error', (err) => {
      if (err && err.code === 'ECONNREFUSED') {
        reject(
          new Error(
            `Portly is not running at ${base.origin}. Ask the user to open the Portly app, then try again.`
          )
        );
        return;
      }
      reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The fields an agent actually needs, instead of the whole project record. */
function summarize(p) {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    status: p.status,
    url: p.detectedUrl || null,
    port: p.assignedPort || p.customPort || p.defaultPort || null,
    pid: p.pid || null,
    command: p.command,
    framework: p.framework || null,
    language: p.language || null,
    exitCode: p.exitCode === undefined ? null : p.exitCode,
    // Stable address such as http://shop.localhost:1355 (null when named URLs are off).
    namedUrl: p.namedUrl || null,
    stackId: p.stackId || null,
    kind: p.kind || 'server'
  };
}

async function listStacks() {
  const list = await request('GET', '/api/stacks');
  return Array.isArray(list) ? list : [];
}

/** Finds a stack by id, exact name or a unique partial name. */
async function resolveStack(ref) {
  const needle = String(ref || '').trim();
  if (!needle) throw new Error('A stack name or id is required.');
  const all = await listStacks();
  const lower = needle.toLowerCase();
  const exact = all.find((s) => s.id === needle) || all.find((s) => String(s.name).toLowerCase() === lower);
  if (exact) return exact;
  const partial = all.filter((s) => String(s.name).toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${needle}" matches several stacks: ${partial.map((s) => s.name).join(', ')}. Use the exact name or id.`);
  }
  throw new Error(`No stack matches "${needle}". Known stacks: ${all.map((s) => s.name).join(', ') || '(none yet)'}.`);
}

/** A stack with its services summarized, in start order. */
async function describeStack(stack) {
  const projects = await listProjects();
  return {
    id: stack.id,
    name: stack.name,
    status: stack.status,
    url: stack.namedUrl || null,
    services: stack.serviceIds
      .map((id) => projects.find((p) => p.id === id))
      .filter(Boolean)
      .map(summarize)
  };
}

/** Starts every service of a stack in order; resolves when they are up or one fails. */
async function startStack(ref) {
  const stack = await resolveStack(ref);
  const result = await request('POST', `/api/stacks/${encodeURIComponent(stack.id)}/start`);
  return { ...(await describeStack(result)), ok: result.ok !== false, problems: result.problems || [] };
}

async function stopStack(ref) {
  const stack = await resolveStack(ref);
  return describeStack(await request('POST', `/api/stacks/${encodeURIComponent(stack.id)}/stop`));
}

async function listProjects() {
  const list = await request('GET', '/api/projects');
  return Array.isArray(list) ? list : [];
}

/** Finds a project by id, exact name, exact path, or a unique partial name. */
async function resolveProject(ref) {
  const needle = String(ref || '').trim();
  if (!needle) throw new Error('A project name or id is required.');
  const all = await listProjects();
  const lower = needle.toLowerCase();
  const exact =
    all.find((p) => p.id === needle) ||
    all.filter((p) => String(p.name).toLowerCase() === lower)[0] ||
    all.find((p) => String(p.path).toLowerCase() === lower);
  if (exact) return exact;
  const partial = all.filter((p) => String(p.name).toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(
      `"${needle}" matches several projects: ${partial.map((p) => p.name).join(', ')}. Use the exact name or id.`
    );
  }
  throw new Error(
    `No project matches "${needle}". Known projects: ${all.map((p) => p.name).join(', ') || '(none yet)'}.`
  );
}

async function getProject(ref) {
  const found = await resolveProject(ref);
  const fresh = (await listProjects()).find((p) => p.id === found.id);
  return fresh || found;
}

/** Starts a project and waits until its URL is known, it crashes, or the wait runs out. */
async function startProject(ref, { waitSeconds = 20 } = {}) {
  const project = await resolveProject(ref);
  let current = await request('POST', `/api/projects/${encodeURIComponent(project.id)}/start`);
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  while (Date.now() < deadline && !current.detectedUrl && current.status === 'running') {
    await sleep(500);
    current = (await listProjects()).find((p) => p.id === project.id) || current;
  }
  return current;
}

async function stopProject(ref) {
  const project = await resolveProject(ref);
  return request('POST', `/api/projects/${encodeURIComponent(project.id)}/stop`);
}

async function restartProject(ref, opts = {}) {
  const project = await resolveProject(ref);
  await request('POST', `/api/projects/${encodeURIComponent(project.id)}/restart`);
  return startWaiting(project.id, opts);
}

async function startWaiting(id, { waitSeconds = 20 } = {}) {
  let current = (await listProjects()).find((p) => p.id === id);
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  while (current && Date.now() < deadline && !current.detectedUrl && current.status === 'running') {
    await sleep(500);
    current = (await listProjects()).find((p) => p.id === id) || current;
  }
  return current;
}

async function getLogs(ref, { lines = 50, stream = 'all' } = {}) {
  const project = await resolveProject(ref);
  const data = await request('GET', `/api/projects/${encodeURIComponent(project.id)}/logs`);
  let entries = Array.isArray(data && data.logs) ? data.logs : [];
  if (stream !== 'all') entries = entries.filter((e) => e.stream === stream);
  const count = Math.min(Math.max(Number(lines) || 50, 1), 200);
  return entries.slice(-count).map((e) => ({
    time: e.timestamp || null,
    stream: e.stream,
    text: e.text
  }));
}

async function addProject({ path, name, command, port }) {
  if (!path) throw new Error('A folder path is required.');
  const body = { path };
  if (name) body.name = name;
  if (command) body.command = command;
  if (port !== undefined && port !== null && port !== '') body.customPort = port;
  return request('POST', '/api/projects', body);
}

async function inspectPath(path) {
  return request('POST', '/api/inspect', { path });
}

async function stopAll() {
  return request('POST', '/api/projects/stop-all');
}

module.exports = {
  request,
  summarize,
  listProjects,
  resolveProject,
  getProject,
  startProject,
  stopProject,
  restartProject,
  getLogs,
  addProject,
  inspectPath,
  stopAll,
  listStacks,
  resolveStack,
  describeStack,
  startStack,
  stopStack,
  getBaseUrl
};
