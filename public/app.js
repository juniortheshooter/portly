'use strict';

const state = {
  projects: [],
  // Stacks: groups of services that start together (see stacks-ui.js).
  stacks: [],
  settings: {
    userName: '',
    theme: 'light',
    defaultExpanded: false,
    allowMultipleInstances: false,
    exitClosesCompletely: false,
    onboarded: false
  },
  system: {
    platform: 'win32',
    osName: 'Multi-OS',
    osFamily: 'windows',
    arch: '',
    fileManagerLabel: 'File Manager',
    shortcutModifier: 'Ctrl',
    shellName: '',
    pathPlaceholder: '~/projects/my-web-app'
  },
  expandedCards: new Set(),
  filter: 'all',
  viewMode: 'split',
  search: '',
  selectedLogProjectId: null,
  logs: [],
  logFilePath: '',
  logStreamFilter: 'all',
  logSearch: '',
  autoScroll: true,
  sse: null,
  // True when SSE updates arrived while the window was hidden; render once it's visible again.
  needsFullRender: false,
  configImportMode: 'replace',
  brokenPathsQueue: [],
  brokenPathsSourceLabel: '',
  layout: {
    overviewMode: 'expanded',
    overviewPosition: 'top',
    overviewScale: 1,
    overviewBlockOrder: ['banner', 'kpis'],
    kpiOrder: ['total', 'running', 'stopped'],
    splitDirection: 'horizontal',
    splitRatio: 56,
    paneFocus: 'split'
  }
};

const els = {
  appFrame: document.querySelector('.app-frame'),
  mainCanvas: document.getElementById('main-canvas'),
  transitionOverlay: document.getElementById('page-transition-overlay'),
  sseBadge: document.getElementById('sse-badge'),
  sseBadgeText: document.getElementById('sse-badge-text'),
  greetingTitle: document.getElementById('greeting-title'),
  statTotal: document.getElementById('stat-total'),
  statRunning: document.getElementById('stat-running'),
  statStopped: document.getElementById('stat-stopped'),
  statCrashed: document.getElementById('stat-crashed'),
  kpiRunningPill: document.getElementById('kpi-running-pill'),
  kpiCrashedPill: document.getElementById('kpi-crashed-pill'),
  overviewSection: document.getElementById('overview-section'),
  overviewContent: document.getElementById('overview-content'),
  overviewResizer: document.getElementById('overview-resizer'),
  kpiGrid: document.getElementById('kpi-grid'),
  overviewCollapsedSummary: document.getElementById('overview-collapsed-summary'),
  overviewModeBtns: Array.from(document.querySelectorAll('.overview-mode-btn')),
  btnOverviewPosition: document.getElementById('btn-overview-position'),
  btnBannerScan: document.getElementById('btn-banner-scan'),
  btnBannerAdd: document.getElementById('btn-banner-add'),
  projectsPaneCount: document.getElementById('projects-pane-count'),
  navCountAll: document.getElementById('nav-count-all'),
  navCountRunning: document.getElementById('nav-count-running'),
  navCountStopped: document.getElementById('nav-count-stopped'),
  navCountCrashed: document.getElementById('nav-count-crashed'),
  sidebarProjectsList: document.getElementById('sidebar-projects-list'),

  btnAddProject: document.getElementById('btn-add-project'),
  btnAddProjectTop: document.getElementById('btn-add-project-top'),
  btnBulkImport: document.getElementById('btn-bulk-import'),
  btnScanFolder: document.getElementById('btn-scan-folder'),
  btnStopAll: document.getElementById('btn-stop-all'),
  btnToggleExpandAll: document.getElementById('btn-toggle-expand-all'),
  ratioPresetBtns: Array.from(document.querySelectorAll('.ratio-preset-btn')),
  btnSplitDirection: document.getElementById('btn-split-direction'),
  workspaceResizer: document.getElementById('workspace-resizer'),
  btnMaximizeProjects: document.getElementById('btn-maximize-projects'),
  btnCollapseConsole: document.getElementById('btn-collapse-console'),
  btnMaximizeConsole: document.getElementById('btn-maximize-console'),

  titlebarTrayBadge: document.getElementById('titlebar-tray-badge'),
  btnWinTray: document.getElementById('btn-win-tray'),
  btnWinMinimize: document.getElementById('btn-win-minimize'),
  btnWinMaximize: document.getElementById('btn-win-maximize'),
  btnWinClose: document.getElementById('btn-win-close'),

  btnSidebarTheme: document.getElementById('btn-sidebar-theme'),
  sidebarThemeIcon: document.getElementById('sidebar-theme-icon'),
  sidebarThemeLabel: document.getElementById('sidebar-theme-label'),
  sidebarThemePill: document.getElementById('sidebar-theme-pill'),
  btnTopbarTheme: document.getElementById('btn-topbar-theme'),
  topbarThemeIcon: document.getElementById('topbar-theme-icon'),

  btnSidebarSettings: document.getElementById('btn-sidebar-settings'),
  btnSidebarCrashReport: document.getElementById('btn-sidebar-crash-report'),
  sidebarKbdHint: document.getElementById('sidebar-kbd-hint'),
  btnReloadApp: document.getElementById('btn-reload-app'),

  filterTabs: Array.from(document.querySelectorAll('.filter-tab')),
  viewBtns: Array.from(document.querySelectorAll('.view-btn')),
  workspaceGrid: document.getElementById('workspace-grid'),
  projectSearch: document.getElementById('project-search'),
  sidebarSearch: document.getElementById('sidebar-search'),
  projectsGrid: document.getElementById('projects-grid'),

  logsProjectTitle: document.getElementById('logs-project-title'),
  logsStatusPill: document.getElementById('logs-status-pill'),
  logsOpenApp: document.getElementById('logs-open-app'),
  logsFilePath: document.getElementById('logs-file-path'),
  streamBtns: Array.from(document.querySelectorAll('.stream-btn')),
  logSearch: document.getElementById('log-search'),
  logAutoScroll: document.getElementById('log-autoscroll'),
  btnCopyLogs: document.getElementById('btn-copy-logs'),
  btnClearLogs: document.getElementById('btn-clear-logs'),
  btnExportCrashLogs: document.getElementById('btn-export-crash-logs'),
  logsOutput: document.getElementById('logs-output'),

  modal: document.getElementById('project-modal'),
  modalTitle: document.getElementById('modal-title'),
  modalClose: document.getElementById('modal-close'),
  modalTabsWrap: document.getElementById('modal-tabs'),
  modalTabs: Array.from(document.querySelectorAll('.modal-tab')),

  singleForm: document.getElementById('single-project-form'),
  editProjectId: document.getElementById('edit-project-id'),
  inputPath: document.getElementById('input-project-path'),
  btnBrowseFolder: document.getElementById('btn-browse-folder'),
  inspectFeedback: document.getElementById('inspect-feedback'),
  inputName: document.getElementById('input-project-name'),
  inputPort: document.getElementById('input-project-port'),
  inputCommand: document.getElementById('input-project-command'),
  selectDetectedScript: document.getElementById('select-detected-script'),
  singleFormError: document.getElementById('single-form-error'),
  btnCancelSingle: document.getElementById('btn-cancel-single'),
  btnSubmitSingle: document.getElementById('btn-submit-single'),

  bulkForm: document.getElementById('bulk-project-form'),
  dropzone: document.getElementById('dropzone'),
  fileUploadInput: document.getElementById('file-upload-input'),
  btnChooseFile: document.getElementById('btn-choose-file'),
  btnBulkBrowseFolder: document.getElementById('btn-bulk-browse-folder'),
  inputBulkPaths: document.getElementById('input-bulk-paths'),
  inputScanSubfolders: document.getElementById('input-scan-subfolders'),
  bulkResultBox: document.getElementById('bulk-result-box'),
  bulkFormError: document.getElementById('bulk-form-error'),
  btnCancelBulk: document.getElementById('btn-cancel-bulk'),
  btnSubmitBulk: document.getElementById('btn-submit-bulk'),

  settingsModal: document.getElementById('settings-modal'),
  settingsModalClose: document.getElementById('settings-modal-close'),
  settingsForm: document.getElementById('settings-form'),
  inputUserName: document.getElementById('input-user-name'),
  inputDefaultExpanded: document.getElementById('input-default-expanded'),
  inputExitClosesCompletely: document.getElementById('input-exit-closes-completely'),
  inputAllowMultipleInstances: document.getElementById('input-allow-multiple-instances'),
  themeChoiceBtns: Array.from(document.querySelectorAll('.theme-choice-btn')),
  settingsOsBadge: document.getElementById('settings-os-badge'),
  settingsOsVersion: document.getElementById('settings-os-version'),
  settingsOsSummary: document.getElementById('settings-os-summary'),
  configModeBtns: Array.from(document.querySelectorAll('.config-mode-btn')),
  btnExportConfig: document.getElementById('btn-export-config'),
  btnImportConfig: document.getElementById('btn-import-config'),
  btnReopenBrokenPaths: document.getElementById('btn-reopen-broken-paths'),
  btnResetSettings: document.getElementById('btn-reset-settings'),
  btnCancelSettings: document.getElementById('btn-cancel-settings'),

  brokenPathsModal: document.getElementById('broken-paths-modal'),
  brokenPathsModalClose: document.getElementById('broken-paths-modal-close'),
  brokenPathsCountPill: document.getElementById('broken-paths-count-pill'),
  brokenPathsSubtitle: document.getElementById('broken-paths-subtitle'),
  brokenPathsList: document.getElementById('broken-paths-list'),
  brokenPathsError: document.getElementById('broken-paths-error'),
  btnBrokenSkipAll: document.getElementById('btn-broken-skip-all'),
  btnBrokenApplyAll: document.getElementById('btn-broken-apply-all'),

  onboardingScreen: document.getElementById('onboarding-screen'),
  onboardingForm: document.getElementById('onboarding-form'),
  onboardingNameInput: document.getElementById('onboarding-name-input'),
  onboardingGreetingPreview: document.getElementById('onboarding-greeting-preview'),
  onboardingThemeBtns: Array.from(document.querySelectorAll('.onboarding-theme-btn')),
  onboardingDefaultExpanded: document.getElementById('onboarding-default-expanded'),
  btnOnboardingImportConfig: document.getElementById('btn-onboarding-import-config'),
  configFileInput: document.getElementById('config-file-input'),

  toastContainer: document.getElementById('toast-container')
};

let inspectTimer = null;
let pendingSettingsTheme = 'light';
let pendingOnboardingTheme = 'light';
const pendingOpenTabs = new Map();

// Clean inline SVG icon helpers
// The desktop shell tells the page how the window frame is drawn (see electron-main.js).
(function applyTitlebarMode() {
  try {
    const mode = new URLSearchParams(window.location.search).get('titlebar');
    if (['overlay', 'inset', 'native'].includes(mode)) {
      document.documentElement.dataset.titlebar = mode;
    }
  } catch {
    // ignore
  }
})();

const systemDarkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function normalizeThemeChoice(theme) {
  return theme === 'dark' || theme === 'system' ? theme : 'light';
}

function resolveTheme(theme) {
  if (theme === 'system') {
    return systemDarkQuery && systemDarkQuery.matches ? 'dark' : 'light';
  }
  return theme === 'dark' ? 'dark' : 'light';
}

function setPressed(buttons, isPressed) {
  for (const btn of buttons || []) {
    const pressed = Boolean(isPressed(btn));
    btn.classList.toggle('active', pressed);
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
}

/** A project is "starting" while it runs but no URL/port has answered yet. */
function getProjectPhase(p) {
  // Workers have no port to wait for: once their process is up, they are running.
  if (p.status === 'running' && !p.detectedUrl && p.kind !== 'worker') return 'starting';
  return p.status;
}

const STARTING_SLOW_MS = 20000;

function getStartingText(p) {
  const port = p.assignedPort || p.customPort || p.defaultPort;
  if (p.startedAt && Date.now() - p.startedAt > STARTING_SLOW_MS) {
    return 'No port detected yet. Check the logs.';
  }
  return port ? `Starting… waiting for :${port}` : 'Starting…';
}

function iconSpark() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3L12 3Z"></path></svg>';
}

function iconPlay() {
  return '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"></polygon></svg>';
}

function iconStop() {
  return '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2.5"></rect></svg>';
}

function iconRestart() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path><path d="M3 3v5h5"></path></svg>';
}

function iconCopy() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>';
}

function iconFolder() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"></path></svg>';
}

function iconTerminal() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>';
}

function iconSettings() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"></path></svg>';
}

function iconTrash() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>';
}

function iconExternal() {
  return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
}

function iconChevron() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
}

function iconSun() {
  return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path></svg>';
}

function iconMoon() {
  return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path></svg>';
}

function iconDownload() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><polyline points="9 15 12 18 15 15"></polyline></svg>';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'success', options = {}) {
  const el = document.createElement('div');
  const isError = type === 'error';
  el.className = `toast ${type}`;
  // Errors are announced right away and stay until dismissed.
  el.setAttribute('role', isError ? 'alert' : 'status');

  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  el.appendChild(text);

  if (options.actionLabel && typeof options.onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = options.actionLabel;
    action.addEventListener('click', () => {
      el.remove();
      options.onAction();
    });
    el.appendChild(action);
  }

  const sticky = isError || options.sticky;
  if (sticky || options.actionLabel) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);
  }

  els.toastContainer.appendChild(el);
  while (els.toastContainer.children.length > 4) {
    els.toastContainer.firstElementChild.remove();
  }
  if (!sticky) {
    setTimeout(() => el.remove(), options.duration || 3600);
  }
  return el;
}

