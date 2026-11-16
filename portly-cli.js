#!/usr/bin/env node
'use strict';

/**
 * Command line control for a running Portly. Works with any AI agent that can run shell
 * commands (and for people who like terminals). Output is JSON unless noted.
 *
 *   node portly-cli.js list
 *   node portly-cli.js start <project> [--wait 20]
 *   node portly-cli.js stop <project>
 *   node portly-cli.js restart <project>
 *   node portly-cli.js status <project>
 *   node portly-cli.js logs <project> [--lines 50] [--stream stderr]
 *   node portly-cli.js add <folder> [--name N] [--command "npm run dev"] [--port 3000]
 *   node portly-cli.js stop-all
 */

const client = require('./portly-client');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const USAGE = `Portly CLI (needs the Portly app to be running)

  list                       Show all projects and their status
  status <project>           Show one project
  start <project> [--wait N] Start a project and print its URL (waits up to N seconds, default 20)
  stop <project>             Stop a project
  restart <project>          Restart a project
  logs <project> [--lines N] [--stream stdout|stderr|system]
  add <folder> [--name N] [--command C] [--port P]
  stop-all                   Stop every running project

<project> is a project name, id or folder path. Set PORTLY_URL to use a different port.`;

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [cmd, arg] = positional;
  const print = (v) => console.log(JSON.stringify(v, null, 2));

  switch (cmd) {
    case 'list': {
      const list = await client.listProjects();
      print(list.map(client.summarize));
      break;
    }
    case 'status':
      print(client.summarize(await client.getProject(arg)));
      break;
    case 'start':
      print(
        client.summarize(
          await client.startProject(arg, { waitSeconds: flags.wait === undefined ? 20 : Number(flags.wait) })
        )
      );
      break;
    case 'stop':
      print(client.summarize(await client.stopProject(arg)));
      break;
    case 'restart':
      print(client.summarize(await client.restartProject(arg)));
      break;
    case 'logs':
      print(
        await client.getLogs(arg, {
          lines: flags.lines,
          stream: typeof flags.stream === 'string' ? flags.stream : 'all'
        })
      );
      break;
    case 'add':
      print(
        client.summarize(
          await client.addProject({
            path: arg,
            name: typeof flags.name === 'string' ? flags.name : undefined,
            command: typeof flags.command === 'string' ? flags.command : undefined,
            port: flags.port
          })
        )
      );
      break;
    case 'stop-all':
      print((await client.stopAll()).map(client.summarize));
      break;
    default:
      console.log(USAGE);
      process.exitCode = cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
