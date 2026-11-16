#!/usr/bin/env node
'use strict';

/**
 * Portly MCP server.
 *
 * Lets AI coding agents (Claude Code, OpenAI Codex, Gemini CLI, Antigravity, Cursor, VS Code
 * and any other MCP client) list, start, stop and read logs from the projects registered in
 * Portly.
 *
 * Transport: stdio only. The agent launches this script as a child process and talks to it
 * over stdin/stdout. It opens no network port of its own and forwards requests to the Portly
 * app already running on this computer (127.0.0.1), which only accepts local requests.
 *
 * IMPORTANT: stdout carries the protocol. Never write anything else to stdout.
 */

const readline = require('node:readline');
const client = require('./portly-client');

let version = '0.0.0';
try {
  version = require('./package.json').version;
} catch {
  // package.json is not always next to this file in packaged installs
}
const SERVER_INFO = { name: 'portly', version };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const projectRef = {
  type: 'string',
  description: 'Project name (as shown in Portly), exact path, or id. A unique partial name also works.'
};

const TOOLS = [
  {
    name: 'portly_list_projects',
    description:
      'List every project registered in Portly with its status (running, stopped, crashed), URL and port. Call this first to see what is available.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List Portly projects', readOnlyHint: true, openWorldHint: false },
    run: async () => {
      const list = await client.listProjects();
      return { count: list.length, projects: list.map(client.summarize) };
    }
  },
  {
    name: 'portly_get_project',
    description: 'Get the current status, URL, port and start command of one Portly project.',
    inputSchema: {
      type: 'object',
      properties: { project: projectRef },
      required: ['project'],
      additionalProperties: false
    },
    annotations: { title: 'Get project status', readOnlyHint: true, openWorldHint: false },
    run: async ({ project }) => client.summarize(await client.getProject(project))
  },
  {
    name: 'portly_start_project',
    description:
      'Start a registered project\'s dev server. Waits up to wait_seconds for the local URL to appear, then returns it. Portly picks a free port if the default is taken, so always use the URL it returns.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectRef,
        wait_seconds: {
          type: 'integer',
          minimum: 0,
          maximum: 120,
          description: 'How long to wait for the server URL. Default 20.'
        }
      },
      required: ['project'],
      additionalProperties: false
    },
    annotations: {
      title: 'Start a project',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    run: async ({ project, wait_seconds }) =>
      client.summarize(
        await client.startProject(project, {
          waitSeconds: wait_seconds === undefined ? 20 : wait_seconds
        })
      )
  },
  {
    name: 'portly_stop_project',
    description: 'Stop a running project and everything it spawned.',
    inputSchema: {
      type: 'object',
      properties: { project: projectRef },
      required: ['project'],
      additionalProperties: false
    },
    annotations: {
      title: 'Stop a project',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    run: async ({ project }) => client.summarize(await client.stopProject(project))
  },
  {
    name: 'portly_restart_project',
    description: 'Restart a project (stop, then start) and wait for its URL.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectRef,
        wait_seconds: { type: 'integer', minimum: 0, maximum: 120 }
      },
      required: ['project'],
      additionalProperties: false
    },
    annotations: {
      title: 'Restart a project',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    run: async ({ project, wait_seconds }) =>
      client.summarize(
        await client.restartProject(project, {
          waitSeconds: wait_seconds === undefined ? 20 : wait_seconds
        })
      )
  },
  {
    name: 'portly_get_logs',
    description:
      'Read recent output (stdout, stderr and Portly system messages) from a project. Use it to find out why a server crashed or failed to start.',
    inputSchema: {
      type: 'object',
      properties: {
        project: projectRef,
        lines: { type: 'integer', minimum: 1, maximum: 200, description: 'Most recent lines to return. Default 50.' },
        stream: { type: 'string', enum: ['all', 'stdout', 'stderr', 'system'], description: 'Default all.' }
      },
      required: ['project'],
      additionalProperties: false
    },
    annotations: { title: 'Read project logs', readOnlyHint: true, openWorldHint: false },
    run: async ({ project, lines, stream }) => {
      const entries = await client.getLogs(project, { lines, stream });
      return { count: entries.length, logs: entries };
    }
  },
  {
    name: 'portly_inspect_folder',
    description:
      'Detect what kind of project is in a folder (stack, framework, suggested start command, default port) without registering it.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute folder path.' } },
      required: ['path'],
      additionalProperties: false
    },
    annotations: { title: 'Inspect a folder', readOnlyHint: true, openWorldHint: false },
    run: async ({ path }) => {
      const r = await client.inspectPath(path);
      return {
        valid: r.valid,
        error: r.error || null,
        name: r.name || null,
        language: r.language || null,
        framework: r.framework || null,
        suggestedCommand: r.recommendedCommand || r.suggestedCommand || null,
        defaultPort: r.defaultPort || null
      };
    }
  },
  {
    name: 'portly_add_project',
    description:
      'Register a project folder in Portly so it can be started and stopped. Portly auto-detects the stack and start command; pass command only to override it. Does not start the project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the project folder.' },
        name: { type: 'string', description: 'Display name. Defaults to the folder name.' },
        command: { type: 'string', description: 'Start command override, e.g. "npm run dev".' },
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Fixed port, if the project needs one.' }
      },
      required: ['path'],
      additionalProperties: false
    },
    annotations: {
      title: 'Add a project',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    run: async (args) => client.summarize(await client.addProject(args))
  },
  {
    name: 'portly_stop_all',
    description: 'Stop every running project in Portly.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: {
      title: 'Stop all projects',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    run: async () => {
      const list = await client.stopAll();
      return { projects: (Array.isArray(list) ? list : []).map(client.summarize) };
    }
  }
];