// In-app confirmation dialog (replaces window.confirm). Resolves true or false.
function confirmDialog({ title, message, detailsHtml = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop confirm-dialog';
    backdrop.setAttribute('role', 'alertdialog');
    backdrop.setAttribute('aria-modal', 'true');
    const titleId = `confirm-title-${Date.now()}`;
    backdrop.setAttribute('aria-labelledby', titleId);
    backdrop.innerHTML = `
      <div class="modal-card confirm-card">
        <div class="modal-header"><h3 id="${titleId}">${escapeHtml(title)}</h3></div>
        <div class="modal-body">
          <p class="confirm-message">${escapeHtml(message)}</p>
          ${detailsHtml}
          <div class="modal-footer">
            <button type="button" class="btn btn-soft" data-confirm="cancel">Cancel</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm="ok">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    const finish = (result) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      } else if (e.key === 'Tab') {
        e.stopPropagation();
        trapFocus(backdrop, e);
      }
    };
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) finish(false);
      const btn = e.target.closest('[data-confirm]');
      if (btn) finish(btn.dataset.confirm === 'ok');
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    // For destructive actions, start on Cancel so Enter doesn't delete by accident.
    backdrop.querySelector(danger ? '[data-confirm="cancel"]' : '[data-confirm="ok"]').focus();
  });
}

function getFocusable(container) {
  return Array.from(
    container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function trapFocus(container, e) {
  const focusable = getFocusable(container);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
    e.preventDefault();
    first.focus();
  }
}

// Remember what had focus when a dialog opened, and put it back when the dialog closes.
const modalReturnFocus = new Map();
function rememberFocusFor(modalEl) {
  if (modalEl && !modalReturnFocus.has(modalEl)) {
    modalReturnFocus.set(modalEl, document.activeElement);
  }
}
function restoreFocusFor(modalEl) {
  const target = modalReturnFocus.get(modalEl);
  modalReturnFocus.delete(modalEl);
  if (target && document.contains(target) && typeof target.focus === 'function') {
    target.focus();
  }
}

async function apiRequest(url, options = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
  } catch {
    throw new Error("Can't reach Portly's engine. It may have stopped. Try restarting Portly.");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error(
      (data && data.error) ||
        `Something went wrong talking to Portly's engine (error ${res.status}). Try again, or export a crash report.`
    );
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Entrance (bright light) and Exit (fade to dark) transitions
function playEntranceTransition() {
  if (!els.transitionOverlay) return;
  requestAnimationFrame(() => {
    setTimeout(() => {
      els.transitionOverlay.classList.remove('entrance-bright');
    }, 60);
  });
}

function triggerExitFade() {
  if (!els.transitionOverlay) return;
  els.transitionOverlay.classList.remove('entrance-bright');
  els.transitionOverlay.classList.add('exit-dark');
}

function triggerReloadWithFadeToDark() {
  triggerExitFade();
  setTimeout(() => {
    window.location.reload();
  }, 430);
}

// Personalized Time-of-Day Greeting & Theme
function getTimeGreetingPrefix() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function computeGreeting(name) {
  const cleanName = (name || '').trim();
  const prefix = getTimeGreetingPrefix();
  return cleanName ? `${prefix}, ${cleanName}` : prefix;
}

function renderGreetingAndProfile() {
  const name = (state.settings.userName || '').trim();
  els.greetingTitle.textContent = computeGreeting(name);
  if (els.sidebarUserBadge) {
    els.sidebarUserBadge.textContent = name || 'Guest';
  }
  if (els.topbarUserName) {
    els.topbarUserName.textContent = name || 'Guest';
  }
}

function updateOnboardingGreetingPreview() {
  if (!els.onboardingGreetingPreview) return;
  const typed = (els.onboardingNameInput?.value || '').trim();
  if (typed) {
    els.onboardingGreetingPreview.textContent = `Live preview: "${computeGreeting(typed)}"`;
  } else {
    els.onboardingGreetingPreview.textContent = `${getTimeGreetingPrefix()}! Enter your name above to personalize your studio.`;
  }
}

function syncOnboardingThemeButtons(choice) {
  pendingOnboardingTheme = choice === 'dark' ? 'dark' : 'light';
  for (const btn of els.onboardingThemeBtns) {
    btn.classList.toggle('active', btn.dataset.onboardingTheme === pendingOnboardingTheme);
  }
  applyTheme(pendingOnboardingTheme);
}

function showOnboardingScreen() {
  if (!els.onboardingScreen) return;
  els.onboardingNameInput.value = state.settings.userName || '';
  if (els.onboardingDefaultExpanded) {
    els.onboardingDefaultExpanded.checked = Boolean(state.settings.defaultExpanded);
  }
  syncOnboardingThemeButtons(state.settings.theme || 'light');
  updateOnboardingGreetingPreview();
  els.onboardingScreen.classList.remove('hidden');
  setTimeout(() => {
    els.onboardingNameInput?.focus();
  }, 60);
}

function hideOnboardingScreen() {
  if (!els.onboardingScreen) return;
  els.onboardingScreen.classList.add('hidden');
}

function applyTheme(theme) {
  const normalized = resolveTheme(theme);
  document.documentElement.setAttribute('data-theme', normalized);
  try {
    localStorage.setItem('devdeck-theme', normalized);
  } catch {
    // Ignore storage restriction
  }

  const isDark = normalized === 'dark';
  const iconHtml = isDark ? iconSun() : iconMoon();
  if (els.sidebarThemeIcon) {
    els.sidebarThemeIcon.innerHTML = iconHtml;
  }
  if (els.topbarThemeIcon) {
    els.topbarThemeIcon.innerHTML = iconHtml;
  }
  if (els.sidebarThemeQuickIcon) {
    els.sidebarThemeQuickIcon.innerHTML = iconHtml;
  }
  if (els.sidebarThemeLabel) {
    els.sidebarThemeLabel.textContent = isDark ? 'Light Mode' : 'Dark Mode';
  }
  if (els.sidebarThemePill) {
    els.sidebarThemePill.textContent = isDark ? 'Dark' : 'Light';
  }
  if (els.btnTopbarTheme) {
    els.btnTopbarTheme.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
  }
  if (els.btnSidebarThemeQuick) {
    els.btnSidebarThemeQuick.title = isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode';
  }

  const logoPath = isDark ? '/portly-logo.png' : '/portly-logo-white.png';
  for (const img of document.querySelectorAll('.brand-logo-img')) {
    if (img.getAttribute('src') !== logoPath) {
      img.setAttribute('src', logoPath);
    }
  }
  const favicon = document.querySelector('link[rel="icon"]');
  if (favicon && favicon.getAttribute('href') !== logoPath) {
    favicon.setAttribute('href', logoPath);
  }
}

function applySettings(nextSettings) {
  const userName =
    nextSettings && typeof nextSettings.userName === 'string'
      ? nextSettings.userName.trim()
      : '';
  const theme = normalizeThemeChoice(nextSettings && nextSettings.theme);
  const defaultExpanded = Boolean(nextSettings && nextSettings.defaultExpanded);
  const allowMultipleInstances = Boolean(nextSettings && nextSettings.allowMultipleInstances);
  const exitClosesCompletely = Boolean(nextSettings && nextSettings.exitClosesCompletely);
  const onboarded = Boolean(nextSettings && nextSettings.onboarded && userName);

  state.settings = {
    userName,
    theme,
    defaultExpanded,
    allowMultipleInstances,
    exitClosesCompletely,
    onboarded
  };
  applyTheme(state.settings.theme);
  renderGreetingAndProfile();

  if (els.inputAllowMultipleInstances) {
    els.inputAllowMultipleInstances.checked = allowMultipleInstances;
  }
  if (els.inputExitClosesCompletely) {
    els.inputExitClosesCompletely.checked = exitClosesCompletely;
  }
  if (els.btnWinClose) {
    const closeLabel = exitClosesCompletely
      ? 'Close and quit Portly'
      : 'Close window (servers keep running in the system tray)';
    els.btnWinClose.title = closeLabel;
    els.btnWinClose.setAttribute('aria-label', closeLabel);
  }

  if (onboarded) {
    hideOnboardingScreen();
  } else {
    showOnboardingScreen();
  }
}

async function toggleThemeQuick() {
  const nextTheme = resolveTheme(state.settings.theme) === 'dark' ? 'light' : 'dark';
  applySettings({ ...state.settings, theme: nextTheme });
  try {
    const saved = await apiRequest('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ theme: nextTheme })
    });
    applySettings(saved);
    showToast(`Switched to ${nextTheme === 'dark' ? 'Dark' : 'Light'} Mode`);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadSettings() {
  try {
    const saved = await apiRequest('/api/settings');
    applySettings(saved);
  } catch {
    applySettings(state.settings);
  }
}

function applySystemInfo(sys) {
  if (!sys || typeof sys !== 'object') return;
  state.system = { ...state.system, ...sys };
  if (sys.osFamily) {
    document.documentElement.dataset.os = sys.osFamily;
  }

  if (els.sidebarKbdHint) {
    els.sidebarKbdHint.textContent = sys.shortcutModifier === '⌘' ? '⌘K' : 'Ctrl K';
  }
  if (els.inputPath && sys.pathPlaceholder) {
    els.inputPath.placeholder = sys.pathPlaceholder;
  }
  if (els.inputBulkPaths) {
    els.inputBulkPaths.placeholder =
      sys.osFamily === 'windows'
        ? 'C:\\Users\\you\\projects\\site-a\nC:\\Users\\you\\projects\\site-b'
        : '~/projects/site-a\n~/projects/site-b';
  }
  if (els.settingsOsBadge) {
    els.settingsOsBadge.textContent = sys.osName || 'Multi-OS';
  }
  if (els.settingsOsVersion) {
    const versionText = sys.osVersion || `${sys.osName || 'OS'} ${sys.release || ''}`.trim();
    els.settingsOsVersion.textContent = `OS Version: ${versionText}${sys.arch ? ` (${sys.arch})` : ''}`;
  }
  if (els.settingsOsSummary) {
    const parts = [
      sys.release ? `Build/Release: ${sys.release}` : '',
      sys.shellName ? `Shell: ${sys.shellName}` : '',
      sys.fileManagerLabel ? `Files: ${sys.fileManagerLabel}` : ''
    ].filter(Boolean);
    els.settingsOsSummary.textContent = parts.join(' • ') || 'Cross-platform ready';
  }
}

async function loadSystemInfo() {
  try {
    const sys = await apiRequest('/api/system');
    applySystemInfo(sys);
  } catch {
    // Keep default system metadata fallback
  }
}

function formatUptime(startedAt) {
  if (!startedAt) return '00:00:00';
  const totalSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const hrs = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const mins = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const secs = String(totalSec % 60).padStart(2, '0');
  return `${hrs}:${mins}:${secs}`;
}

function formatLogTime(iso) {
  if (!iso) return '--:--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString([], { hour12: false });
}

function getAppInitial(name) {
  const clean = String(name || 'A').trim();
  return (clean[0] || 'A').toUpperCase();
}

function updateExpandAllButtonLabel() {
  if (!els.btnToggleExpandAll) return;
  const allExpanded =
    state.projects.length > 0 && state.projects.every((p) => state.expandedCards.has(p.id));
  els.btnToggleExpandAll.textContent = allExpanded ? 'Collapse All' : 'Expand All';
}

function updateSummaryStats() {
  const total = state.projects.length;
  const running = state.projects.filter((p) => p.status === 'running').length;
  const stopped = state.projects.filter((p) => p.status === 'stopped').length;
  const crashed = state.projects.filter((p) => p.status === 'crashed').length;

  els.statTotal.textContent = String(total);
  els.statRunning.textContent = String(running);
  els.statStopped.textContent = String(stopped);
  els.statCrashed.textContent = String(crashed);

  els.navCountAll.textContent = String(total);
  els.navCountRunning.textContent = String(running);
  els.navCountStopped.textContent = String(stopped);
  els.navCountCrashed.textContent = String(crashed);

  if (running > 0) {
    els.kpiRunningPill.textContent = `${running} Live Now`;
    els.kpiRunningPill.className = 'kpi-pill pill-green';
  } else {
    els.kpiRunningPill.textContent = 'Idle';
    els.kpiRunningPill.className = 'kpi-pill pill-slate';
  }

  if (crashed > 0) {
    els.kpiCrashedPill.className = 'kpi-pill pill-rose';
  } else {
    els.kpiCrashedPill.className = 'kpi-pill pill-slate';
  }

  els.btnStopAll.disabled = running === 0;
  // The "don't see your project?" banner and the intro line only help before the first project.
  const banner = document.querySelector('.studio-callout-banner');
  if (banner) banner.classList.toggle('hidden', total > 0);
  const subtitle = document.getElementById('greeting-subtitle');
  if (subtitle) subtitle.classList.toggle('hidden', total > 0);
  if (els.overviewCollapsedSummary) {
    els.overviewCollapsedSummary.textContent = `${total} project${total === 1 ? '' : 's'} · ${running} running · ${stopped} stopped${crashed > 0 ? ` · ${crashed} crashed` : ''}`;
  }
  if (els.titlebarTrayBadge) {
    els.titlebarTrayBadge.textContent = running > 0 ? `${running} running in background` : 'Background ready';
    els.titlebarTrayBadge.classList.toggle('is-active', running > 0);
  }
  if (els.projectsPaneCount) {
    els.projectsPaneCount.textContent = String(total);
  }
  updateExpandAllButtonLabel();
}

function renderSidebarProjects() {
  if (state.projects.length === 0) {
    els.sidebarProjectsList.innerHTML = '<div class="sidebar-empty">No projects yet</div>';
    return;
  }

  els.sidebarProjectsList.innerHTML = state.projects
    .map((p) => {
      const active = p.id === state.selectedLogProjectId ? 'active' : '';
      return `
        <button class="sidebar-project-link ${active}" type="button" data-sidebar-project-id="${escapeHtml(p.id)}">
          <span class="sidebar-project-name">
            <span class="status-dot ${escapeHtml(getProjectPhase(p))}" role="img" aria-label="${escapeHtml(getProjectPhase(p))}"></span>
            <span>${escapeHtml(p.name)}</span>
          </span>
          <span class="sidebar-project-fw">${escapeHtml((p.stackId && state.stacks.find((s) => s.id === p.stackId)?.name) || p.framework || 'Node')}</span>
        </button>
      `;
    })
    .join('');
}

function getFilteredProjects() {
  const q = state.search.trim().toLowerCase();
  return state.projects.filter((p) => {
    if (state.filter !== 'all' && p.status !== state.filter) {
      return false;
    }
    if (!q) return true;
    const haystack = [
      p.name,
      p.path,
      p.framework,
      p.language,
      p.programType,
      p.command,
      p.customPort,
      p.detectedUrl,
      p.hostname,
      p.stackId && state.stacks.find((s) => s.id === p.stackId)?.name
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

function buildCommandOptions(project) {
  const scripts =
    project.scripts && typeof project.scripts === 'object' ? Object.keys(project.scripts) : [];
  const options = new Set();
  if (project.recommendedCommand) {
    options.add(project.recommendedCommand);
  }
  if (project.command) {
    options.add(project.command);
  }
  for (const name of scripts) {
    options.add(name === 'start' ? 'npm start' : `npm run ${name}`);
  }
  if (options.size === 0) {
    options.add('npm run dev');
  }
  return Array.from(options);
}

function renderCommandControl(project) {
  const commandOptions = buildCommandOptions(project);
  if (commandOptions.length > 1) {
    return `<select class="command-select" data-action="change-command" data-id="${escapeHtml(project.id)}" title="Switch start command">
      ${commandOptions
        .map(
          (cmd) =>
            `<option value="${escapeHtml(cmd)}" ${cmd === project.command ? 'selected' : ''}>${escapeHtml(cmd)}</option>`
        )
        .join('')}
    </select>`;
  }
  return `<span class="command-code">${escapeHtml(project.command || 'npm run dev')}</span>`;
}

function renderCrashReason(p) {
  if (p.status !== 'crashed') return '';
  const reason = p.crashReason || (p.exitCode !== null && p.exitCode !== undefined ? `Exited (code ${p.exitCode})` : 'Stopped unexpectedly');
  return `<div class="crash-reason" title="${escapeHtml(reason)}">${escapeHtml(reason)}</div>`;
}

function renderCardsHtml(list) {
  return list
    .map((p) => {
      const isRunning = p.status === 'running';
      const phase = getProjectPhase(p);
      const isSelected = p.id === state.selectedLogProjectId;
      const isExpanded = state.expandedCards.has(p.id);
      const activePort = p.assignedPort || p.customPort || p.defaultPort;
      const techTags = Array.isArray(p.techStack) ? p.techStack : [];

      const runtimeHtml = isRunning
        ? `<div class="runtime-badges">
            ${p.pid ? `<span class="runtime-chip live">PID ${escapeHtml(p.pid)}</span>` : ''}
            <span class="runtime-chip live" data-uptime-id="${escapeHtml(p.id)}">${formatUptime(p.startedAt)}</span>
            ${activePort ? `<span class="runtime-chip live">:${escapeHtml(activePort)}</span>` : ''}
          </div>`
        : `<div class="runtime-badges">
            ${activePort ? `<span class="runtime-chip">Port ${escapeHtml(activePort)}</span>` : ''}
            ${
              p.status === 'crashed' && p.exitCode !== null
                ? `<span class="runtime-chip">Exit ${escapeHtml(p.exitCode)}</span>`
                : ''
            }
          </div>`;

      // One power control (the switch). The row only adds what the current state needs:
      // an Open link when the server answers, progress while starting, and the reason after a crash.
      let compactControlsHtml = '';
      if (phase === 'running') {
        compactControlsHtml = `<a class="btn btn-sm btn-success open-link" href="${escapeHtml(projectOpenUrl(p))}" target="_blank" rel="noopener noreferrer" title="Open in your browser">${iconExternal()}<span>${escapeHtml(projectOpenUrl(p).replace(/^https?:\/\//, ''))}</span></a>`;
      } else if (phase === 'starting') {
        compactControlsHtml = `<span class="booting-pill" data-starting-id="${escapeHtml(p.id)}">${escapeHtml(getStartingText(p))}</span>`;
      } else if (phase === 'crashed') {
        compactControlsHtml = `<button class="btn btn-sm btn-soft" type="button" data-action="start" data-id="${escapeHtml(p.id)}">${iconRestart()}<span>Start again</span></button>
          <button class="btn btn-sm btn-ghost" type="button" data-action="logs" data-id="${escapeHtml(p.id)}">${iconTerminal()}<span>View logs</span></button>`;
      }
      if (p.portConflict && isRunning) {
        compactControlsHtml += `<span class="port-warning" title="Another program was already using this port when the project started.">Port ${escapeHtml(activePort)} was in use</span>`;
      }

      const stackHtml = techTags.length
        ? `<div class="stack-chips">${techTags
            .map((t) => `<span class="stack-chip">${escapeHtml(t)}</span>`)
            .join('')}</div>`
        : '';

      const deployNoteHtml = p.deployNote
        ? `<div class="deploy-note">${iconSpark()}<span>${escapeHtml(p.deployNote)}</span></div>`
        : '';

      const secondaryStartControls = isRunning
        ? `<button class="btn btn-sm btn-soft" type="button" data-action="restart" data-id="${escapeHtml(p.id)}">${iconRestart()}<span>Restart</span></button>`
        : '';

      const connStatusText =
        phase === 'running' ? 'Running' : phase === 'starting' ? 'Starting…' : phase === 'crashed' ? 'Crashed' : 'Stopped';
      const modKey = state.system.shortcutModifier === '⌘' ? '⌘' : 'Ctrl';

      return `
        <article class="project-card status-${escapeHtml(p.status)} phase-${escapeHtml(phase)} ${isSelected ? 'selected-for-logs' : ''} ${isExpanded ? 'expanded' : ''}" data-project-id="${escapeHtml(p.id)}">
          <div class="card-compact-bar">
            <div class="card-title-group" data-action="logs" data-id="${escapeHtml(p.id)}" title="Show this project's logs">
              <div class="app-avatar ${escapeHtml(p.status)}">${escapeHtml(getAppInitial(p.name))}</div>
              <div class="card-name-block">
                <div class="card-name-row">
                  <h3 class="project-name">${escapeHtml(p.name)}</h3>
                </div>
                <div class="card-made-with">${escapeHtml(p.programType || p.framework || 'Web app')}${activePort ? ` &middot; <span class="card-port">:${escapeHtml(activePort)}</span>` : ''}</div>
              </div>
            </div>

            <div class="card-badges-right">
              ${p.language ? `<span class="language-badge">${escapeHtml(p.language)}</span>` : ''}
              <span class="framework-badge">${escapeHtml(p.framework || 'Node.js')}</span>
            </div>
          </div>

          ${renderCrashReason(p)}

          <div class="card-footer-row">
            <div class="card-footer-left">
              <button
                class="btn btn-xs btn-soft btn-configure"
                type="button"
                data-action="toggle-expand"
                data-id="${escapeHtml(p.id)}"
                aria-expanded="${isExpanded ? 'true' : 'false'}"
                title="${isExpanded ? 'Hide details' : 'Show details, command and more actions'}"
              >
                <span>${isExpanded ? 'Hide details' : 'Details'}</span>
                <span class="configure-chevron">${iconChevron()}</span>
              </button>
              ${compactControlsHtml}
            </div>

            <div class="conn-status-group">
              <span class="conn-status-label ${escapeHtml(phase)}">${connStatusText}</span>
              <button
                class="ios-switch ${isRunning ? 'on' : ''}"
                type="button"
                role="switch"
                aria-checked="${isRunning ? 'true' : 'false'}"
                aria-label="${isRunning ? 'Stop' : 'Start'} ${escapeHtml(p.name)}"
                data-action="toggle"
                data-id="${escapeHtml(p.id)}"
                title="${isRunning ? 'Stop server' : `Start server (${modKey}-click to start and open in browser)`}"
              ></button>
            </div>
          </div>

          <div class="card-details">
            ${stackHtml}

            <div class="card-path-row">
              <span class="card-path" title="${escapeHtml(p.path)}">${escapeHtml(p.path)}</span>
              <button class="icon-btn" type="button" data-action="copy-path" data-id="${escapeHtml(p.id)}" title="Copy path" aria-label="Copy path">${iconCopy()}</button>
              <button class="icon-btn" type="button" data-action="open-folder" data-id="${escapeHtml(p.id)}" title="Open in ${escapeHtml(state.system.fileManagerLabel || 'File Manager')}" aria-label="Open folder">${iconFolder()}</button>
            </div>

            ${deployNoteHtml}

            <div class="card-meta-row">
              <div class="command-chip-wrap">
                <span class="command-label">CMD</span>
                ${renderCommandControl(p)}
              </div>
              ${runtimeHtml}
            </div>

            <div class="card-actions">
              <div class="card-actions-left">
                ${secondaryStartControls}
                ${isRunning ? '' : `<button class="btn btn-sm btn-ghost" type="button" data-action="start-open" data-id="${escapeHtml(p.id)}">${iconExternal()}<span>Start and open</span></button>`}
                <button class="btn btn-sm btn-ghost" type="button" data-action="logs" data-id="${escapeHtml(p.id)}">${iconTerminal()}<span>View logs</span></button>
                <button class="btn btn-sm btn-ghost" type="button" data-action="export-crash" data-id="${escapeHtml(p.id)}" title="Save a crash report with this project's logs">${iconDownload()}<span>Crash report</span></button>
              </div>
              <div class="card-actions-right">
                <button class="icon-btn" type="button" data-action="reanalyze" data-id="${escapeHtml(p.id)}" title="Re-detect stack and start command" aria-label="Re-detect stack">${iconSpark()}</button>
                <button class="icon-btn" type="button" data-action="edit" data-id="${escapeHtml(p.id)}" title="Edit project" aria-label="Edit project">${iconSettings()}</button>
                <button class="icon-btn danger" type="button" data-action="delete" data-id="${escapeHtml(p.id)}" title="Remove project" aria-label="Remove project">${iconTrash()}</button>
              </div>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

function renderTableRowHtml(p) {
      const isRunning = p.status === 'running';
      const phase = getProjectPhase(p);
      const isSelected = p.id === state.selectedLogProjectId;
      const activePort = p.assignedPort || p.customPort || p.defaultPort;
      const openAppLink =
        isRunning && p.detectedUrl
          ? `<a class="btn btn-xs btn-success" href="${escapeHtml(projectOpenUrl(p))}" target="_blank" rel="noopener noreferrer">${iconExternal()}<span>Open ${escapeHtml(projectOpenUrl(p).replace(/^https?:\/\//, ''))}</span></a>`
          : isRunning
            ? `<span class="booting-pill" data-starting-id="${escapeHtml(p.id)}">${escapeHtml(getStartingText(p))}</span>`
            : p.status === 'crashed'
              ? `<span class="crash-reason crash-reason-inline" title="${escapeHtml(p.crashReason || '')}">${escapeHtml(p.crashReason || 'Crashed')}</span>`
              : '';

      return `
        <tr class="${isSelected ? 'selected-for-logs' : ''}" data-project-id="${escapeHtml(p.id)}">
          <td>
            <button
              class="ios-switch ${isRunning ? 'on' : ''}"
              type="button"
              role="switch"
              aria-checked="${isRunning ? 'true' : 'false'}"
              aria-label="${isRunning ? 'Stop' : 'Start'} ${escapeHtml(p.name)}"
              data-action="toggle"
              data-id="${escapeHtml(p.id)}"
            ></button>
          </td>
          <td>
            <div style="display:flex;align-items:center;gap:9px;">
              <div class="app-avatar ${escapeHtml(p.status)}" style="width:30px;height:30px;border-radius:9px;font-size:12px;">${escapeHtml(getAppInitial(p.name))}</div>
              <div>
                <div style="font-weight:700;color:var(--text-primary);">${escapeHtml(p.name)} ${tableStackChipHtml(p)}</div>
                <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin-top:2px;">
                  ${p.language ? `<span class="language-badge">${escapeHtml(p.language)}</span>` : ''}
                  <span class="framework-badge">${escapeHtml(p.framework || 'Node.js')}</span>
                </div>
              </div>
            </div>
          </td>
          <td>
            <div class="table-path-cell" title="${escapeHtml(p.path)}">${escapeHtml(p.path)}</div>
          </td>
          <td>
            <div class="command-chip-wrap">${renderCommandControl(p)}</div>
          </td>
          <td>
            <span class="status-pill ${escapeHtml(phase)}">
              <span class="status-dot ${escapeHtml(phase)}"></span>
              <span>${escapeHtml(phase === 'starting' ? 'starting' : p.status)}</span>
            </span>
          </td>
          <td>${openAppLink}</td>
          <td>
            <div style="display:flex;align-items:center;gap:4px;">
              ${
                isRunning
                  ? `<button class="btn btn-xs btn-soft" type="button" data-action="restart" data-id="${escapeHtml(p.id)}" title="Restart">${iconRestart()}</button>`
                  : ''
              }
              <button class="icon-btn" type="button" data-action="reanalyze" data-id="${escapeHtml(p.id)}" title="Auto-detect stack">${iconSpark()}</button>
              <button class="btn btn-xs btn-soft" type="button" data-action="logs" data-id="${escapeHtml(p.id)}">${iconTerminal()}<span>Logs</span></button>
              <button class="icon-btn" type="button" data-action="open-folder" data-id="${escapeHtml(p.id)}" title="Open in ${escapeHtml(state.system.fileManagerLabel || 'File Manager')}">${iconFolder()}</button>
              <button class="icon-btn" type="button" data-action="edit" data-id="${escapeHtml(p.id)}" title="Edit">${iconSettings()}</button>
              <button class="icon-btn danger" type="button" data-action="delete" data-id="${escapeHtml(p.id)}" title="Remove">${iconTrash()}</button>
            </div>
          </td>
        </tr>
      `;
}

function renderTableHtml(list) {
  const rows = list.map(renderTableRowHtml).join('');

  return `
    <div class="projects-table-card">
      <table class="projects-table">
        <thead>
          <tr>
            <th><span class="visually-hidden">On or off</span></th>
            <th>Project &amp; Stack</th>
            <th>Folder Path</th>
            <th>Command</th>
            <th>Status</th>
            <th>Open</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderProjects() {
  updateSummaryStats();
  renderSidebarProjects();
  const list = getFilteredProjects();

  if (state.projects.length === 0) {
    els.projectsGrid.innerHTML = `
      <div class="empty-state">
        <h3>Add your first project</h3>
        <p>Point Portly at a project folder. It detects the stack, start command and port for you.</p>
        <div class="empty-state-actions">
          <button class="btn btn-primary" type="button" data-empty-action="add">Add project</button>
          <button class="btn btn-soft" type="button" data-empty-action="stack">Add a stack (frontend + API + worker)</button>
          <button class="btn btn-soft" type="button" data-empty-action="scan">Scan a folder of projects</button>
          <button class="btn btn-soft" type="button" data-empty-action="bulk">Import list of folders</button>
        </div>
      </div>
    `;
    return;
  }

  if (list.length === 0) {
    els.projectsGrid.innerHTML = `
      <div class="empty-state">
        <h3>No matching projects</h3>
        <p>Try clearing your search query or switching the status filter.</p>
      </div>
    `;
    return;
  }

  if (state.viewMode === 'table') {
    els.projectsGrid.innerHTML = renderTableHtml(list);
  } else {
    els.projectsGrid.innerHTML = renderWorkspaceCardsHtml(list);
  }
}

function renderLogsHeader() {
  const project = state.projects.find((p) => p.id === state.selectedLogProjectId);
  if (!project) {
    els.logsProjectTitle.textContent = 'Logs';
    els.logsStatusPill.classList.add('hidden');
    els.logsOpenApp.classList.add('hidden');
    els.logsFilePath.textContent = 'No log file selected';
    return;
  }

  els.logsProjectTitle.textContent = project.name;
  const phase = getProjectPhase(project);
  els.logsStatusPill.innerHTML = `<span class="status-dot ${escapeHtml(phase)}"></span><span>${escapeHtml(phase.toUpperCase())}</span>`;
  els.logsStatusPill.className = `status-pill ${phase}`;
  els.logsFilePath.textContent = state.logFilePath || `logs/${project.id}.log`;

  if (project.status === 'running' && project.detectedUrl) {
    els.logsOpenApp.href = projectOpenUrl(project);
    els.logsOpenApp.innerHTML = `${iconExternal()}<span>Open ${escapeHtml(projectOpenUrl(project).replace(/^https?:\/\//, ''))}</span>`;
    els.logsOpenApp.classList.remove('hidden');
  } else {
    els.logsOpenApp.classList.add('hidden');
  }
}

const LOG_ERROR_REGEX = /\b(error|err!|exception|traceback|panic|fatal|failed|cannot find|not found)\b/i;
const LOG_WARN_REGEX = /\b(warn|warning|deprecated)\b/i;
const MAX_LOG_LINES_ON_SCREEN = 500;
let pendingLogEntries = [];
let logFlushScheduled = false;

function logEntryMatchesFilters(entry) {
  if (state.logStreamFilter !== 'all' && entry.stream !== state.logStreamFilter) {
    return false;
  }
  const search = state.logSearch.trim().toLowerCase();
  if (search && !String(entry.text || '').toLowerCase().includes(search)) {
    return false;
  }
  return true;
}

// Many tools (npm, Vite, webpack, Python logging) print normal progress to stderr, so colour
// a line by what it says rather than by which stream it came from.
function classifyLogEntry(entry) {
  if (entry.stream === 'system') return 'tone-system';
  const text = String(entry.text || '');
  if (LOG_ERROR_REGEX.test(text)) return 'tone-error';
  if (LOG_WARN_REGEX.test(text)) return 'tone-warn';
  return 'tone-normal';
}

function logLineHtml(entry) {
  const stream = escapeHtml(entry.stream);
  return `<div class="log-line ${classifyLogEntry(entry)}">
        <span class="log-time">${escapeHtml(formatLogTime(entry.timestamp))}</span>
        <span class="log-stream ${stream}" title="${stream}"><span class="visually-hidden">${stream}</span></span>
        <span class="log-text ${stream}">${escapeHtml(entry.text)}</span>
      </div>`;
}

function renderLogs() {
  renderLogsHeader();
  pendingLogEntries = [];
  if (!state.selectedLogProjectId) {
    els.logsOutput.innerHTML = '<div class="logs-empty">Select a project to see its output.</div>';
    return;
  }

  const filtered = state.logs.filter(logEntryMatchesFilters);

  if (filtered.length === 0) {
    els.logsOutput.innerHTML =
      '<div class="logs-empty">No output yet for this filter. Start the project to stream its output here.</div>';
    return;
  }

  els.logsOutput.innerHTML = filtered.slice(-MAX_LOG_LINES_ON_SCREEN).map(logLineHtml).join('');

  if (state.autoScroll) {
    els.logsOutput.scrollTop = els.logsOutput.scrollHeight;
  }
}

/** Appends new log lines without rebuilding the whole console (batched per animation frame). */
function flushPendingLogs() {
  logFlushScheduled = false;
  if (document.hidden) {
    state.needsFullRender = true;
    pendingLogEntries = [];
    return;
  }
  const entries = pendingLogEntries.filter(logEntryMatchesFilters);
  pendingLogEntries = [];
  if (entries.length === 0) return;

  if (els.logsOutput.querySelector('.logs-empty')) {
    renderLogs();
    return;
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = entries.slice(-MAX_LOG_LINES_ON_SCREEN).map(logLineHtml).join('');
  els.logsOutput.appendChild(tpl.content);
  let extra = els.logsOutput.childElementCount - MAX_LOG_LINES_ON_SCREEN;
  while (extra > 0 && els.logsOutput.firstElementChild) {
    els.logsOutput.firstElementChild.remove();
    extra -= 1;
  }
  if (state.autoScroll) {
    els.logsOutput.scrollTop = els.logsOutput.scrollHeight;
  }
}

function receiveLogEntries(projectId, entries) {
  if (projectId !== state.selectedLogProjectId || !Array.isArray(entries) || entries.length === 0) {
    return;
  }
  state.logs.push(...entries);
  if (state.logs.length > MAX_LOG_LINES_ON_SCREEN) {
    state.logs.splice(0, state.logs.length - MAX_LOG_LINES_ON_SCREEN);
  }
  pendingLogEntries.push(...entries);
  if (!logFlushScheduled) {
    logFlushScheduled = true;
    requestAnimationFrame(flushPendingLogs);
  }
}

function updateSelectionHighlight() {
  for (const el of els.projectsGrid.querySelectorAll('[data-project-id]')) {
    el.classList.toggle('selected-for-logs', el.dataset.projectId === state.selectedLogProjectId);
  }
  for (const el of els.sidebarProjectsList.querySelectorAll('[data-sidebar-project-id]')) {
    el.classList.toggle('active', el.dataset.sidebarProjectId === state.selectedLogProjectId);
  }
}

async function selectLogProject(id) {
  state.selectedLogProjectId = id;
  updateSelectionHighlight();
  renderLogsHeader();
  try {
    const data = await apiRequest(`/api/projects/${encodeURIComponent(id)}/logs`);
    state.logs = Array.isArray(data.logs) ? data.logs : [];
    state.logFilePath = data.logFilePath || '';
    renderLogs();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadProjects() {
  try {
    const [list] = await Promise.all([apiRequest('/api/projects'), loadStacks()]);
    state.projects = Array.isArray(list) ? list : [];

    if (state.settings.defaultExpanded) {
      for (const p of state.projects) {
        state.expandedCards.add(p.id);
      }
    }

    renderProjects();

    if (!state.selectedLogProjectId && state.projects.length > 0) {
      await selectLogProject(state.projects[0].id);
    } else if (state.selectedLogProjectId) {
      renderLogsHeader();
    }
  } catch (err) {
    showToast(`Failed to load projects: ${err.message}`, 'error');
  }
}

function fulfillPendingOpenTab(project) {
  if (!pendingOpenTabs.has(project.id)) return;
  const pending = pendingOpenTabs.get(project.id);

  if (project.status === 'running' && project.detectedUrl) {
    clearTimeout(pending.timer);
    pendingOpenTabs.delete(project.id);
    if (pending.win && !pending.win.closed) {
      pending.win.opener = null;
      pending.win.location.href = projectOpenUrl(project);
    } else {
      window.open(projectOpenUrl(project), '_blank', 'noopener,noreferrer');
    }
    showToast(`Opened ${project.name} at ${projectOpenUrl(project)}`);
  } else if (project.status === 'crashed' || project.status === 'stopped') {
    clearTimeout(pending.timer);
    pendingOpenTabs.delete(project.id);
    if (pending.win && !pending.win.closed) {
      pending.win.close();
    }
  }
}

/**
 * Replaces just one project's card (or table row) and sidebar entry instead of rebuilding
 * the whole grid. Returns false when a full render is needed (for example the project
 * now enters or leaves the current filter).
 */
function patchProjectDom(updated) {
  // Services are drawn inside their stack's card; the stack-status event redraws it.
  if (updated.stackId && state.viewMode !== 'table') return false;
  const inList = getFilteredProjects().some((p) => p.id === updated.id);
  const el = els.projectsGrid.querySelector(`[data-project-id="${CSS.escape(updated.id)}"]`);
  if (!inList) return !el;
  if (!el) return false;

  const isTable = state.viewMode === 'table';
  const container = document.createElement(isTable ? 'tbody' : 'div');
  container.innerHTML = (isTable ? renderTableRowHtml(updated) : renderCardsHtml([updated])).trim();
  const fresh = container.firstElementChild;
  if (!fresh) return false;
  fresh.classList.add('no-anim');

  // Keep keyboard focus on the same control if it was inside this card.
  const focused = el.contains(document.activeElement) ? document.activeElement : null;
  const focusedAction = focused && focused.dataset ? focused.dataset.action : null;
  el.replaceWith(fresh);
  if (focusedAction) {
    const again = fresh.querySelector(`[data-action="${focusedAction}"]`);
    if (again) again.focus();
  }

  const row = els.sidebarProjectsList.querySelector(
    `[data-sidebar-project-id="${CSS.escape(updated.id)}"]`
  );
  if (row) {
    const dot = row.querySelector('.status-dot');
    if (dot) {
      const phase = getProjectPhase(updated);
      dot.className = `status-dot ${phase}`;
      dot.setAttribute('aria-label', phase);
    }
  } else {
    renderSidebarProjects();
  }
  updateSummaryStats();
  return true;
}

function upsertProjectState(updated) {
  const idx = state.projects.findIndex((p) => p.id === updated.id);
  const previous = idx >= 0 ? state.projects[idx] : null;
  if (idx >= 0) {
    state.projects[idx] = updated;
  } else {
    state.projects.push(updated);
    if (state.settings.defaultExpanded) {
      state.expandedCards.add(updated.id);
    }
  }
  fulfillPendingOpenTab(updated);

  if (previous && previous.status !== 'crashed' && updated.status === 'crashed' && !document.hidden) {
    showToast(`${updated.name} crashed. ${updated.crashReason || ''}`.trim(), 'error', {
      actionLabel: 'View logs',
      onAction: () => selectLogProject(updated.id)
    });
  }

  if (document.hidden) {
    state.needsFullRender = true;
    return;
  }
  if (!previous || !patchProjectDom(updated)) {
    renderProjects();
  }
  if (updated.id === state.selectedLogProjectId) {
    renderLogsHeader();
  }
}

// While Portly is hidden (tray or minimized), keep state current but skip DOM work.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.needsFullRender) {
    state.needsFullRender = false;
    renderProjects();
    renderLogs();
  }
});

function connectSSE() {
  if (state.sse) {
    state.sse.close();
  }

  const sse = new EventSource('/api/stream');
  state.sse = sse;

  sse.addEventListener('connected', () => {
    if (els.sseBadge && els.sseBadgeText) {
      els.sseBadge.className = 'sse-badge connected';
      els.sseBadgeText.textContent = 'Live';
    }
  });

  sse.addEventListener('project-status', (ev) => {
    try {
      const updated = JSON.parse(ev.data);
      upsertProjectState(updated);
    } catch {
      // Ignore malformed SSE payload
    }
  });

  sse.addEventListener('settings-updated', (ev) => {
    try {
      const updated = JSON.parse(ev.data);
      applySettings(updated);
    } catch {
      // Ignore malformed SSE payload
    }
  });

  sse.addEventListener('config-imported', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      applyImportedEnvironmentResponse(payload);
    } catch {
      // Ignore malformed SSE payload
    }
  });

  sse.addEventListener('instance-activated', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      const msg =
        (payload && payload.message) ||
        'Portly is already open, so we brought it to the front.';
      showToast(msg);
    } catch {
      showToast('Portly is already open, so we brought it to the front.');
    }
  });

  // Log lines arrive in batches (one event per ~75 ms per project).
  sse.addEventListener('project-logs', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      receiveLogEntries(payload.projectId, payload.entries);
    } catch {
      // Ignore malformed SSE log
    }
  });

  // Older Portly engines sent one event per line.
  sse.addEventListener('project-log', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      if (payload.entry) receiveLogEntries(payload.projectId, [payload.entry]);
    } catch {
      // Ignore malformed SSE log
    }
  });

  sse.addEventListener('project-deleted', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      state.projects = state.projects.filter((p) => p.id !== payload.id);
      state.expandedCards.delete(payload.id);
      if (state.selectedLogProjectId === payload.id) {
        state.selectedLogProjectId = state.projects[0]?.id || null;
        if (state.selectedLogProjectId) {
          selectLogProject(state.selectedLogProjectId);
        } else {
          state.logs = [];
          renderLogs();
        }
      }
      renderProjects();
    } catch {
      // Ignore
    }
  });

  stacksUiBindSse(sse);

  sse.onerror = () => {
    if (els.sseBadge && els.sseBadgeText) {
      els.sseBadge.className = 'sse-badge disconnected';
      els.sseBadgeText.textContent = 'Offline';
    }
  };
}

function applyFilter(filterValue) {
  state.filter = filterValue;
  setPressed(els.filterTabs, (t) => t.dataset.filter === filterValue);
  renderProjects();
}

function setSearchValue(val, sourceEl) {
  state.search = val;
  if (sourceEl !== els.projectSearch && els.projectSearch.value !== val) {
    els.projectSearch.value = val;
  }
  if (sourceEl !== els.sidebarSearch && els.sidebarSearch.value !== val) {
    els.sidebarSearch.value = val;
  }
  renderProjects();
}

const LAYOUT_STORAGE_KEY = 'portly-layout-v1';

function loadLayoutPrefs() {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (['expanded', 'compact', 'collapsed'].includes(parsed.overviewMode)) {
      state.layout.overviewMode = parsed.overviewMode;
    }
    if (['top', 'bottom'].includes(parsed.overviewPosition)) {
      state.layout.overviewPosition = parsed.overviewPosition;
    }
    if (Number.isFinite(Number(parsed.overviewScale))) {
      state.layout.overviewScale = Math.round(Math.min(1.22, Math.max(0.65, Number(parsed.overviewScale))) * 100) / 100;
    } else if (Number.isFinite(Number(parsed.overviewHeight))) {
      const migratedScale = Number(parsed.overviewHeight) / 220;
      state.layout.overviewScale = Math.round(Math.min(1.22, Math.max(0.65, migratedScale)) * 100) / 100;
    } else {
      state.layout.overviewScale = 1;
    }
    if (Array.isArray(parsed.overviewBlockOrder) && parsed.overviewBlockOrder.length === 2) {
      state.layout.overviewBlockOrder = parsed.overviewBlockOrder;
    }
    if (Array.isArray(parsed.kpiOrder) && parsed.kpiOrder.length === 3) {
      state.layout.kpiOrder = parsed.kpiOrder;
    }
    if (['horizontal', 'vertical'].includes(parsed.splitDirection)) {
      state.layout.splitDirection = parsed.splitDirection;
    }
    if (Number.isFinite(Number(parsed.splitRatio))) {
      state.layout.splitRatio = Math.min(80, Math.max(20, Number(parsed.splitRatio)));
    }
    if (['split', 'console-collapsed', 'console-full'].includes(parsed.paneFocus)) {
      state.layout.paneFocus = parsed.paneFocus;
    }
  } catch {
    // Ignore invalid stored layout preferences
  }
}

function saveLayoutPrefs() {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state.layout));
  } catch {
    // Ignore storage error
  }
}

