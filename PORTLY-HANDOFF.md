# Portly handoff: state of development and launch plan

Written 16 Nov 2026 so another Claude chat can pick up the work. Read the whole file before changing anything.

This replaces the older `claudeportly_handoff.md`, which describes v1.1.0 in the old Antigravity folder and is now out of date.

---

## 1. What Portly is

Portly is a free, open-source (MIT) desktop app by **DnG Web Solutions** for Windows, macOS and Linux. It starts, stops, monitors and logs local dev servers and web apps from one window, and it auto-detects 30+ stacks.

- **Architecture:** an Electron shell (`electron-main.js`) around a Node server with no dependencies (`server.js`, on `127.0.0.1:4567`, with SSE for live updates) and a plain HTML/CSS/JS frontend (`public/`).
- **Data:** the installed app keeps projects and settings in `%APPDATA%\Portly` (Electron `userData`, via `DEVDECK_DATA_DIR`). The source edition uses `./data/`.
- **Current version:** **1.2.0** (`package.json`).
- **People:** Dal (GitHub login `shipnlabels`) runs the project and is the one working with Claude. Gabe owns the Windows machine and the paths below. The DnG site's CLAUDE.md names "Gabe or Dalyn" as the approvers for SEO pages.

---

## 2. Where everything lives

| What | Where |
|---|---|
| **Portly source (current home)** | `C:\Users\Gabe\Documents\dng sollutions\portly\portly-app` |
| Landing page | `portly-app\docs\` |
| Release workflow (not yet in place, see 4.1) | `portly-app\release.yml`, which must become `.github\workflows\release.yml` |
| Old copy (do not use or publish) | `C:\Users\Gabe\.gemini\antigravity\scratch\local-project-manager` |
| DnG website (Next.js 16 + Tailwind 4) | `C:\Users\Gabe\Documents\dng sollutions\dng sollutions` |
| Step-by-step guide for Dal | `PORTLY-PUBLISHING-GUIDE.md` (project files) |
| v1.1.0 audit report | `portly-fixes/AUDIT-REPORT.md` (project files) |

The project was **copied, not moved**. The new folder has no `node_modules`, `dist`, `release`, logs or `data`. `gabe-workspace.portly.json` (Gabe's saved project list) was copied in and is git-ignored. It must never be committed.

The old folder's `release\` and `dist\` hold builds of the **vulnerable** v1.1.0. Never upload them.

---

## 3. What has been done

### 3.1 Security and privacy audit (v1.1.0 → 1.2.0)
1. **Critical, fixed:** any web page could call the control API (CSRF), add a project with any command and start it, which meant remote code execution. DNS rebinding could also read projects and logs. `server.js` now runs `rejectUntrustedRequest`, which checks the Host, Origin and `Sec-Fetch-Site` headers. Tests cover it.
2. On first run, Portly auto-imported every project in the folder above the app. That is removed, so fresh installs start empty.
3. Personal paths were baked into the launchers (`Portly.desktop`, `Portly.app`) and `DEV_NOTES.md` named client projects. Both are scrubbed, the launchers are now portable, and the tests write to a temp folder.
4. Electron 35 → **45.3.2**, electron-builder → **26.18.0**. npm audit went from 18 issues (1 critical) to 6 moderate, all in build-only tools.
5. Smaller fixes:
   - The window can no longer navigate to a foreign site (`will-navigate` lockdown). External links open in the browser.
   - If another program holds port 4567, Portly shows an error dialog instead of loading that program's page.
   - `SHA256SUMS.txt` now uses the standard format.
   - Custom ports are validated to 1–65535.
   - Dead endpoints `/api/launch-app-window` and `/api/install-shortcut` are removed.
   - Fixed the header merge in `apiRequest()`.
   - Unused JPG logos are excluded from the build.
   - `Info.plist` takes its version from `package.json`.
   - The tests are now cross-platform.

### 3.2 AI agent integration (new in 1.2.0)
Agents can control Portly with **no new network port**:
- **`portly-mcp.js`**, an MCP server over stdio (newline-delimited JSON-RPC: initialize, tools/list, tools/call, ping). Its tools are:
  - `portly_list_projects`
  - `portly_get_project`
  - `portly_start_project` (waits for the URL)
  - `portly_stop_project`
  - `portly_restart_project`
  - `portly_get_logs`
  - `portly_inspect_folder`
  - `portly_add_project`
  - `portly_stop_all`

  On purpose, there is no tool to delete projects or change settings.
- **`portly-cli.js`**, a CLI for agents that only run shell commands, with `list`, `status`, `start`, `stop`, `restart`, `logs`, `add` and `stop-all`.
- **`portly-client.js`** is shared by both. It talks to the local Portly API, and `PORTLY_URL` must be a loopback address.
- The README has setup for Claude Code, Codex, Gemini CLI, Antigravity, Cursor and VS Code, plus an `ELECTRON_RUN_AS_NODE` option for machines without Node.
- These files are listed in `asarUnpack` so the installed app can run them: `%LOCALAPPDATA%\Programs\Portly\resources\app.asar.unpacked\portly-mcp.js`.

### 3.3 Release tooling
- **`package.json`** sets the artifact names:
  - `Portly-Setup-<v>-win-x64.exe`
  - `Portly-Portable-<v>-win-x64.exe`
  - `Portly-<v>-mac-<arch>.dmg`
  - `.AppImage` and `.deb`

  The Linux maintainer is `DnG Web Solutions <info@dngwebsolutions.com>`.
- **`build-release.js`** (`npm run release`) collects the build into `./release` with checksums and the source zip.
- **`release.yml`** is a GitHub Actions workflow. Pushing a tag `v*` runs the tests on 3 OSes, builds each platform on its own runner, and creates a **draft** release with `SHA256SUMS.txt`.
- **`scripts/set-repo.js`** replaces the placeholder `juniortheshooter/portly` in every link. Usage: `node scripts/set-repo.js OWNER/portly`.
- `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `.gitattributes` (LF for `.sh` and `.command`) and `.gitignore` (data/, configs/, crash-reports/, Portly.lnk, public/*.jpg, *.portly.json) are all in place.

### 3.4 Landing page (`docs/`)
- Static `index.html`, `style.css`, `site.js`, bundled woff2 fonts (Inter, Inter Tight, JetBrains Mono) and `assets/portly-app.webp`. The screenshot is a real Portly window running **made-up demo projects**.
- It matches the DnG theme: `--ground #08091a`, `--ground-raised #0e1030`, `--rule-strong #2b2f57`, `--mint #4fe3c1`, `--indigo #6366f1`, `--ink-2 #bcc0de`, `--ink-3 #7f84a8`.
- It makes no outside requests, so it passes the DnG site's strict CSP (`default-src 'self'`, `font-src 'self'`, `connect-src 'self'`).
- The download buttons point to `github.com/<owner>/portly/releases/latest/download/...` and detect the visitor's OS, so the page never needs editing for new versions.

### 3.5 Latest fix (Windows, not yet confirmed)
Dal's Windows test run failed at the "start project" check (`expected 'running', actual 'crashed'`). The cause: under `cmd.exe`, Node's quoting broke commands with quoted paths that contain spaces (Gabe's path has spaces).

The fix in `server.js` runs the command verbatim, the way Node's `shell:true` does:
```js
spawn(cmdExe, ['/d', '/s', '/c', `"${command}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true });
```
It also makes `STATIC_SERVER_SCRIPT` point to `app.asar.unpacked` in packaged builds, and `static-server.js` is now in `asarUnpack`.

---

## 4. Test status

| Where | Result |
|---|---|
| Linux sandbox | **15/15 pass**, including from a path with spaces |
| Linux packaging | `.deb` and `.AppImage` build cleanly |
| Gabe's Windows PC | **Not yet confirmed** after the spaces fix. Dal was asked to rerun. |
| Windows installer, macOS build | Not built yet. CI builds macOS. |
| MCP with a real agent on Windows | Not tested yet |

How to run the tests on Windows (PowerShell, in `portly-app`):
```powershell
$tmp = New-Item -ItemType Directory -Path "$env:TEMP\portly-test-$(Get-Random)"
$env:DEVDECK_DATA_DIR = $tmp.FullName
npm.cmd test
Remove-Item Env:DEVDECK_DATA_DIR
Remove-Item $tmp.FullName -Recurse -Force
```
Expected output: `ALL_MULTI_OS_TESTS_PASSED (15/15)`. **Always** set `DEVDECK_DATA_DIR`, or the tests touch the real `data/`.

---

## 5. Open questions (ask Dal; don't guess)

1. **GitHub owner. ANSWERED 2026-11-16:** Gabe chose **`juniortheshooter/portly`**. Run `node scripts/set-repo.js juniortheshooter/portly` **before** the first commit, or the download buttons will 404. (The restyled `docs/` page already uses this address.)
2. **Website address.** Dal chose **Option B, `dngwebsolutions.com/portly`**, and the guide is written for it. Option A (`portly.dngwebsolutions.com` via GitHub Pages and a Cloudflare CNAME) was offered and not chosen. Only revisit it if Dal brings it up.
3. **Maintainer email.** The `.deb` package shows `info@dngwebsolutions.com`. Confirm that's fine.
4. **Code signing.** The builds are unsigned, so users see SmartScreen and Gatekeeper warnings. A certificate costs money every year. This is Dal's call, and it is not planned for 1.2.0.

---

## 6. Launch plan

The full click-by-click version is in `PORTLY-PUBLISHING-GUIDE.md`. Here it is in order:

### 6.1 Local install and verification (Gabe's PC)
1. Quit Portly fully (tray icon > Exit), so port 4567 is free.
2. `cd "C:\Users\Gabe\Documents\dng sollutions\portly\portly-app"`
3. Move the workflow into place:
   ```powershell
   New-Item -ItemType Directory -Force .github\workflows | Out-Null
   Move-Item release.yml .github\workflows\release.yml
   ```
   The remote file tools can't write into `.github`, which is why it isn't there already.
4. `npm.cmd install`
5. Run the tests as in section 4. **Must be 15/15 before going further.**
6. `$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"; npm.cmd run dist:win`
7. Run `dist\Portly-Setup-1.2.0-win-x64.exe` over the old install (SmartScreen: More info > Run anyway). Check that the projects are still there, since they live in `%APPDATA%\Portly`.
8. Optional: connect Claude Code and try it.
   ```powershell
   claude mcp add --scope user portly -- node "C:/Users/Gabe/Documents/dng sollutions/portly/portly-app/portly-mcp.js"
   ```
9. After a day of normal use, rename the old folder to `local-project-manager.OLD`. Delete it a week later.

### 6.2 GitHub repo and release (GitHub Desktop)
1. `node scripts/set-repo.js OWNER/portly` (see open question 1).
2. GitHub Desktop > File > Add local repository > `portly-app` > **create a repository here**. Name `portly`, branch `main`, Git ignore None, License None (both already exist).
3. **Check the Changes list (about 50 files).** It must NOT include `node_modules`, `dist`, `release`, `data`, `logs`, `Portly.lnk` or `gabe-workspace.portly.json`. Stop if any appear.
4. Commit `Portly 1.2.0`, then Publish repository as **public** (untick "Keep this code private").
5. Optional: on github.com, Settings > Pages > Deploy from branch `main`, folder `/docs` (a preview copy of the page).
6. History tab > right-click the commit > **Create Tag** `v1.2.0` > **Push origin**.
7. Actions: wait 10–20 minutes for all jobs to go green. If one fails, get the red error text and fix it.
8. Releases: open the **draft**, test the Windows installer from it, then **Publish release**.
9. Repo About: description, website `https://dngwebsolutions.com/portly`, topics `electron`, `dev-tools`, `mcp`. Settings > Security: turn on Private vulnerability reporting.

### 6.3 DnG website page at /portly (Option B)

> **Update 2026-11-16: done differently.** The DnG site now has a native Next.js page at `app/(site)/portly/page.tsx` that uses the site's own header, motion and cards, so the steps below (copying `docs/` into `public/portly/` and adding a rewrite) are **no longer needed**. Do not do both, or `/portly` will conflict. The repo address lives in `lib/portly.ts` (`PORTLY_REPO`). The page and its footer and sitemap links should go live only after the first GitHub release is published. `docs/` was restyled to match it and stays as the GitHub Pages copy.

**This change happens in the DnG website project, not here.** The site has its own CLAUDE.md, so use the DnG project's assistant or do it by hand. Rules from that CLAUDE.md:
- **Never** publish the draft SEO pages (`lib/seo-pages.ts`) without page-by-page approval from Gabe or Dalyn.
- Pennsylvania SEO pages are now allowed (Gabe lifted that rule on 2026-11-16).
- Commit only the Portly files, on a branch.

Steps:
1. Copy **everything inside** `portly-app\docs` (including `fonts`, `assets` and `.nojekyll` if present) into `dng sollutions\public\portly\`.
2. In `next.config.ts`, add this above `async headers()`:
   ```ts
   async rewrites() {
     return [{ source: "/portly", destination: "/portly/index.html" }];
   },
   ```
3. In `public\portly\index.html`, add `<base href="/portly/">` right after `<meta charset="utf-8">`.
4. `npm run dev`, then open `http://localhost:3000/portly`. Fonts, screenshot and buttons must work, and there must be no CSP errors in the console. Then `npm run build`.
5. Add a footer or Work-section link, "Free tools: Portly" → `/portly`. Optionally add `/portly` to `app/sitemap.ts`.
6. GitHub Desktop, in the site repo: branch `add-portly-page`, tick **only** `next.config.ts`, `public/portly/**` and the footer and sitemap files. Commit, Publish branch, check the preview deploy, merge.
7. Only go live after the GitHub release is **published**, or the download buttons 404.

A ready-made prompt for the DnG assistant is at the end of section 3 in `PORTLY-PUBLISHING-GUIDE.md`.

### 6.4 Later releases
1. `npm.cmd version 1.2.1 --no-git-tag-version`
2. Commit `Portly 1.2.1`, Push origin.
3. Tag `v1.2.1` and push it, then review and publish the draft release.

The website needs no change.

---

## 7. Rules for whoever continues

- **Don't weaken `rejectUntrustedRequest`** or add an HTTP endpoint that bypasses it. Agent access goes through MCP and the CLI (stdio and loopback), never a new open port.
- Never commit or ship personal data: `data/`, `*.portly.json`, logs, real project names, `C:\Users\Gabe\...` paths.
- Run the tests with `DEVDECK_DATA_DIR` set to a temp folder.
- Keep the README and landing page in plain language, in the same tone they use now.
- Keep `docs/` free of outside requests (no CDN fonts, scripts or analytics), or it breaks the DnG CSP.
- When you add a new file the packaged app must run outside the asar (like the MCP files), add it to `asarUnpack`.
- Windows users run PowerShell with `npm.cmd`, and their paths contain spaces. Test with spaces.

## 8. Ideas for after launch (not started)
- Code signing (Windows certificate, Apple Developer ID and notarization).
- Auto-update (electron-updater against GitHub Releases).
- A winget, Homebrew cask or Scoop manifest.
- More MCP tools if users ask: open the project URL, tail logs as a stream.
- Optional: test the MCP server with Codex and Gemini CLI on Windows and note any quirks in the README.
