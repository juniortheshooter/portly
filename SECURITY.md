# Security Policy

## Reporting a problem

If you find a security issue in Portly, please report it privately through GitHub's **Report a vulnerability** button on the repository's **Security** tab instead of opening a public issue. Include the steps to reproduce it and the Portly version you used.

## How Portly protects you

- The control panel listens only on `127.0.0.1`, so other computers on your network can't reach it.
- It refuses requests that come from other websites or from a different host name, so a page you visit can't add, change, or start projects.
- The optional AI agent integration (`portly-mcp.js`) uses standard input and output and opens no network port. It only reaches Portly on your own computer.
- It never starts a project by itself. Commands only run when you press Start.
- Portly sends no telemetry and talks to no online service.

Portly runs the commands you give it, so only add projects and import config files you trust.