function applyOverviewOrder() {
  if (els.overviewContent && Array.isArray(state.layout.overviewBlockOrder)) {
    for (const blockKey of state.layout.overviewBlockOrder) {
      const node = els.overviewContent.querySelector(`[data-overview-block="${CSS.escape(blockKey)}"]`);
      if (node) {
        els.overviewContent.appendChild(node);
      }
    }
  }
  if (els.kpiGrid && Array.isArray(state.layout.kpiOrder)) {
    for (const kpiKey of state.layout.kpiOrder) {
      const card = els.kpiGrid.querySelector(`.kpi-card[data-kpi-id="${CSS.escape(kpiKey)}"]`);
      if (card) {
        els.kpiGrid.appendChild(card);
      }
    }
  }
}

function applyLayoutPrefs() {
  const {
    overviewMode,
    overviewPosition,
    overviewHeight,
    splitDirection,
    splitRatio,
    paneFocus
  } = state.layout;

  if (els.mainCanvas) {
    els.mainCanvas.setAttribute('data-overview-pos', overviewPosition === 'bottom' ? 'bottom' : 'top');
  }
  if (els.btnOverviewPosition) {
    els.btnOverviewPosition.textContent = overviewPosition === 'bottom' ? 'Move Above' : 'Move Below';
    els.btnOverviewPosition.classList.toggle('active', overviewPosition === 'bottom');
  }

  if (els.overviewSection) {
    const scale = Number.isFinite(Number(state.layout.overviewScale))
      ? Math.min(1.22, Math.max(0.65, Number(state.layout.overviewScale)))
      : 1;
    els.overviewSection.setAttribute('data-overview-mode', overviewMode);
    els.overviewSection.style.height = '';
    els.overviewSection.classList.remove('custom-resized');
    els.overviewSection.style.setProperty('--overview-scale', scale.toFixed(3));
    if (scale !== 1) {
      els.overviewSection.classList.add('custom-scaled');
    } else {
      els.overviewSection.classList.remove('custom-scaled');
    }
  }
  for (const btn of els.overviewModeBtns) {
    btn.classList.toggle('active', btn.dataset.overviewMode === overviewMode);
  }
  applyOverviewOrder();

  const effectiveDir = state.viewMode === 'split' ? splitDirection : 'vertical';
  if (els.workspaceGrid) {
    els.workspaceGrid.setAttribute('data-split-dir', effectiveDir);
    els.workspaceGrid.setAttribute('data-pane-focus', paneFocus);
    const ratio = Math.min(80, Math.max(20, Number(splitRatio) || 56));
    els.workspaceGrid.style.setProperty('--projects-pane-fr', `${ratio}fr`);
    els.workspaceGrid.style.setProperty('--logs-pane-fr', `${100 - ratio}fr`);
  }

  if (els.workspaceResizer) {
    els.workspaceResizer.setAttribute(
      'aria-orientation',
      effectiveDir === 'vertical' ? 'horizontal' : 'vertical'
    );
  }

  if (els.btnSplitDirection) {
    els.btnSplitDirection.textContent = effectiveDir === 'vertical' ? 'Stacked' : 'Side-by-Side';
    els.btnSplitDirection.classList.toggle('active', effectiveDir === 'vertical');
  }

  if (els.btnCollapseConsole) {
    const isCollapsed = paneFocus === 'console-collapsed';
    els.btnCollapseConsole.textContent = isCollapsed ? 'Expand Console' : 'Collapse';
    els.btnCollapseConsole.classList.toggle('active', isCollapsed);
  }

  if (els.btnMaximizeConsole) {
    const isConsoleFull = paneFocus === 'console-full';
    els.btnMaximizeConsole.textContent = isConsoleFull ? 'Restore Split' : 'Expand Console';
    els.btnMaximizeConsole.classList.toggle('active', isConsoleFull);
  }
}

