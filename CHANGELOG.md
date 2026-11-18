# Changelog

All notable changes to Portly are listed here. Versions follow [semantic versioning](https://semver.org).

## 1.3.0 (2026-11-18)

This release adds Stacks, per-project environment variables and named URLs, and fixes a long list of bugs found in a full review of the app. Portly is also faster with busy dev servers and easier to use on macOS and Linux.

### New

- **Stacks.** Group a frontend, an API, a worker and a database into one stack and start them with one switch. Each service waits until the one before it is answering before it starts, and the stack stops in reverse order. When you add a stack, Portly suggests its services from a Procfile, npm/pnpm/yarn workspaces, a Docker Compose file or folders like `web/` and `api/`.
- **Environment variables per project.** Keep variables in Portly instead of a `.env` file, and switch between profiles such as Dev and Test. You can import an existing `.env` file. Variables set on a stack are shared by its services, and a service's own value wins. Values can refer to each other with `${NAME}`.
- **Your variables stay private.** In the desktop app they are encrypted with your operating system's keychain (Windows DPAPI, macOS Keychain, or the Linux secret store). They are never written to logs or included in exported setups.
- **Services find each other.** Every service in a stack gets its siblings' ports as variables, for example `PORTLY_API_PORT` and `PORTLY_DB_URL`, so you don't have to hard-code ports.
- **Named URLs.** Open `http://shop.localhost:1355` or `http://api.shop.localhost:1355` instead of remembering port numbers. Portly forwards each name to whatever port the app got today, including WebSockets, so hot reload keeps working. If an app is stopped, the page tells you so instead of failing to connect. You can turn this off or change the port in Settings.
- **Stacks from the command line and AI agents.** `portly-cli stacks`, `start-stack` and `stop-stack` are new, and the MCP server can list, start and stop stacks.
- **Starting and crash reasons on the card.** A project now shows "Starting…" until its server actually answers, and a crashed project says why it stopped.
- **System theme.** A new System option follows your operating system's light or dark mode.

### Fixed

- Clicking Start several times quickly no longer launches duplicate copies of a server.
- Restarting a project no longer loses track of the new run when the old one exits.
- Stopping a project or a stack now ends the whole process tree, including `npm` and `cmd` wrappers, so no orphaned servers are left holding ports.
- A damaged project list is restored from its backup instead of being wiped, and settings are saved safely so a crash mid-save can't corrupt them.
- Portly refuses a custom port that is the same as its own control panel port.
- Imported setups can no longer point log files outside Portly's logs folder, and an import that changes a project's command asks you to confirm it first.
- The built-in static server no longer serves files from folders next to your site and no longer crashes on malformed addresses.
- The control panel now sends a Content-Security-Policy.
- Launching Portly a second time hands over to the running copy straight away, without re-reading or rewriting your project list.
- Fixed a crash on Windows when an app behind a named URL was stopped while a request was open.

### Faster

- Opening a project's logs reads only the end of the file, so it stays instant even for large logs. Logs now rotate at 5 MB instead of growing forever.
- Busy dev servers no longer slow the app down. Output is written through one open file per project and sent to the window in batches.
- The log pane adds new lines instead of redrawing everything, and project cards update in place instead of the whole grid being rebuilt.
- Portly does less work while it's hidden in the tray.
- Checking whether a port is free is now instant on Windows.
- The static server supports browser caching, so reloading a static site is quicker.
- The Windows installer is smaller because it no longer ships unused language packs.

### Design and usability

- macOS gets native traffic-light window buttons, and Linux uses the normal window frame. Windows uses system caption buttons, so Snap Layouts work.
- The window opens in your saved theme, with no dark flash for light-theme users.
- Every button and control now shows a visible focus ring when you use the keyboard, and Escape closes dialogs.
- Normal output on stderr (npm, Vite, webpack, Python logging) is no longer shown in red. Only real errors are red, warnings are amber, and terminal colours are shown.
- The log Clear button is now labelled "Clear log file" so it's clear that it deletes the file.
- New stack cards, an environment variable editor and named URL settings match the rest of the app.

## 1.2.2

- 1024 px app icon for the macOS build.

## 1.2.1

- Fixed the Windows CI test and added the logo and setup steps.
