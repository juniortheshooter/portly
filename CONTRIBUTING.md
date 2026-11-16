# Contributing to Portly

Thank you for helping improve **Portly**! This project is open-source freeware licensed under the [MIT License](LICENSE).

## Project Architecture

- `server.js` — Zero-dependency Node.js backend (`node:http`, `node:net`, `node:os`, `node:child_process`, `node:fs`) handling project inspection across 30+ stacks, cross-platform process lifecycle management (`cmd.exe`/`taskkill` on Windows and `$SHELL`/process-group signals on POSIX), SSE log streaming, native folder pickers, crash report exports, and environment config `.json` import/export.
- `public/index.html`, `public/styles.css`, `public/app.js` — Frontend single-page dashboard featuring Light & Carbon Grey Dark themes, dynamic split panes, Overview scaling, onboarding screen, and Settings modal.
- `electron-main.js` — Native frameless Electron shell (`BrowserWindow`, system tray, native save/folder dialogs).
- `desktop-app.js` — Zero-dependency desktop window runner using Edge/Chrome/Brave/Chromium `--app` mode.
- `static-server.js` — Lightweight static HTTP server for plain HTML/CSS/JS websites.
- `install-app.js` — Generator for Windows (`.bat`/`.vbs`/`.lnk`), macOS (`.command`/`.app`), and Linux (`.sh`/`.desktop`) launchers.
- `build-release.js` — Packs clean, privacy-safe distributables, SHA-256 checksums, and an embeddable website download section into `release/`.
- `test-multi-os.js` — Automated verification suite covering syntax, stack detection, cross-platform ENV merging, launchers, and HTTP API endpoints.

## Development Workflow

1. Run `npm run app` (zero dependencies required) or `npm run electron` to launch the desktop studio.
2. Edit code, keeping personal local paths (`data/projects.json`, `*.portly.json`, logs, configs) out of commits and release archives.
3. Run `node test-multi-os.js` before opening a pull request and confirm all checks pass cleanly.
4. Keep POSIX launcher templates using Unix `LF` line endings so macOS and Linux scripts execute cleanly without `\r` errors.