function switchViewMode(view) {
  state.viewMode = view;
  els.workspaceGrid.className = `workspace view-${view}`;
  setPressed(els.viewBtns, (btn) => btn.dataset.view === view);
  applyLayoutPrefs();
  renderProjects();
}

// Settings Modal
function syncThemeChoiceButtons(choice) {
  pendingSettingsTheme = normalizeThemeChoice(choice);
  setPressed(els.themeChoiceBtns, (btn) => btn.dataset.themeChoice === pendingSettingsTheme);
  applyTheme(pendingSettingsTheme);
}

if (systemDarkQuery) {
  const onSystemThemeChange = () => {
    if (state.settings.theme === 'system') applyTheme('system');
  };
  if (typeof systemDarkQuery.addEventListener === 'function') {
    systemDarkQuery.addEventListener('change', onSystemThemeChange);
  } else if (typeof systemDarkQuery.addListener === 'function') {
    systemDarkQuery.addListener(onSystemThemeChange);
  }
}

function openSettingsModal() {
  els.inputUserName.value = state.settings.userName || '';
  els.inputDefaultExpanded.checked = Boolean(state.settings.defaultExpanded);
  if (els.inputExitClosesCompletely) {
    els.inputExitClosesCompletely.checked = Boolean(state.settings.exitClosesCompletely);
  }
  if (els.inputAllowMultipleInstances) {
    els.inputAllowMultipleInstances.checked = Boolean(state.settings.allowMultipleInstances);
  }
  syncThemeChoiceButtons(state.settings.theme);
  syncConfigModeButtons(state.configImportMode);
  updateReopenBrokenPathsButton();
  stacksUiOnSettingsOpen();
  rememberFocusFor(els.settingsModal);
  els.settingsModal.classList.remove('hidden');
  els.inputUserName.focus();
}

function closeSettingsModal() {
  els.settingsModal.classList.add('hidden');
  applyTheme(state.settings.theme);
  restoreFocusFor(els.settingsModal);
}

// Lets the macOS app menu (Portly > Settings…, Cmd+,) open Settings.
window.portlyOpenSettings = openSettingsModal;