const toolsByName = new Map(TOOLS.map((t) => [t.name, t]));

function publicTool(tool) {
  const { run, ...rest } = tool;
  return rest;
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleCall(id, params) {
  const tool = toolsByName.get(params && params.name);
  if (!tool) {
    replyError(id, -32602, `Unknown tool: ${params && params.name}`);
    return;
  }
  try {
    const result = await tool.run((params && params.arguments) || {});
    reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
  } catch (err) {
    // Tool failures are reported inside the result so the model can read and react to them.
    reply(id, {
      content: [{ type: 'text', text: err && err.message ? err.message : String(err) }],
      isError: true
    });
  }
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return;
  const isRequest = msg.id !== undefined && msg.id !== null;

  switch (msg.method) {
    case 'initialize': {
      const wanted = msg.params && msg.params.protocolVersion;
      reply(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Portly manages local dev servers. Call portly_list_projects first, then start/stop projects by name. Always use the URL returned by portly_start_project, because Portly may pick a different port to avoid conflicts.'
      });
      return;
    }
    case 'ping':
      if (isRequest) reply(msg.id, {});
      return;
    case 'tools/list':
      reply(msg.id, { tools: TOOLS.map(publicTool) });
      return;
    case 'tools/call':
      await handleCall(msg.id, msg.params);
      return;
    default:
      if (isRequest) replyError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

if (require.main === module) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let inFlight = 0;
  let inputClosed = false;
  const maybeExit = () => {
    if (inputClosed && inFlight === 0) process.exit(0);
  };
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      replyError(null, -32700, 'Parse error');
      return;
    }
    inFlight++;
    handleMessage(msg)
      .catch((err) => {
        if (msg && msg.id !== undefined && msg.id !== null) {
          replyError(msg.id, -32603, err && err.message ? err.message : 'Internal error');
        }
      })
      .finally(() => {
        inFlight--;
        maybeExit();
      });
  });
  // Exit when the agent closes stdin, but finish any request still being answered first.
  rl.on('close', () => {
    inputClosed = true;
    maybeExit();
  });
  // Anything diagnostic goes to stderr, never stdout.
  process.on('uncaughtException', (err) => console.error('portly-mcp error:', err.message));
}

module.exports = { TOOLS, handleMessage };