// Add/Edit Project Modal
function switchModalTab(tabName) {
  for (const tab of els.modalTabs) {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  }
  els.singleForm.classList.toggle('hidden', tabName !== 'single');
  const stackForm = document.getElementById('stack-form');
  if (stackForm) {
    stackForm.classList.toggle('hidden', tabName !== 'stack');
    if (tabName === 'stack' && !stacksUi.suggestion) resetStackForm();
  }
  els.bulkForm.classList.toggle('hidden', tabName !== 'bulk');
}

function resetInspectUI() {
  els.inspectFeedback.textContent = '';
  els.inspectFeedback.className = 'inspect-feedback';
  els.selectDetectedScript.classList.add('hidden');
  els.selectDetectedScript.innerHTML = '';
}

function openAddModal(defaultTab = 'single', scanSubfolders = false) {
  els.editProjectId.value = '';
  els.modalTitle.textContent =
    defaultTab === 'bulk' ? 'Import a list of folders' : 'Add project';
  els.modalTabsWrap.classList.remove('hidden');
  els.btnSubmitSingle.textContent = 'Add Project';
  els.singleForm.reset();
  els.inputCommand.value = 'npm run dev';
  els.singleFormError.classList.add('hidden');
  resetInspectUI();

  els.bulkFormError.classList.add('hidden');
  els.bulkResultBox.classList.add('hidden');
  els.bulkResultBox.innerHTML = '';
  els.inputScanSubfolders.checked = scanSubfolders;
  stacksUiOnOpenAdd();
  if (defaultTab === 'stack') resetStackForm();

  switchModalTab(defaultTab);
  rememberFocusFor(els.modal);
  els.modal.classList.remove('hidden');

  if (defaultTab === 'single') {
    els.inputPath.focus();
  } else if (defaultTab === 'stack') {
    const stackPath = document.getElementById('input-stack-path');
    if (stackPath) stackPath.focus();
  } else {
    els.inputBulkPaths.focus();
  }
}

function openEditModal(project) {
  els.editProjectId.value = project.id;
  els.modalTitle.textContent = `Edit ${project.name}`;
  els.modalTabsWrap.classList.add('hidden');
  els.btnSubmitSingle.textContent = 'Save Changes';
  els.singleFormError.classList.add('hidden');
  resetInspectUI();

  els.inputPath.value = project.path;
  els.inputName.value = project.name;
  els.inputPort.value = project.customPort || '';
  els.inputCommand.value = project.command || 'npm run dev';
  stacksUiOnOpenEdit(project);

  switchModalTab('single');
  rememberFocusFor(els.modal);
  els.modal.classList.remove('hidden');
  els.inputName.focus();
  runInspectPath(project.path, true);
}

function closeModal() {
  els.modal.classList.add('hidden');
  restoreFocusFor(els.modal);
}

async function runInspectPath(rawPath, preserveExistingFields = false) {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    resetInspectUI();
    return;
  }

  try {
    const info = await apiRequest('/api/inspect', {
      method: 'POST',
      body: JSON.stringify({ path: trimmed })
    });

    if (!info.valid) {
      els.inspectFeedback.textContent = info.error || 'Invalid path.';
      els.inspectFeedback.className = 'inspect-feedback err';
      els.selectDetectedScript.classList.add('hidden');
      return;
    }

    const scriptNames = Object.keys(info.scripts || {});
    const parts = [
      info.programType || info.framework,
      info.language,
      info.framework,
      info.defaultPort ? `Port ${info.defaultPort}` : ''
    ].filter(Boolean);
    els.inspectFeedback.textContent = `Detected: ${parts.join(' • ')}${
      info.deployNote ? ` — ${info.deployNote}` : ''
    }`;
    els.inspectFeedback.className = 'inspect-feedback ok';

    if (!preserveExistingFields) {
      if (!els.inputName.value.trim()) {
        els.inputName.value = info.name;
      }
      els.inputCommand.value = info.recommendedCommand || info.suggestedCommand || 'npm run dev';
    }

    const pm = info.packageManager && info.packageManager !== 'npm' ? info.packageManager : 'npm';
    const commandChoices = new Set();
    if (info.recommendedCommand) commandChoices.add(info.recommendedCommand);
    for (const s of scriptNames) {
      commandChoices.add(s === 'start' ? `${pm} start` : `${pm} run ${s}`);
    }

    if (commandChoices.size > 0) {
      const options = Array.from(commandChoices).map(
        (cmd) => `<option value="${escapeHtml(cmd)}">${escapeHtml(cmd)}</option>`
      );
      els.selectDetectedScript.innerHTML = `<option value="">Pick command...</option>${options.join('')}`;
      els.selectDetectedScript.classList.remove('hidden');
    } else {
      els.selectDetectedScript.classList.add('hidden');
    }
  } catch (err) {
    els.inspectFeedback.textContent = err.message;
    els.inspectFeedback.className = 'inspect-feedback err';
  }
}

function parseUploadedTextToPaths(text, filename) {
  const lower = (filename || '').toLowerCase();
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (lower.endsWith('.json') || trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => (typeof item === 'string' ? item : item && item.path))
          .filter(Boolean);
      }
      if (parsed && Array.isArray(parsed.paths)) {
        return parsed.paths.filter(Boolean);
      }
    } catch {
      // Fallback to line splitting
    }
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => {
      const clean = line.trim();
      if (!clean || clean.startsWith('#')) return '';
      if (lower.endsWith('.csv') && clean.includes(',')) {
        const parts = clean.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        return parts.find((cell) => /[\\/]/.test(cell) || cell.includes(':')) || parts[0];
      }
      return clean;
    })
    .filter(Boolean);
}

async function handleFileSelection(file) {
  if (!file) return;
  const text = await file.text();
  const extracted = parseUploadedTextToPaths(text, file.name);
  if (extracted.length === 0) {
    showToast('No paths found in uploaded file.', 'error');
    return;
  }
  const existing = els.inputBulkPaths.value.trim();
  els.inputBulkPaths.value = existing ? `${existing}\n${extracted.join('\n')}` : extracted.join('\n');
  showToast(`Loaded ${extracted.length} path(s) from ${file.name}`);
}

// Event Listeners
els.btnAddProject.addEventListener('click', () => openAddModal('single', false));
els.btnAddProjectTop.addEventListener('click', () => openAddModal('single', false));
els.btnBulkImport.addEventListener('click', () => openAddModal('bulk', false));
els.btnScanFolder.addEventListener('click', () => openAddModal('bulk', true));

if (els.btnSidebarTheme) {
  els.btnSidebarTheme.addEventListener('click', toggleThemeQuick);
}
if (els.btnTopbarTheme) {
  els.btnTopbarTheme.addEventListener('click', toggleThemeQuick);
}

async function exportCrashReport(projectId = null) {
  try {
    const res = await apiRequest('/api/crash-reports/export', {
      method: 'POST',
      body: JSON.stringify(projectId ? { projectId } : {})
    });
    if (res.dialogUsed) {
      if (!res.canceled) {
        showToast(`Crash report saved to ${res.savedPath}`);
      } else {
        showToast(`Saved backup copy to ${res.archivePath}`);
      }
      return;
    }
    if (res && typeof res.content === 'string') {
      const blob = new Blob([res.content], { type: 'text/plain;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = res.fileName || 'portly-crash-report.log';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
    }
    showToast(`Crash report downloaded & saved locally to ${res.savedPath}`);
  } catch (err) {
    showToast(err.message || 'Failed to export crash report.', 'error');
  }
}

if (els.btnSidebarCrashReport) {
  els.btnSidebarCrashReport.addEventListener('click', () => exportCrashReport(null));
}
if (els.btnExportCrashLogs) {
  els.btnExportCrashLogs.addEventListener('click', () => exportCrashReport(state.selectedLogProjectId || null));
}

function getClientLayoutSnapshot() {
  const expandedCardPaths = state.projects
    .filter((p) => state.expandedCards.has(p.id))
    .map((p) => p.path);
  return {
    ...state.layout,
    viewMode: state.viewMode || 'split',
    filter: state.filter || 'all',
    expandedCardPaths
  };
}

function applyImportedEnvironmentResponse(res) {
  if (!res || typeof res !== 'object') return;
  if (res.layout && typeof res.layout === 'object') {
    const l = res.layout;
    if (['expanded', 'compact', 'collapsed'].includes(l.overviewMode)) {
      state.layout.overviewMode = l.overviewMode;
    }
    if (['top', 'bottom'].includes(l.overviewPosition)) {
      state.layout.overviewPosition = l.overviewPosition;
    }
    if (Number.isFinite(Number(l.overviewScale))) {
      state.layout.overviewScale =
        Math.round(Math.min(1.22, Math.max(0.65, Number(l.overviewScale))) * 100) / 100;
    }
    if (Array.isArray(l.overviewBlockOrder) && l.overviewBlockOrder.length === 2) {
      state.layout.overviewBlockOrder = [...l.overviewBlockOrder];
    }
    if (Array.isArray(l.kpiOrder) && l.kpiOrder.length === 3) {
      state.layout.kpiOrder = [...l.kpiOrder];
    }
    if (['horizontal', 'vertical'].includes(l.splitDirection)) {
      state.layout.splitDirection = l.splitDirection;
    }
    if (Number.isFinite(Number(l.splitRatio))) {
      state.layout.splitRatio =
        Math.round(Math.min(80, Math.max(20, Number(l.splitRatio))) * 10) / 10;
    }
    if (['split', 'console-collapsed', 'console-full'].includes(l.paneFocus)) {
      state.layout.paneFocus = l.paneFocus;
    }
    saveLayoutPrefs();
  }

  if (Array.isArray(res.stacks)) {
    state.stacks = res.stacks;
  }
  if (Array.isArray(res.projects)) {
    state.projects = res.projects;
  }

  if (res.settings) {
    applySettings(res.settings);
  }

  state.expandedCards.clear();
  const expandedPaths = Array.isArray(res.layout?.expandedCardPaths)
    ? new Set(res.layout.expandedCardPaths.map((p) => String(p).toLowerCase()))
    : null;
  if (res.settings?.defaultExpanded) {
    for (const p of state.projects) state.expandedCards.add(p.id);
  } else if (expandedPaths && expandedPaths.size > 0) {
    for (const p of state.projects) {
      if (expandedPaths.has(String(p.path || '').toLowerCase())) {
        state.expandedCards.add(p.id);
      }
    }
  }

  if (res.layout && ['all', 'running', 'stopped', 'crashed'].includes(res.layout.filter)) {
    state.filter = res.layout.filter;
    for (const t of els.filterTabs) {
      t.classList.toggle('active', t.dataset.filter === state.filter);
    }
  }

  const nextViewMode =
    res.layout && ['split', 'cards', 'table'].includes(res.layout.viewMode)
      ? res.layout.viewMode
      : state.viewMode;
  switchViewMode(nextViewMode);

  if (!state.projects.some((p) => p.id === state.selectedLogProjectId)) {
    state.selectedLogProjectId = state.projects[0]?.id || null;
    if (state.selectedLogProjectId) {
      selectLogProject(state.selectedLogProjectId);
    } else {
      state.logs = [];
      renderLogs();
    }
  }
}

async function exportEnvironmentConfig() {
  try {
    const res = await apiRequest('/api/config/export', {
      method: 'POST',
      body: JSON.stringify({ layout: getClientLayoutSnapshot() })
    });
    if (res.dialogUsed) {
      if (!res.canceled) {
        showToast(`Environment config saved to ${res.savedPath}`);
      } else {
        showToast(`Saved config backup copy to ${res.archivePath}`);
      }
      return;
    }
    if (res && typeof res.content === 'string') {
      const blob = new Blob([res.content], { type: 'application/json;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = res.fileName || 'portly-config.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
    }
    showToast(`Config saved locally to ${res.savedPath}`);
  } catch (err) {
    showToast(err.message || 'Failed to save config file.', 'error');
  }
}

function syncConfigModeButtons(mode) {
  state.configImportMode = mode === 'merge' ? 'merge' : 'replace';
  for (const btn of els.configModeBtns || []) {
    btn.classList.toggle('active', btn.dataset.configMode === state.configImportMode);
  }
}

function updateReopenBrokenPathsButton() {
  if (!els.btnReopenBrokenPaths) return;
  const count = state.brokenPathsQueue.length;
  els.btnReopenBrokenPaths.classList.toggle('hidden', count === 0);
  const labelSpan = els.btnReopenBrokenPaths.querySelector('span');
  if (labelSpan) {
    labelSpan.textContent = `Fix Broken Paths (${count})`;
  } else {
    els.btnReopenBrokenPaths.textContent = `Fix Broken Paths (${count})`;
  }
}

function getBrokenItemStatusText(item) {
  if (item.validating) {
    return { cls: 'broken-path-status', text: 'Checking folder...' };
  }
  if (item.inspection && item.inspection.valid) {
    const info = item.inspection;
    const parts = [
      info.programType || info.framework,
      info.language,
      info.defaultPort ? `Port ${info.defaultPort}` : ''
    ].filter(Boolean);
    return {
      cls: 'broken-path-status ok',
      text: `Ready to restore: ${parts.join(' • ') || 'Valid project folder'}`
    };
  }
  if (item.inspection && !item.inspection.valid) {
    return {
      cls: 'broken-path-status err',
      text: item.inspection.error || 'Directory still invalid or missing.'
    };
  }
  return {
    cls: 'broken-path-status err',
    text: item.error || 'Directory does not exist on this machine.'
  };
}

function updateBrokenItemStatusDom(item) {
  if (!els.brokenPathsList || !item) return;
  const card = els.brokenPathsList.querySelector(
    `[data-broken-uid="${CSS.escape(item.uid)}"]`
  );
  const statusEl = els.brokenPathsList.querySelector(
    `[data-broken-status="${CSS.escape(item.uid)}"]`
  );
  const { cls, text } = getBrokenItemStatusText(item);
  if (card) {
    card.classList.toggle('is-valid', Boolean(item.inspection && item.inspection.valid));
  }
  if (statusEl) {
    statusEl.className = cls;
    statusEl.textContent = text;
  }
}

function renderBrokenPathsList() {
  if (!els.brokenPathsList) return;
  const count = state.brokenPathsQueue.length;
  if (els.brokenPathsCountPill) {
    els.brokenPathsCountPill.textContent = `${count} Missing`;
    els.brokenPathsCountPill.className = count > 0 ? 'status-pill crashed' : 'status-pill running';
  }
  if (els.btnBrokenApplyAll) {
    els.btnBrokenApplyAll.disabled = count === 0;
    els.btnBrokenApplyAll.textContent =
      count === 1 ? 'Restore Fixed Path' : `Restore Fixed Paths (${count})`;
  }
  if (els.brokenPathsSubtitle) {
    const sourceText = state.brokenPathsSourceLabel
      ? ` from "${state.brokenPathsSourceLabel}"`
      : '';
    els.brokenPathsSubtitle.textContent = `The following project directory path(s)${sourceText} could not be found on this computer. Browse or paste the updated folder location below to restore each project with its saved settings.`;
  }

  if (count === 0) {
    els.brokenPathsList.innerHTML = '';
    return;
  }

  els.brokenPathsList.innerHTML = state.brokenPathsQueue
    .map((item) => {
      const status = getBrokenItemStatusText(item);
      const validClass = item.inspection && item.inspection.valid ? ' is-valid' : '';
      const portMeta = item.customPort ? ` :${item.customPort}` : '';
      return `
        <div class="broken-path-item${validClass}" data-broken-uid="${escapeHtml(item.uid)}">
          <div class="broken-path-head">
            <div class="broken-path-name-wrap">
              <span class="broken-path-name">${escapeHtml(item.name || 'Project')}</span>
              <span class="broken-path-cmd">${escapeHtml((item.command || 'npm run dev') + portMeta)}</span>
            </div>
            <div class="card-actions-right">
              <button class="btn btn-xs btn-primary" type="button" data-broken-restore="${escapeHtml(item.uid)}">Restore</button>
              <button class="btn btn-xs btn-soft" type="button" data-broken-skip="${escapeHtml(item.uid)}">Skip</button>
            </div>
          </div>
          <div class="broken-path-missing">Missing path: ${escapeHtml(item.brokenPath)}</div>
          <div class="broken-path-controls">
            <input
              type="text"
              data-broken-input="${escapeHtml(item.uid)}"
              value="${escapeHtml(item.newPath)}"
              placeholder="Paste updated folder path..."
              autocomplete="off"
            />
            <button class="btn btn-sm btn-soft" type="button" data-broken-browse="${escapeHtml(item.uid)}">Browse...</button>
          </div>
          <div class="${status.cls}" data-broken-status="${escapeHtml(item.uid)}">${escapeHtml(status.text)}</div>
        </div>
      `;
    })
    .join('');
}

function openBrokenPathsModal() {
  if (!els.brokenPathsModal) return;
  if (els.brokenPathsError) {
    els.brokenPathsError.textContent = '';
    els.brokenPathsError.classList.add('hidden');
  }
  renderBrokenPathsList();
  els.brokenPathsModal.classList.remove('hidden');
  const firstInput = els.brokenPathsList?.querySelector('input[data-broken-input]');
  if (firstInput) {
    setTimeout(() => {
      firstInput.focus();
      firstInput.select();
    }, 30);
  }
}

function closeBrokenPathsModal() {
  if (!els.brokenPathsModal) return;
  els.brokenPathsModal.classList.add('hidden');
}

let brokenUidSeq = 1;
function enqueueBrokenPaths(items, sourceLabel = 'uploaded config') {
  const cleanItems = (Array.isArray(items) ? items : [])
    .filter(Boolean)
    .map((item) => {
      if (typeof item === 'string') {
        const cleanName = item.split(/[\\/]/).filter(Boolean).pop() || 'Project';
        return {
          uid: `bp-${brokenUidSeq++}`,
          name: cleanName,
          brokenPath: item,
          newPath: item,
          command: 'npm run dev',
          customPort: '',
          error: 'Directory does not exist on this machine.',
          inspection: null,
          validating: false
        };
      }
      const raw = item.brokenPath || item.rawPath || item.path || '';
      const fallbackName = raw.split(/[\\/]/).filter(Boolean).pop() || 'Project';
      return {
        uid: `bp-${brokenUidSeq++}`,
        name: item.name || fallbackName,
        brokenPath: raw,
        newPath: raw,
        command: item.command || 'npm run dev',
        customPort: item.customPort || '',
        error: item.error || 'Directory does not exist on this machine.',
        inspection: null,
        validating: false
      };
    });

  state.brokenPathsQueue = cleanItems;
  state.brokenPathsSourceLabel = sourceLabel;
  updateReopenBrokenPathsButton();
  if (cleanItems.length > 0) {
    openBrokenPathsModal();
  }
}

const brokenInspectTimers = new Map();
async function inspectBrokenPathItem(uid, rawPath) {
  const item = state.brokenPathsQueue.find((x) => x.uid === uid);
  if (!item) return;
  item.newPath = rawPath;
  const trimmed = String(rawPath || '').trim();
  if (!trimmed) {
    item.inspection = null;
    item.validating = false;
    updateBrokenItemStatusDom(item);
    return;
  }
  item.validating = true;
  updateBrokenItemStatusDom(item);
  try {
    const info = await apiRequest('/api/inspect', {
      method: 'POST',
      body: JSON.stringify({ path: trimmed })
    });
    item.inspection = info;
    item.validating = false;
    updateBrokenItemStatusDom(item);
  } catch (err) {
    item.inspection = { valid: false, error: err.message };
    item.validating = false;
    updateBrokenItemStatusDom(item);
  }
}

async function browseForBrokenPathItem(uid) {
  const item = state.brokenPathsQueue.find((x) => x.uid === uid);
  if (!item) return;
  try {
    const res = await apiRequest('/api/pick-folder', { method: 'POST' });
    if (res.path) {
      item.newPath = res.path;
      const inputEl = els.brokenPathsList?.querySelector(
        `input[data-broken-input="${CSS.escape(uid)}"]`
      );
      if (inputEl) {
        inputEl.value = res.path;
      }
      await inspectBrokenPathItem(uid, res.path);
    }
  } catch (err) {
    showToast(`Folder picker error: ${err.message}`, 'error');
  }
}

async function restoreBrokenItemRecord(item) {
  const fixedPath = String(item.newPath || '').trim();
  if (!fixedPath) {
    item.inspection = { valid: false, error: 'Please enter a valid folder path.' };
    updateBrokenItemStatusDom(item);
    return { ok: false };
  }
  try {
    const created = await apiRequest('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        path: fixedPath,
        name: item.name,
        command: item.command || undefined,
        customPort: item.customPort || ''
      })
    });
    state.brokenPathsQueue = state.brokenPathsQueue.filter((x) => x.uid !== item.uid);
    return { ok: true, project: created };
  } catch (err) {
    item.inspection = { valid: false, error: err.message };
    item.error = err.message;
    updateBrokenItemStatusDom(item);
    return { ok: false, error: err.message };
  }
}

async function restoreSingleBrokenPathItem(uid) {
  const item = state.brokenPathsQueue.find((x) => x.uid === uid);
  if (!item) return;
  if (els.brokenPathsError) {
    els.brokenPathsError.classList.add('hidden');
  }
  const result = await restoreBrokenItemRecord(item);
  if (result.ok) {
    await loadProjects();
    if (!state.selectedLogProjectId && result.project?.id) {
      selectLogProject(result.project.id);
    }
    updateReopenBrokenPathsButton();
    if (state.brokenPathsQueue.length === 0) {
      closeBrokenPathsModal();
    } else {
      renderBrokenPathsList();
    }
    showToast(`Restored ${result.project?.name || item.name}.`);
  }
}

async function restoreAllBrokenPathItems() {
  if (!state.brokenPathsQueue.length) return;
  if (els.brokenPathsError) {
    els.brokenPathsError.classList.add('hidden');
  }
  if (els.btnBrokenApplyAll) {
    els.btnBrokenApplyAll.disabled = true;
    els.btnBrokenApplyAll.textContent = 'Restoring...';
  }
  let restoredCount = 0;
  try {
    const snapshot = [...state.brokenPathsQueue];
    for (const item of snapshot) {
      const res = await restoreBrokenItemRecord(item);
      if (res.ok) {
        restoredCount += 1;
      }
    }
    if (restoredCount > 0) {
      await loadProjects();
    }
    updateReopenBrokenPathsButton();
    if (state.brokenPathsQueue.length === 0) {
      closeBrokenPathsModal();
      showToast(`Restored ${restoredCount} project path(s).`);
    } else {
      renderBrokenPathsList();
      if (restoredCount > 0) {
        showToast(`Restored ${restoredCount} project(s); ${state.brokenPathsQueue.length} still need valid paths.`);
      } else if (els.brokenPathsError) {
        els.brokenPathsError.textContent =
          'No folders were restored yet — enter a valid folder path on this machine or click Skip.';
        els.brokenPathsError.classList.remove('hidden');
      }
    }
  } finally {
    if (els.btnBrokenApplyAll) {
      const remaining = state.brokenPathsQueue.length;
      els.btnBrokenApplyAll.disabled = remaining === 0;
      els.btnBrokenApplyAll.textContent =
        remaining === 1 ? 'Restore Fixed Path' : `Restore Fixed Paths (${remaining})`;
    }
  }
}

function triggerImportConfigFile() {
  if (!els.configFileInput) return;
  els.configFileInput.value = '';
  els.configFileInput.click();
}

async function handleImportConfigFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Selected file is not valid JSON.');
    }
    let res;
    try {
      res = await apiRequest('/api/config/import', {
        method: 'POST',
        body: JSON.stringify({ config: parsed, mode: state.configImportMode })
      });
    } catch (err) {
      if (!(err.status === 409 && err.data && err.data.needsConfirmation)) throw err;
      // Config files can come from anywhere: show every command they would add or change.
      const changes = Array.isArray(err.data.commandChanges) ? err.data.commandChanges : [];
      const listHtml = changes.length
        ? `<ul class="confirm-list">${changes
            .map(
              (c) => `<li><strong>${escapeHtml(c.name)}</strong> <span class="muted">${escapeHtml(c.path)}</span><br />
                ${c.from ? `<code class="confirm-old">${escapeHtml(c.from)}</code> → ` : ''}<code class="confirm-new">${escapeHtml(c.to)}</code></li>`
            )
            .join('')}</ul>`
        : '';
      const replacing = Number(err.data.replacesProjects) || 0;
      const ok = await confirmDialog({
        title: 'Review this config before importing',
        message: `${changes.length ? `It sets ${changes.length} start command${changes.length === 1 ? '' : 's'}. These run on your computer when you press Start, so only continue if you trust where this file came from.` : ''}${replacing ? ` Replace mode stops all running servers and replaces your ${replacing} current project${replacing === 1 ? '' : 's'}.` : ''}`.trim(),
        detailsHtml: listHtml,
        confirmLabel: 'Import',
        danger: true
      });
      if (!ok) return;
      res = await apiRequest('/api/config/import', {
        method: 'POST',
        body: JSON.stringify({ config: parsed, mode: state.configImportMode, confirmCommands: true })
      });
    }
    applyImportedEnvironmentResponse(res);
    closeSettingsModal();
    const brokenList =
      Array.isArray(res.brokenProjects) && res.brokenProjects.length > 0
        ? res.brokenProjects
        : Array.isArray(res.skippedMissingPaths)
          ? res.skippedMissingPaths
          : [];
    const importedCount = Number(res.importedProjectsCount) || 0;
    const skippedMsg =
      brokenList.length > 0 ? ` (${brokenList.length} broken path(s) need repair)` : '';
    showToast(`Loaded environment config — ${importedCount} project(s) restored${skippedMsg}.`);
    if (brokenList.length > 0) {
      enqueueBrokenPaths(brokenList, file.name);
    } else {
      state.brokenPathsQueue = [];
      updateReopenBrokenPathsButton();
    }
  } catch (err) {
    showToast(err.message || 'Failed to load config file.', 'error');
  }
}

for (const btn of els.configModeBtns || []) {
  btn.addEventListener('click', () => {
    syncConfigModeButtons(btn.dataset.configMode);
  });
}
if (els.btnExportConfig) {
  els.btnExportConfig.addEventListener('click', exportEnvironmentConfig);
}
if (els.btnImportConfig) {
  els.btnImportConfig.addEventListener('click', triggerImportConfigFile);
}
if (els.btnReopenBrokenPaths) {
  els.btnReopenBrokenPaths.addEventListener('click', () => {
    closeSettingsModal();
    openBrokenPathsModal();
  });
}
if (els.btnOnboardingImportConfig) {
  els.btnOnboardingImportConfig.addEventListener('click', triggerImportConfigFile);
}
if (els.configFileInput) {
  els.configFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    await handleImportConfigFile(file);
    els.configFileInput.value = '';
  });
}
if (els.brokenPathsModalClose) {
  els.brokenPathsModalClose.addEventListener('click', closeBrokenPathsModal);
}
if (els.brokenPathsModal) {
  els.brokenPathsModal.addEventListener('click', (e) => {
    if (e.target === els.brokenPathsModal) closeBrokenPathsModal();
  });
}
if (els.btnBrokenSkipAll) {
  els.btnBrokenSkipAll.addEventListener('click', () => {
    state.brokenPathsQueue = [];
    updateReopenBrokenPathsButton();
    closeBrokenPathsModal();
    showToast('Skipped remaining broken directories.');
  });
}
if (els.btnBrokenApplyAll) {
  els.btnBrokenApplyAll.addEventListener('click', restoreAllBrokenPathItems);
}
if (els.brokenPathsList) {
  els.brokenPathsList.addEventListener('input', (e) => {
    const input = e.target.closest('input[data-broken-input]');
    if (!input) return;
    const uid = input.dataset.brokenInput;
    const item = state.brokenPathsQueue.find((x) => x.uid === uid);
    if (!item) return;
    item.newPath = input.value;
    clearTimeout(brokenInspectTimers.get(uid));
    brokenInspectTimers.set(
      uid,
      setTimeout(() => {
        inspectBrokenPathItem(uid, input.value);
      }, 280)
    );
  });

  els.brokenPathsList.addEventListener('click', async (e) => {
    const browseBtn = e.target.closest('[data-broken-browse]');
    if (browseBtn) {
      await browseForBrokenPathItem(browseBtn.dataset.brokenBrowse);
      return;
    }
    const restoreBtn = e.target.closest('[data-broken-restore]');
    if (restoreBtn) {
      await restoreSingleBrokenPathItem(restoreBtn.dataset.brokenRestore);
      return;
    }
    const skipBtn = e.target.closest('[data-broken-skip]');
    if (skipBtn) {
      const uid = skipBtn.dataset.brokenSkip;
      state.brokenPathsQueue = state.brokenPathsQueue.filter((x) => x.uid !== uid);
      updateReopenBrokenPathsButton();
      if (state.brokenPathsQueue.length === 0) {
        closeBrokenPathsModal();
      } else {
        renderBrokenPathsList();
      }
    }
  });
}

if (els.btnBannerScan) {
  els.btnBannerScan.addEventListener('click', () => openAddModal('bulk', true));
}
if (els.btnBannerAdd) {
  els.btnBannerAdd.addEventListener('click', () => openAddModal('single', false));
}
if (els.btnOverviewPosition) {
  els.btnOverviewPosition.addEventListener('click', () => {
    state.layout.overviewPosition =
      state.layout.overviewPosition === 'bottom' ? 'top' : 'bottom';
    saveLayoutPrefs();
    applyLayoutPrefs();
  });
}
for (const btn of els.overviewModeBtns) {
  btn.addEventListener('click', () => {
    state.layout.overviewMode = btn.dataset.overviewMode || 'expanded';
    if (state.layout.overviewMode === 'expanded') {
      state.layout.overviewScale = 1;
    }
    saveLayoutPrefs();
    applyLayoutPrefs();
  });
}

// Drag-to-resize Overview Section proportionally
if (els.overviewResizer && els.overviewSection) {
  let overviewDragging = false;
  let startY = 0;
  let startScale = 1;

  const onOverviewPointerMove = (e) => {
    if (!overviewDragging) return;
    const isBottom = state.layout.overviewPosition === 'bottom';
    const delta = isBottom ? startY - e.clientY : e.clientY - startY;
    const nextScale = startScale + delta / 220;
    if (nextScale < 0.52) {
      state.layout.overviewMode = 'collapsed';
    } else {
      if (state.layout.overviewMode === 'collapsed') {
        state.layout.overviewMode = 'expanded';
      }
      state.layout.overviewScale = Math.round(Math.min(1.22, Math.max(0.65, nextScale)) * 100) / 100;
    }
    applyLayoutPrefs();
  };

  const endOverviewDrag = () => {
    if (!overviewDragging) return;
    overviewDragging = false;
    els.overviewResizer.classList.remove('dragging');
    window.removeEventListener('pointermove', onOverviewPointerMove);
    window.removeEventListener('pointerup', endOverviewDrag);
    window.removeEventListener('pointercancel', endOverviewDrag);
    saveLayoutPrefs();
  };

  els.overviewResizer.addEventListener('pointerdown', (e) => {
    overviewDragging = true;
    startY = e.clientY;
    startScale = Number.isFinite(Number(state.layout.overviewScale))
      ? Number(state.layout.overviewScale)
      : 1;
    els.overviewResizer.classList.add('dragging');
    window.addEventListener('pointermove', onOverviewPointerMove);
    window.addEventListener('pointerup', endOverviewDrag);
    window.addEventListener('pointercancel', endOverviewDrag);
    try {
      els.overviewResizer.setPointerCapture(e.pointerId);
    } catch {
      // Ignore capture error
    }
    e.preventDefault();
  });

  els.overviewResizer.addEventListener('dblclick', () => {
    state.layout.overviewMode = 'expanded';
    state.layout.overviewScale = 1;
    saveLayoutPrefs();
    applyLayoutPrefs();
  });
}

// Drag-and-drop reorder Overview blocks (Banner / KPI Row) and individual KPI cards
(function initOverviewWidgetDragDrop() {
  if (els.overviewContent) {
    let draggedBlock = null;
    els.overviewContent.addEventListener('dragstart', (e) => {
      const kpiTarget = e.target.closest('.kpi-card[data-kpi-id]');
      if (kpiTarget) return;
      const block = e.target.closest('[data-overview-block]');
      if (!block) return;
      draggedBlock = block.dataset.overviewBlock;
      block.classList.add('dragging-widget');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `block:${draggedBlock}`);
      }
    });
    els.overviewContent.addEventListener('dragover', (e) => {
      if (!draggedBlock) return;
      const overBlock = e.target.closest('[data-overview-block]');
      if (!overBlock || overBlock.dataset.overviewBlock === draggedBlock) return;
      e.preventDefault();
      overBlock.classList.add('drag-over-widget');
    });
    els.overviewContent.addEventListener('dragleave', (e) => {
      const overBlock = e.target.closest('[data-overview-block]');
      if (overBlock) overBlock.classList.remove('drag-over-widget');
    });
    els.overviewContent.addEventListener('drop', (e) => {
      if (!draggedBlock) return;
      const targetBlock = e.target.closest('[data-overview-block]');
      if (!targetBlock || targetBlock.dataset.overviewBlock === draggedBlock) return;
      e.preventDefault();
      targetBlock.classList.remove('drag-over-widget');
      state.layout.overviewBlockOrder =
        state.layout.overviewBlockOrder[0] === 'banner' ? ['kpis', 'banner'] : ['banner', 'kpis'];
      saveLayoutPrefs();
      applyOverviewOrder();
    });
    els.overviewContent.addEventListener('dragend', () => {
      draggedBlock = null;
      for (const node of els.overviewContent.querySelectorAll('.dragging-widget, .drag-over-widget')) {
        node.classList.remove('dragging-widget', 'drag-over-widget');
      }
    });
  }

  if (els.kpiGrid) {
    let draggedKpi = null;
    els.kpiGrid.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.kpi-card[data-kpi-id]');
      if (!card) return;
      draggedKpi = card.dataset.kpiId;
      card.classList.add('dragging-widget');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', `kpi:${draggedKpi}`);
      }
    });
    els.kpiGrid.addEventListener('dragover', (e) => {
      if (!draggedKpi) return;
      const overCard = e.target.closest('.kpi-card[data-kpi-id]');
      if (!overCard || overCard.dataset.kpiId === draggedKpi) return;
      e.preventDefault();
      overCard.classList.add('drag-over-widget');
    });
    els.kpiGrid.addEventListener('dragleave', (e) => {
      const overCard = e.target.closest('.kpi-card[data-kpi-id]');
      if (overCard) overCard.classList.remove('drag-over-widget');
    });
    els.kpiGrid.addEventListener('drop', (e) => {
      if (!draggedKpi) return;
      const targetCard = e.target.closest('.kpi-card[data-kpi-id]');
      if (!targetCard || targetCard.dataset.kpiId === draggedKpi) return;
      e.preventDefault();
      targetCard.classList.remove('drag-over-widget');
      const order = [...state.layout.kpiOrder];
      const fromIdx = order.indexOf(draggedKpi);
      const toIdx = order.indexOf(targetCard.dataset.kpiId);
      if (fromIdx >= 0 && toIdx >= 0) {
        const [moved] = order.splice(fromIdx, 1);
        order.splice(toIdx, 0, moved);
        state.layout.kpiOrder = order;
        saveLayoutPrefs();
        applyOverviewOrder();
      }
    });
    els.kpiGrid.addEventListener('dragend', () => {
      draggedKpi = null;
      for (const node of els.kpiGrid.querySelectorAll('.dragging-widget, .drag-over-widget')) {
        node.classList.remove('dragging-widget', 'drag-over-widget');
      }
    });
  }
})();

// Borderless window controls (Electron native + exit-to-tray + graceful browser fallback)
async function sendWindowControl(action) {
  let controlRes = null;
  try {
    const res = await apiRequest('/api/window-control', {
      method: 'POST',
      body: JSON.stringify({ action })
    });
    controlRes = res;
    if (res && res.frameless) {
      if (res.quitting) {
        showToast('Shutting down Portly completely...');
      } else if (res.hiddenToTray || action === 'tray' || (action === 'close' && !res.closedSecondaryWindow)) {
        showToast('Portly moved to the system tray — servers keep running in the background.');
      }
      return;
    }
  } catch {
    // Fallback below if running in standard browser
  }
  if (action === 'maximize') {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  } else if (action === 'tray') {
    showToast('Close / Tray hides the standalone Portly desktop window to the system tray so apps keep running.');
  } else if (action === 'close') {
    if ((controlRes && controlRes.quitting) || state.settings.exitClosesCompletely) {
      showToast('Exiting the window shuts down Portly completely.');
    } else {
      showToast('Close / Tray hides the standalone Portly desktop window to the system tray so apps keep running.');
    }
  } else if (action === 'minimize') {
    showToast('Minimize button minimizes the standalone Portly desktop app window.');
  }
}

if (els.btnWinTray) {
  els.btnWinTray.addEventListener('click', () => sendWindowControl('tray'));
}
if (els.btnWinMinimize) {
  els.btnWinMinimize.addEventListener('click', () => sendWindowControl('minimize'));
}
if (els.btnWinMaximize) {
  els.btnWinMaximize.addEventListener('click', () => sendWindowControl('maximize'));
}
if (els.btnWinClose) {
  els.btnWinClose.addEventListener('click', () => sendWindowControl('close'));
}

if (els.btnSplitDirection) {
  els.btnSplitDirection.addEventListener('click', () => {
    if (state.viewMode !== 'split') {
      state.layout.splitDirection = 'horizontal';
      state.layout.paneFocus = 'split';
      saveLayoutPrefs();
      switchViewMode('split');
      return;
    }
    state.layout.splitDirection =
      state.layout.splitDirection === 'horizontal' ? 'vertical' : 'horizontal';
    state.layout.paneFocus = 'split';
    saveLayoutPrefs();
    applyLayoutPrefs();
  });
}
if (els.btnCollapseConsole) {
  els.btnCollapseConsole.addEventListener('click', () => {
    state.layout.paneFocus =
      state.layout.paneFocus === 'console-collapsed' ? 'split' : 'console-collapsed';
    saveLayoutPrefs();
    applyLayoutPrefs();
  });
}
if (els.btnMaximizeConsole) {
  els.btnMaximizeConsole.addEventListener('click', () => {
    state.layout.paneFocus =
      state.layout.paneFocus === 'console-full' ? 'split' : 'console-full';
    saveLayoutPrefs();
    applyLayoutPrefs();
  });
}

// Drag-to-resize Projects / Console split resizer
if (els.workspaceResizer && els.workspaceGrid) {
  let dragging = false;

  const onWorkspacePointerMove = (e) => {
    if (!dragging) return;
    const rect = els.workspaceGrid.getBoundingClientRect();
    const effectiveDir = els.workspaceGrid.getAttribute('data-split-dir') || 'horizontal';
    let pct;
    if (effectiveDir === 'vertical') {
      pct = rect.height > 0 ? ((e.clientY - rect.top) / rect.height) * 100 : 56;
    } else {
      pct = rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * 100 : 56;
    }
    state.layout.paneFocus = 'split';
    state.layout.splitRatio = Math.round(Math.min(80, Math.max(20, pct)) * 10) / 10;
    applyLayoutPrefs();
  };

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    els.workspaceResizer.classList.remove('dragging');
    els.workspaceGrid.classList.remove('resizing');
    window.removeEventListener('pointermove', onWorkspacePointerMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    saveLayoutPrefs();
  };

  els.workspaceResizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    els.workspaceResizer.classList.add('dragging');
    els.workspaceGrid.classList.add('resizing');
    window.addEventListener('pointermove', onWorkspacePointerMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    try {
      els.workspaceResizer.setPointerCapture(e.pointerId);
    } catch {
      // Ignore pointer capture error
    }
    e.preventDefault();
  });

  els.workspaceResizer.addEventListener('dblclick', () => {
    state.layout.paneFocus = 'split';
    state.layout.splitRatio = 56;
    saveLayoutPrefs();
    applyLayoutPrefs();
  });
}
if (els.btnSidebarSettings) {
  els.btnSidebarSettings.addEventListener('click', openSettingsModal);
}
els.btnReloadApp.addEventListener('click', triggerReloadWithFadeToDark);

if (els.btnToggleExpandAll) {
  els.btnToggleExpandAll.addEventListener('click', () => {
    const allExpanded =
      state.projects.length > 0 && state.projects.every((p) => state.expandedCards.has(p.id));
    if (allExpanded) {
      state.expandedCards.clear();
    } else {
      for (const p of state.projects) {
        state.expandedCards.add(p.id);
      }
    }
    renderProjects();
  });
}

els.btnStopAll.addEventListener('click', async () => {
  try {
    await apiRequest('/api/projects/stop-all', { method: 'POST' });
    showToast('Stopped all running projects.');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

for (const tab of els.filterTabs) {
  tab.addEventListener('click', () => applyFilter(tab.dataset.filter));
}

for (const btn of els.viewBtns) {
  btn.addEventListener('click', () => switchViewMode(btn.dataset.view));
}

els.projectSearch.addEventListener('input', (e) => setSearchValue(e.target.value, els.projectSearch));
els.sidebarSearch.addEventListener('input', (e) => setSearchValue(e.target.value, els.sidebarSearch));

function getOpenModal() {
  const open = Array.from(document.querySelectorAll('.modal-backdrop:not(.hidden)')).filter(
    (m) => !m.classList.contains('confirm-dialog') && getComputedStyle(m).display !== 'none'
  );
  return open.length ? open[open.length - 1] : null;
}

function closeModalElement(modalEl) {
  if (modalEl === els.modal) closeModal();
  else if (modalEl === els.settingsModal) closeSettingsModal();
  else if (els.brokenPathsModal && modalEl === els.brokenPathsModal) closeBrokenPathsModal();
  else if (modalEl && modalEl.id === 'stack-modal') closeStackModal();
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

function moveProjectSelection(delta) {
  const list = getFilteredProjects();
  if (list.length === 0) return;
  const idx = list.findIndex((p) => p.id === state.selectedLogProjectId);
  const next = list[Math.max(0, Math.min(list.length - 1, idx < 0 ? 0 : idx + delta))];
  selectLogProject(next.id);
  const card = els.projectsGrid.querySelector(`[data-project-id="${CSS.escape(next.id)}"]`);
  if (card) card.scrollIntoView({ block: 'nearest' });
}

const SHORTCUT_HELP =
  'Shortcuts: ↑/↓ select project · Space start/stop · Enter or O open in browser · R restart · L focus logs · Ctrl/⌘+N add project · Ctrl/⌘+K search · Ctrl/⌘+Shift+S stop all';

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  const modal = getOpenModal();

  if (modal) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModalElement(modal);
    } else if (e.key === 'Tab') {
      trapFocus(modal.querySelector('.modal-card') || modal, e);
    }
    return;
  }

  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    els.sidebarSearch.focus();
    return;
  }
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    openAddModal('single');
    return;
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!els.btnStopAll.disabled) els.btnStopAll.click();
    return;
  }
  if (mod || e.altKey || isTypingTarget(e.target)) return;

  const selected = state.projects.find((p) => p.id === state.selectedLogProjectId);
  const onButton = e.target && e.target.closest && e.target.closest('button, a');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (onButton && e.target.closest('.segmented-control, .filter-pills, .stream-filters')) return;
    e.preventDefault();
    moveProjectSelection(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === ' ' && selected && !onButton) {
    e.preventDefault();
    const action = selected.status === 'running' ? 'stop' : 'start';
    apiRequest(`/api/projects/${encodeURIComponent(selected.id)}/${action}`, { method: 'POST' }).catch(
      (err) => showToast(err.message, 'error')
    );
  } else if ((e.key === 'Enter' && !onButton) || e.key.toLowerCase() === 'o') {
    if (selected && selected.status === 'running' && selected.detectedUrl) {
      e.preventDefault();
      window.open(projectOpenUrl(selected), '_blank', 'noopener,noreferrer');
    }
  } else if (e.key.toLowerCase() === 'r' && selected && selected.status === 'running') {
    e.preventDefault();
    apiRequest(`/api/projects/${encodeURIComponent(selected.id)}/restart`, { method: 'POST' }).catch(
      (err) => showToast(err.message, 'error')
    );
  } else if (e.key.toLowerCase() === 'l') {
    e.preventDefault();
    els.logsOutput.focus();
  } else if (e.key === '?') {
    e.preventDefault();
    showToast(SHORTCUT_HELP, 'success', { duration: 9000 });
  }
});

window.addEventListener('beforeunload', triggerExitFade);
window.addEventListener('pagehide', triggerExitFade);

els.sidebarProjectsList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-sidebar-project-id]');
  if (!btn) return;
  const id = btn.dataset.sidebarProjectId;
  await selectLogProject(id);
  const card = els.projectsGrid.querySelector(`[data-project-id="${CSS.escape(id)}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
});

for (const btn of els.streamBtns) {
  btn.addEventListener('click', () => {
    state.logStreamFilter = btn.dataset.stream;
    setPressed(els.streamBtns, (b) => b === btn);
    renderLogs();
  });
}

els.logSearch.addEventListener('input', (e) => {
  state.logSearch = e.target.value;
  renderLogs();
});

els.logAutoScroll.addEventListener('change', (e) => {
  state.autoScroll = e.target.checked;
  if (state.autoScroll) {
    els.logsOutput.scrollTop = els.logsOutput.scrollHeight;
  }
});

els.btnCopyLogs.addEventListener('click', async () => {
  if (!state.logs.length) return;
  const text = state.logs
    .map((l) => `[${formatLogTime(l.timestamp)}] [${l.stream.toUpperCase()}] ${l.text}`)
    .join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied logs to clipboard.');
  } catch {
    showToast('Clipboard permission denied.', 'error');
  }
});

els.btnClearLogs.addEventListener('click', async () => {
  if (!state.selectedLogProjectId) return;
  const project = state.projects.find((p) => p.id === state.selectedLogProjectId);
  const ok = await confirmDialog({
    title: 'Clear log file?',
    message: `This deletes the saved log for ${project ? project.name : 'this project'} from disk. It can't be undone.`,
    confirmLabel: 'Clear log file',
    danger: true
  });
  if (!ok) return;
  try {
    await apiRequest(`/api/projects/${encodeURIComponent(state.selectedLogProjectId)}/logs`, {
      method: 'DELETE'
    });
    state.logs = [];
    renderLogs();
    showToast('Log file cleared.');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// Opens the project in the browser as soon as its server answers.
function openWhenReady(project) {
  const existing = pendingOpenTabs.get(project.id);
  if (existing) clearTimeout(existing.timer);
  // In a normal browser a tab opened later would be blocked as a popup, so open a placeholder
  // tab now (during the click). The desktop app routes the final URL to your browser instead.
  let win = null;
  if (!document.documentElement.dataset.titlebar) {
    try {
      win = window.open('about:blank', '_blank');
      if (win && win.document) {
        win.document.title = `Starting ${project.name}…`;
        win.document.body.textContent = `Starting ${project.name}… This tab will load it as soon as the server is ready.`;
      }
    } catch {
      win = null;
    }
  }
  const timer = setTimeout(() => {
    pendingOpenTabs.delete(project.id);
    if (win && !win.closed) win.close();
  }, 60000);
  pendingOpenTabs.set(project.id, { win, timer });
}

// Empty-state buttons
els.projectsGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-empty-action]');
  if (!btn) return;
  const kind = btn.dataset.emptyAction;
  if (kind === 'add') openAddModal('single');
  else if (kind === 'bulk') openAddModal('bulk');
  else if (kind === 'stack') openAddModal('stack');
  else if (kind === 'scan' && els.btnScanFolder) els.btnScanFolder.click();
});

// Project Card & Table Delegated Actions
els.projectsGrid.addEventListener('click', async (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  if (!id || action === 'change-command') return;

  const project = state.projects.find((p) => p.id === id);

  try {
    if (action === 'toggle-expand') {
      if (state.expandedCards.has(id)) {
        state.expandedCards.delete(id);
      } else {
        state.expandedCards.add(id);
      }
      renderProjects();
    } else if (action === 'toggle' && project && project.status !== 'running' && (e.ctrlKey || e.metaKey)) {
      // Ctrl/Cmd-click on the switch: start and open in the browser once it's up.
      openWhenReady(project);
      selectLogProject(id);
      const started = await apiRequest(`/api/projects/${encodeURIComponent(id)}/start`, { method: 'POST' });
      upsertProjectState(started);
    } else if (action === 'toggle' && project) {
      if (project.status === 'running') {
        await apiRequest(`/api/projects/${encodeURIComponent(id)}/stop`, { method: 'POST' });
      } else {
        selectLogProject(id);
        await apiRequest(`/api/projects/${encodeURIComponent(id)}/start`, { method: 'POST' });
      }
    } else if (action === 'start') {
      await apiRequest(`/api/projects/${encodeURIComponent(id)}/start`, { method: 'POST' });
      selectLogProject(id);
    } else if (action === 'start-open' && project) {
      openWhenReady(project);
      const started = await apiRequest(`/api/projects/${encodeURIComponent(id)}/start`, {
        method: 'POST'
      });
      upsertProjectState(started);
      selectLogProject(id);
    } else if (action === 'reanalyze') {
      const updated = await apiRequest(`/api/projects/${encodeURIComponent(id)}/reanalyze`, {
        method: 'POST'
      });
      upsertProjectState(updated);
      showToast(`Detected ${updated.programType || updated.framework} (${updated.command})`);
    } else if (action === 'stop') {
      await apiRequest(`/api/projects/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    } else if (action === 'restart') {
      await apiRequest(`/api/projects/${encodeURIComponent(id)}/restart`, { method: 'POST' });
      selectLogProject(id);
    } else if (action === 'logs') {
      await selectLogProject(id);
    } else if (action === 'export-crash') {
      await exportCrashReport(id);
    } else if (action === 'edit' && project) {
      openEditModal(project);
    } else if (action === 'delete' && project) {
      const ok = await confirmDialog({
        title: `Remove ${project.name}?`,
        message: 'Portly will stop it if it is running and forget it. The files on disk are not touched.',
        confirmLabel: 'Remove',
        danger: true
      });
      if (!ok) return;
      await apiRequest(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      showToast(`Removed ${project.name}.`, 'success', {
        actionLabel: 'Undo',
        duration: 8000,
        onAction: async () => {
          try {
            const restored = await apiRequest('/api/projects', {
              method: 'POST',
              body: JSON.stringify({
                path: project.path,
                name: project.name,
                command: project.command,
                customPort: project.customPort || '',
                ...(project.stackId && state.stacks.some((s) => s.id === project.stackId)
                  ? { stackId: project.stackId, kind: project.kind }
                  : {})
              })
            });
            upsertProjectState(restored);
            showToast(`Restored ${project.name}.`);
          } catch (err) {
            showToast(err.message, 'error');
          }
        }
      });
    } else if (action === 'copy-path' && project) {
      await navigator.clipboard.writeText(project.path);
      showToast('Copied path to clipboard.');
    } else if (action === 'open-folder') {
      await apiRequest(`/api/projects/${encodeURIComponent(id)}/open-folder`, { method: 'POST' });
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
});

els.projectsGrid.addEventListener('change', async (e) => {
  const select = e.target.closest('select[data-action="change-command"]');
  if (!select) return;
  const id = select.dataset.id;
  try {
    await apiRequest(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ command: select.value })
    });
    showToast(`Command updated to "${select.value}"`);
  } catch (err) {
    showToast(err.message, 'error');
    loadProjects();
  }
});

// Settings Modal Interactions
els.settingsModalClose.addEventListener('click', closeSettingsModal);
els.btnCancelSettings.addEventListener('click', closeSettingsModal);
els.settingsModal.addEventListener('click', (e) => {
  if (e.target === els.settingsModal) closeSettingsModal();
});

for (const btn of els.themeChoiceBtns) {
  btn.addEventListener('click', () => {
    syncThemeChoiceButtons(btn.dataset.themeChoice);
  });
}

async function persistWindowSettingToggle(patch, message) {
  try {
    const saved = await apiRequest('/api/settings', {
      method: 'PUT',
      body: JSON.stringify(patch)
    });
    applySettings(saved);
    if (els.settingsModal && !els.settingsModal.classList.contains('hidden')) {
      syncThemeChoiceButtons(pendingSettingsTheme);
    }
    showToast(message);
  } catch (err) {
    showToast(err.message || 'Failed to update setting.', 'error');
    applySettings(state.settings);
  }
}

if (els.inputExitClosesCompletely) {
  els.inputExitClosesCompletely.addEventListener('change', (e) => {
    const enabled = Boolean(e.target.checked);
    persistWindowSettingToggle(
      { exitClosesCompletely: enabled },
      enabled
        ? 'Window close behavior updated: Exit shuts down Portly completely.'
        : 'Window close behavior updated: Close minimizes to system tray.'
    );
  });
}

if (els.inputAllowMultipleInstances) {
  els.inputAllowMultipleInstances.addEventListener('change', (e) => {
    const enabled = Boolean(e.target.checked);
    persistWindowSettingToggle(
      { allowMultipleInstances: enabled },
      enabled
        ? 'Multiple instances enabled.'
        : 'Single-instance mode enabled (existing tray/taskbar window will be restored).'
    );
  });
}

els.settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const userName = els.inputUserName.value.trim();
  if (!userName) {
    showToast('Please enter your name.', 'error');
    els.inputUserName.focus();
    return;
  }
  const defaultExpanded = els.inputDefaultExpanded.checked;
  const allowMultipleInstances = Boolean(els.inputAllowMultipleInstances?.checked);
  const exitClosesCompletely = Boolean(els.inputExitClosesCompletely?.checked);
  try {
    const saved = await apiRequest('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        userName,
        theme: pendingSettingsTheme,
        defaultExpanded,
        allowMultipleInstances,
        exitClosesCompletely,
        onboarded: true
      })
    });
    applySettings(saved);
    if (defaultExpanded) {
      for (const p of state.projects) state.expandedCards.add(p.id);
    } else {
      state.expandedCards.clear();
    }
    renderProjects();
    closeSettingsModal();
    showToast(`Saved settings for ${saved.userName}`);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

if (els.btnResetSettings) {
  els.btnResetSettings.addEventListener('click', async () => {
    els.btnResetSettings.disabled = true;
    try {
      try {
        localStorage.removeItem('devdeck-theme');
        localStorage.removeItem('devdeck-layout-v1');
        localStorage.removeItem('portly-layout-v1');
      } catch {
        // Ignore storage restriction
      }
      const reset = await apiRequest('/api/settings/reset', { method: 'POST' });
      closeSettingsModal();
      state.expandedCards.clear();
      applySettings(reset);
      renderProjects();
      showToast('Settings cleared. Welcome back to setup!');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      els.btnResetSettings.disabled = false;
    }
  });
}

// Onboarding Screen Interactions
if (els.onboardingNameInput) {
  els.onboardingNameInput.addEventListener('input', updateOnboardingGreetingPreview);
}

for (const btn of els.onboardingThemeBtns) {
  btn.addEventListener('click', () => {
    syncOnboardingThemeButtons(btn.dataset.onboardingTheme);
  });
}

if (els.onboardingForm) {
  els.onboardingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const userName = els.onboardingNameInput.value.trim();
    if (!userName) {
      els.onboardingNameInput.focus();
      showToast('Please enter your name to get started.', 'error');
      return;
    }
    const defaultExpanded = Boolean(els.onboardingDefaultExpanded?.checked);
    try {
      const saved = await apiRequest('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          userName,
          theme: pendingOnboardingTheme,
          defaultExpanded,
          onboarded: true
        })
      });
      applySettings(saved);
      if (defaultExpanded) {
        for (const p of state.projects) state.expandedCards.add(p.id);
      } else {
        state.expandedCards.clear();
      }
      renderProjects();
      showToast(`${computeGreeting(saved.userName)} — Welcome to Portly!`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// Add/Edit Modal interactions
els.modalClose.addEventListener('click', closeModal);
els.btnCancelSingle.addEventListener('click', closeModal);
els.btnCancelBulk.addEventListener('click', closeModal);
els.modal.addEventListener('click', (e) => {
  if (e.target === els.modal) closeModal();
});

for (const tab of els.modalTabs) {
  tab.addEventListener('click', () => {
    switchModalTab(tab.dataset.tab);
    els.modalTitle.textContent =
      tab.dataset.tab === 'bulk'
        ? 'Import a list of folders'
        : tab.dataset.tab === 'stack'
          ? 'Add a stack'
          : 'Add project';
  });
}

els.inputPath.addEventListener('input', () => {
  clearTimeout(inspectTimer);
  inspectTimer = setTimeout(() => {
    const isEditing = Boolean(els.editProjectId.value);
    runInspectPath(els.inputPath.value, isEditing);
  }, 350);
});

els.selectDetectedScript.addEventListener('change', (e) => {
  if (e.target.value) {
    els.inputCommand.value = e.target.value;
  }
});

els.btnBrowseFolder.addEventListener('click', async () => {
  els.btnBrowseFolder.disabled = true;
  els.btnBrowseFolder.textContent = 'Opening...';
  try {
    const res = await apiRequest('/api/pick-folder', { method: 'POST' });
    if (res.path) {
      els.inputPath.value = res.path;
      els.inputName.value = '';
      await runInspectPath(res.path, false);
    }
  } catch (err) {
    showToast(`Folder picker error: ${err.message}`, 'error');
  } finally {
    els.btnBrowseFolder.disabled = false;
    els.btnBrowseFolder.textContent = 'Browse...';
  }
});

els.singleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.singleFormError.classList.add('hidden');

  const editId = els.editProjectId.value;
  const payload = {
    path: els.inputPath.value.trim(),
    name: els.inputName.value.trim(),
    command: els.inputCommand.value.trim() || 'npm run dev',
    customPort: els.inputPort.value.trim(),
    ...stacksUiCollectPayload(Boolean(editId))
  };

  try {
    if (editId) {
      await apiRequest(`/api/projects/${encodeURIComponent(editId)}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      await stacksUiAfterSave(editId);
      showToast('Project updated.');
    } else {
      const created = await apiRequest('/api/projects', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      await stacksUiAfterSave(created.id);
      showToast(`Added ${created.name}`);
      if (!state.selectedLogProjectId || payload.stackId) {
        selectLogProject(created.id);
      }
    }
    closeModal();
    await loadProjects();
  } catch (err) {
    if (!editId && payload.path && /does not exist|not a directory/i.test(err.message)) {
      els.singleFormError.innerHTML =
        `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">` +
        `<span>${escapeHtml(err.message)}</span>` +
        `<button id="btn-single-open-fixer" class="btn btn-xs btn-soft" type="button">Fix in Pop-Up</button>` +
        `</div>`;
      els.singleFormError.classList.remove('hidden');
      const repairBtn = document.getElementById('btn-single-open-fixer');
      if (repairBtn) {
        repairBtn.addEventListener('click', () => {
          closeModal();
          enqueueBrokenPaths(
            [
              {
                name: payload.name || payload.path.split(/[\\/]/).filter(Boolean).pop() || 'Project',
                brokenPath: payload.path,
                rawPath: payload.path,
                command: payload.command,
                customPort: payload.customPort,
                error: err.message
              }
            ],
            'Add Local Project'
          );
        });
      }
    } else {
      els.singleFormError.textContent = err.message;
      els.singleFormError.classList.remove('hidden');
    }
  }
});

// Bulk / Upload Form interactions
els.btnChooseFile.addEventListener('click', () => els.fileUploadInput.click());

els.fileUploadInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  await handleFileSelection(file);
  els.fileUploadInput.value = '';
});

els.btnBulkBrowseFolder.addEventListener('click', async () => {
  try {
    const res = await apiRequest('/api/pick-folder', { method: 'POST' });
    if (res.path) {
      const existing = els.inputBulkPaths.value.trim();
      els.inputBulkPaths.value = existing ? `${existing}\n${res.path}` : res.path;
      els.inputScanSubfolders.checked = true;
    }
  } catch (err) {
    showToast(`Folder picker error: ${err.message}`, 'error');
  }
});

els.dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.dropzone.classList.add('dragover');
});

els.dropzone.addEventListener('dragleave', () => {
  els.dropzone.classList.remove('dragover');
});

els.dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  els.dropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) {
    await handleFileSelection(file);
  }
});

els.bulkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  els.bulkFormError.classList.add('hidden');
  els.bulkResultBox.classList.add('hidden');

  const rawText = els.inputBulkPaths.value.trim();
  const paths = parseUploadedTextToPaths(rawText, '');
  if (paths.length === 0) {
    els.bulkFormError.textContent = 'Please paste at least one folder path or upload a file.';
    els.bulkFormError.classList.remove('hidden');
    return;
  }

  els.btnSubmitBulk.disabled = true;
  els.btnSubmitBulk.textContent = 'Importing...';
  try {
    const result = await apiRequest('/api/projects/bulk', {
      method: 'POST',
      body: JSON.stringify({
        paths,
        scanSubfolders: els.inputScanSubfolders.checked
      })
    });

    const summary = [];
    summary.push(`<strong>Added:</strong> ${result.added.length}`);
    summary.push(`<strong>Skipped (already added):</strong> ${result.skipped.length}`);
    summary.push(`<strong>Errors:</strong> ${result.errors.length}`);
    if (result.errors.length > 0) {
      summary.push(
        `<div style="margin-top:6px;color:var(--rose);">${result.errors
          .map((er) => `${escapeHtml(er.path)}: ${escapeHtml(er.error)}`)
          .join('<br>')}</div>`
      );
    }

    els.bulkResultBox.innerHTML = summary.join(' &middot; ');
    els.bulkResultBox.classList.remove('hidden');

    await loadProjects();
    showToast(`Imported ${result.added.length} project(s).`);
    if (Array.isArray(result.errors) && result.errors.length > 0) {
      closeModal();
      enqueueBrokenPaths(
        result.errors.map((er) => ({
          brokenPath: er.path,
          rawPath: er.path,
          error: er.error
        })),
        'Bulk Path Upload'
      );
    }
  } catch (err) {
    els.bulkFormError.textContent = err.message;
    els.bulkFormError.classList.remove('hidden');
  } finally {
    els.btnSubmitBulk.disabled = false;
    els.btnSubmitBulk.textContent = 'Import Paths';
  }
});

// Live 1-second uptime & greeting refresher
setInterval(() => {
  if (document.hidden) return;
  for (const el of document.querySelectorAll('[data-starting-id]')) {
    const project = state.projects.find((p) => p.id === el.dataset.startingId);
    if (project) el.textContent = getStartingText(project);
  }
  const uptimeEls = document.querySelectorAll('[data-uptime-id]');
  for (const el of uptimeEls) {
    const id = el.dataset.uptimeId;
    const project = state.projects.find((p) => p.id === id);
    if (project && project.status === 'running' && project.startedAt) {
      el.textContent = formatUptime(project.startedAt);
    }
  }
}, 1000);

setInterval(renderGreetingAndProfile, 60000);

// Initialize
loadLayoutPrefs();
applyLayoutPrefs();
async function loadNotices() {
  try {
    const res = await apiRequest('/api/notices');
    for (const notice of (res && res.notices) || []) {
      showToast(notice.message, notice.level === 'error' ? 'error' : 'success', { sticky: true });
    }
  } catch {
    // Older engine without notices
  }
}

stacksUiInit();

(async () => {
  await Promise.all([loadSystemInfo(), loadSettings()]);
  playEntranceTransition();
  await loadProjects();
  connectSSE();
  loadNotices();
})();
