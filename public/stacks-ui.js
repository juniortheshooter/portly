'use strict';

// UI for Stacks, per-project environment variables and named URLs.
// Loaded before app.js; everything here runs only when app.js calls it, so it can use
// app.js helpers (state, els, apiRequest, escapeHtml, showToast, renderProjects ...).

/* global state, els, apiRequest, escapeHtml, showToast, renderProjects, selectLogProject,
   confirmDialog, getProjectPhase, getStartingText, formatUptime, iconExternal, iconSettings,
   iconTerminal, iconTrash, iconRestart, iconChevron, iconFolder, rememberFocusFor, restoreFocusFor,
   openAddModal, closeModal, upsertProjectState, renderCardsHtml, loadProjects, trapFocus */

const stacksUi = {
  editEnv: null, // env editor bound to the project edit modal
  stackEnv: null, // env editor bound to the stack modal
  addToStackId: null, // set while the Add modal adds a service to a stack
  suggestion: null, // services suggested in the New stack tab
  namedUrlStatus: { enabled: true, running: false, port: 1355, error: null }
};

// ---------------------------------------------------------------- helpers

function iconLayers() {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>';
}

function iconEye() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
}

function iconPlus() {
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
}

function iconX() {
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
}

/** The address to open for a project: its named URL when there is one, else the detected URL. */
function projectOpenUrl(p) {
  if (!p) return '';
  return p.namedUrl || p.detectedUrl || '';
}

function shortUrl(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function proxySuffix() {
  const port = stacksUi.namedUrlStatus.port;
  return Number(port) === 80 ? '.localhost' : `.localhost:${port}`;
}

function findStack(id) {
  return (state.stacks || []).find((s) => s.id === id) || null;
}

function stackServices(stack) {
  const byId = new Map(state.projects.map((p) => [p.id, p]));
  return (stack.serviceIds || []).map((id) => byId.get(id)).filter(Boolean);
}

async function loadStacks() {
  try {
    const list = await apiRequest('/api/stacks');
    state.stacks = Array.isArray(list) ? list : [];
  } catch {
    state.stacks = []; // older engine
  }
  try {
    stacksUi.namedUrlStatus = await apiRequest('/api/named-urls');
  } catch {
    // older engine
  }
}

// ---------------------------------------------------------------- cards

function stackPhase(stack) {
  if (stack.status === 'running' || stack.status === 'starting' || stack.status === 'crashed') return stack.status;
  if (stack.status === 'partial') return 'running';
  return 'stopped';
}

function stackStatusText(stack, services) {
  const { total, running } = stack.counts || { total: services.length, running: 0 };
  if (stack.status === 'starting') {
    const next = services.find((s) => s.status === 'running' && s.kind !== 'worker' && !s.detectedUrl);
    return next ? `Starting ${next.name}…` : 'Starting…';
  }
  if (stack.status === 'running') return 'Running';
  if (stack.status === 'crashed') return 'Crashed';
  if (stack.status === 'partial') return `${running} of ${total} running`;
  return 'Stopped';
}

function renderServiceRowHtml(p, stack, services) {
  const phase = getProjectPhase(p);
  const isRunning = p.status === 'running';
  const isWorker = p.kind === 'worker';
  const port = p.assignedPort || p.customPort || p.defaultPort;
  const after = (p.startAfter || [])
    .map((id) => services.find((s) => s.id === id))
    .filter(Boolean)
    .map((s) => s.name);
  let meta = '';
  if (isRunning && !isWorker && p.detectedUrl) {
    const url = projectOpenUrl(p);
    meta = `<a class="service-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(url)}">${escapeHtml(shortUrl(url))}</a>`;
  } else if (phase === 'starting' && !isWorker) {
    meta = `<span class="service-meta starting" data-starting-id="${escapeHtml(p.id)}">${escapeHtml(getStartingText(p))}</span>`;
  } else if (phase === 'crashed') {
    meta = `<span class="service-meta crashed" title="${escapeHtml(p.crashReason || '')}">${escapeHtml(p.crashReason || 'Crashed')}</span>`;
  } else {
    meta = `<span class="service-meta">${isWorker ? (isRunning ? 'running' : 'no port') : `:${escapeHtml(port)}`}</span>`;
  }
  const selected = p.id === state.selectedLogProjectId ? 'selected' : '';
  return `
    <li class="stack-service phase-${escapeHtml(phase)} ${selected}" data-service-id="${escapeHtml(p.id)}">
      <span class="status-dot ${escapeHtml(phase)}" role="img" aria-label="${escapeHtml(phase)}"></span>
      <button class="stack-service-name" type="button" data-action="logs" data-id="${escapeHtml(p.id)}" title="Show ${escapeHtml(p.name)}'s logs">
        <span>${escapeHtml(p.name)}</span>
        ${isWorker ? '<span class="service-kind">worker</span>' : ''}
      </button>
      <span class="stack-service-meta">${meta}</span>
      <span class="stack-service-after">${after.length ? `after ${escapeHtml(after.join(', '))}` : ''}</span>
      <span class="stack-service-actions">
        <button class="icon-btn" type="button" data-action="edit" data-id="${escapeHtml(p.id)}" title="Edit ${escapeHtml(p.name)}" aria-label="Edit ${escapeHtml(p.name)}">${iconSettings()}</button>
        <button class="ios-switch ios-switch-sm ${isRunning ? 'on' : ''}" type="button" role="switch"
          aria-checked="${isRunning ? 'true' : 'false'}" aria-label="${isRunning ? 'Stop' : 'Start'} ${escapeHtml(p.name)} only"
          data-action="toggle" data-id="${escapeHtml(p.id)}" title="${isRunning ? 'Stop' : 'Start'} only this service"></button>
      </span>
    </li>`;
}

function renderStackCardHtml(stack) {
  const services = stackServices(stack);
  const phase = stackPhase(stack);
  const isOn = ['running', 'starting', 'partial'].includes(stack.status);
  const expandKey = `stack:${stack.id}`;
  const isExpanded = state.expandedCards.has(expandKey);
  const primary = services.find((s) => s.id === stack.primaryServiceId);
  const primaryReady = primary && primary.status === 'running' && primary.detectedUrl;
  const openUrl = primaryReady ? stack.namedUrl || primary.detectedUrl : '';
  const crashed = services.filter((s) => s.status === 'crashed');
  const address = stack.namedUrl ? shortUrl(stack.namedUrl) : `${stack.hostname}${proxySuffix()}`;

  let footerLeft = '';
  if (openUrl) {
    footerLeft = `<a class="btn btn-sm btn-success open-link" href="${escapeHtml(openUrl)}" target="_blank" rel="noopener noreferrer" title="Open ${escapeHtml(primary.name)} in your browser">${iconExternal()}<span>${escapeHtml(shortUrl(openUrl))}</span></a>`;
  } else if (stack.status === 'starting') {
    footerLeft = `<span class="booting-pill">${escapeHtml(stackStatusText(stack, services))}</span>`;
  } else if (crashed.length) {
    footerLeft = `<button class="btn btn-sm btn-soft" type="button" data-stack-action="restart" data-stack-id="${escapeHtml(stack.id)}">${iconRestart()}<span>Restart stack</span></button>`;
  }

  return `
    <article class="project-card stack-card phase-${escapeHtml(phase)} ${isExpanded ? 'expanded' : ''}" data-stack-id="${escapeHtml(stack.id)}">
      <div class="card-compact-bar">
        <div class="card-title-group" data-stack-action="toggle-expand" data-stack-id="${escapeHtml(stack.id)}" title="Show stack details">
          <div class="app-avatar stack-avatar ${escapeHtml(phase)}">${iconLayers()}</div>
          <div class="card-name-block">
            <div class="card-name-row">
              <h3 class="project-name">${escapeHtml(stack.name)}</h3>
              <span class="stack-badge">Stack · ${services.length} service${services.length === 1 ? '' : 's'}</span>
            </div>
            <div class="card-made-with"><span class="card-port">${escapeHtml(address)}</span></div>
          </div>
        </div>
      </div>

      ${crashed.length ? `<div class="crash-reason" title="${escapeHtml(crashed.map((c) => `${c.name}: ${c.crashReason || 'crashed'}`).join('\n'))}">${escapeHtml(crashed[0].name)}: ${escapeHtml(crashed[0].crashReason || 'crashed')}${crashed.length > 1 ? ` (+${crashed.length - 1} more)` : ''}</div>` : ''}

      <ol class="stack-services" aria-label="Services in ${escapeHtml(stack.name)}, in start order">
        ${services.map((p) => renderServiceRowHtml(p, stack, services)).join('')}
      </ol>

      <div class="card-footer-row">
        <div class="card-footer-left">
          <button class="btn btn-xs btn-soft btn-configure" type="button" data-stack-action="toggle-expand" data-stack-id="${escapeHtml(stack.id)}" aria-expanded="${isExpanded ? 'true' : 'false'}">
            <span>${isExpanded ? 'Hide details' : 'Details'}</span>
            <span class="configure-chevron">${iconChevron()}</span>
          </button>
          ${footerLeft}
        </div>
        <div class="conn-status-group">
          <span class="conn-status-label ${escapeHtml(phase)}">${escapeHtml(stackStatusText(stack, services))}</span>
          <button class="ios-switch ${isOn ? 'on' : ''}" type="button" role="switch"
            aria-checked="${isOn ? 'true' : 'false'}" aria-label="${isOn ? 'Stop' : 'Start'} the ${escapeHtml(stack.name)} stack"
            data-stack-action="toggle" data-stack-id="${escapeHtml(stack.id)}"
            title="${isOn ? 'Stop every service' : 'Start every service, in order'}"></button>
        </div>
      </div>

      <div class="card-details">
        ${stack.path ? `<div class="card-path-row"><span class="card-path" title="${escapeHtml(stack.path)}">${escapeHtml(stack.path)}</span></div>` : ''}
        <div class="card-actions">
          <div class="card-actions-left">
            ${isOn ? `<button class="btn btn-sm btn-soft" type="button" data-stack-action="restart" data-stack-id="${escapeHtml(stack.id)}">${iconRestart()}<span>Restart stack</span></button>` : ''}
            <button class="btn btn-sm btn-ghost" type="button" data-stack-action="add-service" data-stack-id="${escapeHtml(stack.id)}">${iconPlus()}<span>Add service</span></button>
            <button class="btn btn-sm btn-ghost" type="button" data-stack-action="settings" data-stack-id="${escapeHtml(stack.id)}">${iconSettings()}<span>Stack settings &amp; variables</span></button>
          </div>
          <div class="card-actions-right">
            <button class="icon-btn danger" type="button" data-stack-action="delete" data-stack-id="${escapeHtml(stack.id)}" title="Remove stack" aria-label="Remove stack">${iconTrash()}</button>
          </div>
        </div>
      </div>
    </article>`;
}

/**
 * Cards view: stand-alone projects render as before; services are grouped into one card per
 * stack, placed where the stack's first matching service would have been.
 */
function renderWorkspaceCardsHtml(list) {
  const q = (state.search || '').trim().toLowerCase();
  const out = [];
  const doneStacks = new Set();
  const loose = [];
  const flushLoose = () => {
    if (loose.length) out.push(renderCardsHtml(loose.splice(0)));
  };
  for (const p of list) {
    const stack = p.stackId ? findStack(p.stackId) : null;
    if (!stack) {
      loose.push(p);
      continue;
    }
    if (doneStacks.has(stack.id)) continue;
    doneStacks.add(stack.id);
    flushLoose();
    out.push(renderStackCardHtml(stack));
  }
  flushLoose();
  // Stacks found by their own name (or with no services yet) that no service brought in.
  for (const stack of state.stacks || []) {
    if (doneStacks.has(stack.id)) continue;
    const nameMatch = q && `${stack.name} ${stack.hostname}`.toLowerCase().includes(q);
    const empty = (stack.serviceIds || []).length === 0 && state.filter === 'all' && !q;
    if (nameMatch || empty) out.push(renderStackCardHtml(stack));
  }
  return out.join('');
}

function tableStackChipHtml(p) {
  const stack = p.stackId ? findStack(p.stackId) : null;
  if (!stack) return '';
  return `<span class="stack-chip-inline" title="Part of the ${escapeHtml(stack.name)} stack">${iconLayers()}${escapeHtml(stack.name)}</span>`;
}

async function handleStackAction(action, stackId, ev) {
  const stack = findStack(stackId);
  if (!stack) return;
  if (action === 'toggle-expand') {
    const key = `stack:${stackId}`;
    if (state.expandedCards.has(key)) state.expandedCards.delete(key);
    else state.expandedCards.add(key);
    renderProjects();
    return;
  }
  if (action === 'toggle') {
    const isOn = ['running', 'starting', 'partial'].includes(stack.status);
    if (isOn) {
      await apiRequest(`/api/stacks/${encodeURIComponent(stackId)}/stop`, { method: 'POST' });
      return;
    }
    if (ev && (ev.ctrlKey || ev.metaKey)) {
      const primary = state.projects.find((p) => p.id === stack.primaryServiceId);
      if (primary && typeof openWhenReady === 'function') openWhenReady(primary);
    }
    const first = state.projects.find((p) => p.id === (stack.serviceIds || [])[0]);
    if (first) selectLogProject(first.id);
    const res = await apiRequest(`/api/stacks/${encodeURIComponent(stackId)}/start`, { method: 'POST' });
    if (res && res.ok === false && Array.isArray(res.problems) && res.problems.length && !res.cancelled) {
      showToast(res.problems.join(' '), 'error');
    }
    return;
  }
  if (action === 'restart') {
    const res = await apiRequest(`/api/stacks/${encodeURIComponent(stackId)}/restart`, { method: 'POST' });
    if (res && res.ok === false && res.problems && res.problems.length) showToast(res.problems.join(' '), 'error');
    return;
  }
  if (action === 'add-service') {
    openAddModal('single');
    setAddTarget(stackId);
    return;
  }
  if (action === 'settings') {
    openStackModal(stackId);
    return;
  }
  if (action === 'delete') {
    await deleteStackFlow(stack);
  }
}

async function deleteStackFlow(stack) {
  const count = (stack.serviceIds || []).length;
  // The dialog is removed before it resolves, so remember the box while it is open.
  let keep = true;
  const onChange = (e) => {
    if (e.target && e.target.id === 'confirm-keep-services') keep = e.target.checked;
  };
  document.addEventListener('change', onChange, true);
  const ok = await confirmDialog({
    title: `Remove the ${stack.name} stack?`,
    message: `Portly stops its ${count} service${count === 1 ? '' : 's'}. Choose whether to keep them as separate projects. Files on disk are not touched.`,
    detailsHtml:
      '<label class="checkbox-row"><input id="confirm-keep-services" type="checkbox" checked /><span>Keep the services as separate projects</span></label>',
    confirmLabel: 'Remove stack',
    danger: true
  });
  document.removeEventListener('change', onChange, true);
  if (!ok) return;
  await apiRequest(`/api/stacks/${encodeURIComponent(stack.id)}${keep ? '?keepServices=1' : ''}`, { method: 'DELETE' });
  showToast(`Removed the ${stack.name} stack.`);
  await refreshAll();
}

async function refreshAll() {
  await loadStacks();
  await loadProjects();
}

// ---------------------------------------------------------------- SSE

function stacksUiBindSse(sse) {
  const upsertStack = (stack) => {
    if (!stack || !stack.id) return;
    const list = state.stacks || (state.stacks = []);
    const idx = list.findIndex((s) => s.id === stack.id);
    if (idx >= 0) list[idx] = stack;
    else list.push(stack);
  };
  let renderTimer = null;
  const scheduleRender = () => {
    if (document.hidden) {
      state.needsFullRender = true;
      return;
    }
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderProjects();
    }, 60);
  };
  sse.addEventListener('stack-status', (ev) => {
    try {
      upsertStack(JSON.parse(ev.data));
      scheduleRender();
    } catch {
      // ignore
    }
  });
  sse.addEventListener('stack-deleted', (ev) => {
    try {
      const { id } = JSON.parse(ev.data);
      state.stacks = (state.stacks || []).filter((s) => s.id !== id);
      scheduleRender();
    } catch {
      // ignore
    }
  });
  sse.addEventListener('projects-refresh', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      if (Array.isArray(payload.projects)) state.projects = payload.projects;
      if (Array.isArray(payload.stacks)) state.stacks = payload.stacks;
      scheduleRender();
    } catch {
      // ignore
    }
  });
  sse.addEventListener('named-urls', (ev) => {
    try {
      stacksUi.namedUrlStatus = JSON.parse(ev.data);
      syncNamedUrlSettingsUi();
    } catch {
      // ignore
    }
  });
}

// ---------------------------------------------------------------- env editor

/**
 * An editor for one owner's variables (a project or a stack). Changes stay in memory until
 * save() is called by the surrounding form.
 */
function createEnvEditor(container, ownerId, { ownerLabel = 'this project' } = {}) {
  const ed = {
    ownerId,
    data: null,
    current: 'Dev',
    dirty: false,
    revealed: new Set(),
    loadError: null
  };

  function rowsOf(profile) {
    if (!ed.data.profiles[profile]) ed.data.profiles[profile] = [];
    return ed.data.profiles[profile];
  }

  function render() {
    if (ed.loadError) {
      container.innerHTML = `<div class="form-error">${escapeHtml(ed.loadError)}</div>`;
      return;
    }
    if (!ed.data) {
      container.innerHTML = '<div class="field-hint">Loading variables…</div>';
      return;
    }
    const profiles = Object.keys(ed.data.profiles);
    const rows = rowsOf(ed.current);
    container.innerHTML = `
      <div class="env-editor">
        <div class="env-toolbar">
          <label class="env-profile-label" for="env-profile-${escapeHtml(ownerId)}">Profile</label>
          <select id="env-profile-${escapeHtml(ownerId)}" class="env-profile-select" data-env="profile">
            ${profiles.map((n) => `<option value="${escapeHtml(n)}" ${n === ed.current ? 'selected' : ''}>${escapeHtml(n)}${n === ed.data.activeProfile ? ' (used on start)' : ''}</option>`).join('')}
          </select>
          ${ed.current !== ed.data.activeProfile ? `<button class="btn btn-xs btn-soft" type="button" data-env="use">Use this profile</button>` : ''}
          <span class="env-toolbar-spacer"></span>
          <span class="env-new-profile hidden" data-env-wrap="new">
            <input type="text" class="env-new-profile-input" placeholder="Test" maxlength="40" aria-label="New profile name" />
            <button class="btn btn-xs btn-soft" type="button" data-env="create-profile">Add</button>
          </span>
          <button class="btn btn-xs btn-ghost" type="button" data-env="new-profile">${iconPlus()}<span>New profile</span></button>
          ${profiles.length > 1 ? `<button class="btn btn-xs btn-ghost" type="button" data-env="delete-profile" title="Delete the ${escapeHtml(ed.current)} profile">Delete profile</button>` : ''}
        </div>
        <div class="env-rows" role="table" aria-label="Variables in ${escapeHtml(ed.current)}">
          ${rows.length === 0 ? `<div class="env-empty">No variables in ${escapeHtml(ed.current)} yet.</div>` : ''}
          ${rows
            .map(
              (r, i) => `
            <div class="env-row" role="row" data-index="${i}">
              <input class="env-key" type="text" value="${escapeHtml(r.key)}" placeholder="API_KEY" spellcheck="false" autocomplete="off" aria-label="Variable name" data-env-field="key" />
              <input class="env-value" type="${ed.revealed.has(i) ? 'text' : 'password'}" value="${escapeHtml(r.value)}" placeholder="value" spellcheck="false" autocomplete="off" aria-label="Value of ${escapeHtml(r.key || 'variable')}" data-env-field="value" />
              <button class="icon-btn" type="button" data-env="reveal" data-index="${i}" title="${ed.revealed.has(i) ? 'Hide' : 'Show'} value" aria-label="${ed.revealed.has(i) ? 'Hide' : 'Show'} value" aria-pressed="${ed.revealed.has(i) ? 'true' : 'false'}">${iconEye()}</button>
              <button class="icon-btn danger" type="button" data-env="remove" data-index="${i}" title="Remove" aria-label="Remove ${escapeHtml(r.key || 'variable')}">${iconX()}</button>
            </div>`
            )
            .join('')}
        </div>
        <div class="env-actions">
          <button class="btn btn-xs btn-soft" type="button" data-env="add-row">${iconPlus()}<span>Add variable</span></button>
          ${(ed.data.envFiles || [])
            .map((f) => `<button class="btn btn-xs btn-ghost" type="button" data-env="import" data-file="${escapeHtml(f)}" title="Copy the variables in ${escapeHtml(f)} into ${escapeHtml(ed.current)}">Import ${escapeHtml(f)}</button>`)
            .join('')}
        </div>
        <div class="field-hint">
          Added when ${escapeHtml(ownerLabel)} starts. Values stay ${ed.data.encrypted ? 'encrypted ' : ''}on this computer and never go into config exports or logs.
          Use <code>\${NAME}</code> to reuse a value, such as <code>\${PORTLY_API_URL}</code> for a service called "api". Portly always sets <code>PORT</code>.
          Tip: paste several <code>KEY=value</code> lines into a name box.
        </div>
      </div>`;
  }

  function readInputs() {
    const rows = rowsOf(ed.current);
    container.querySelectorAll('.env-row').forEach((rowEl) => {
      const i = Number(rowEl.dataset.index);
      if (!rows[i]) return;
      rows[i].key = rowEl.querySelector('[data-env-field="key"]').value.trim();
      rows[i].value = rowEl.querySelector('[data-env-field="value"]').value;
    });
  }

  function mergeRows(incoming) {
    const rows = rowsOf(ed.current);
    let added = 0;
    for (const { key, value } of incoming) {
      const existing = rows.find((r) => r.key === key);
      if (existing) existing.value = value;
      else rows.push({ key, value });
      added += 1;
    }
    ed.dirty = true;
    return added;
  }

  container.addEventListener('input', () => {
    ed.dirty = true;
  });

  container.addEventListener('paste', (e) => {
    const input = e.target.closest('[data-env-field="key"]');
    if (!input) return;
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if (!text || !/\n/.test(text) || !/=/.test(text)) return;
    e.preventDefault();
    readInputs();
    const parsed = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim().replace(/^export\s+/, '');
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      let value = line.slice(eq + 1).trim();
      if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
      parsed.push({ key: line.slice(0, eq).trim(), value });
    }
    const rows = rowsOf(ed.current);
    const i = Number(input.closest('.env-row').dataset.index);
    if (rows[i] && !rows[i].key && !rows[i].value) rows.splice(i, 1);
    const n = mergeRows(parsed);
    render();
    showToast(`Added ${n} variable${n === 1 ? '' : 's'}. Save to keep them.`);
  });

  container.addEventListener('change', (e) => {
    if (e.target.matches('[data-env="profile"]')) {
      readInputs();
      ed.current = e.target.value;
      ed.revealed.clear();
      render();
    }
  });

  container.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.env-new-profile-input')) {
      e.preventDefault();
      container.querySelector('[data-env="create-profile"]').click();
    }
  });

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-env]');
    if (!btn || btn.tagName === 'SELECT') return;
    const act = btn.dataset.env;
    readInputs();
    const rows = rowsOf(ed.current);
    if (act === 'add-row') {
      rows.push({ key: '', value: '' });
      ed.dirty = true;
      render();
      const inputs = container.querySelectorAll('[data-env-field="key"]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    } else if (act === 'remove') {
      rows.splice(Number(btn.dataset.index), 1);
      ed.revealed.clear();
      ed.dirty = true;
      render();
    } else if (act === 'reveal') {
      const i = Number(btn.dataset.index);
      if (ed.revealed.has(i)) ed.revealed.delete(i);
      else ed.revealed.add(i);
      render();
    } else if (act === 'use') {
      ed.data.activeProfile = ed.current;
      ed.dirty = true;
      render();
    } else if (act === 'new-profile') {
      const wrap = container.querySelector('[data-env-wrap="new"]');
      wrap.classList.remove('hidden');
      btn.classList.add('hidden');
      wrap.querySelector('input').focus();
    } else if (act === 'create-profile') {
      const input = container.querySelector('.env-new-profile-input');
      const name = input.value.trim();
      if (!/^[A-Za-z0-9 _.-]{1,40}$/.test(name)) {
        showToast('Use up to 40 letters, numbers, spaces, dots, dashes or underscores.', 'error');
        input.focus();
        return;
      }
      if (ed.data.profiles[name]) {
        showToast(`There's already a ${name} profile.`, 'error');
        return;
      }
      // A new profile starts as a copy of the one on screen, which is what people usually want.
      ed.data.profiles[name] = rows.map((r) => ({ ...r }));
      ed.current = name;
      ed.dirty = true;
      render();
    } else if (act === 'delete-profile') {
      if (Object.keys(ed.data.profiles).length < 2) return;
      delete ed.data.profiles[ed.current];
      if (ed.data.activeProfile === ed.current) ed.data.activeProfile = Object.keys(ed.data.profiles)[0];
      ed.current = ed.data.activeProfile;
      ed.dirty = true;
      render();
    } else if (act === 'import') {
      try {
        const res = await apiRequest(`/api/env/${encodeURIComponent(ownerId)}/import-file`, {
          method: 'POST',
          body: JSON.stringify({ file: btn.dataset.file })
        });
        const n = mergeRows(res.vars || []);
        render();
        showToast(`Copied ${n} variable${n === 1 ? '' : 's'} from ${btn.dataset.file} into ${ed.current}. Save to keep them.`);
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  });

  ed.load = async () => {
    ed.data = null;
    ed.loadError = null;
    render();
    try {
      ed.data = await apiRequest(`/api/env/${encodeURIComponent(ownerId)}`);
      ed.current = ed.data.activeProfile;
      ed.dirty = false;
    } catch (err) {
      ed.loadError = `Couldn't load variables: ${err.message}`;
    }
    render();
  };

  ed.save = async () => {
    if (!ed.data || !ed.dirty) return false;
    readInputs();
    for (const name of Object.keys(ed.data.profiles)) {
      ed.data.profiles[name] = ed.data.profiles[name].filter((r) => r.key || r.value);
    }
    ed.data = await apiRequest(`/api/env/${encodeURIComponent(ownerId)}`, {
      method: 'PUT',
      body: JSON.stringify({ activeProfile: ed.data.activeProfile, profiles: ed.data.profiles })
    });
    if (!ed.data.profiles[ed.current]) ed.current = ed.data.activeProfile;
    ed.dirty = false;
    render();
    return true;
  };

  ed.load();
  return ed;
}

// ---------------------------------------------------------------- add / edit project modal

function setAddTarget(stackId) {
  stacksUi.addToStackId = stackId || null;
  const stack = stackId ? findStack(stackId) : null;
  if (stack) {
    els.modalTitle.textContent = `Add a service to ${stack.name}`;
    els.modalTabsWrap.classList.add('hidden');
    els.btnSubmitSingle.textContent = 'Add service';
  }
  renderServiceFields(null, stack);
}

/** Called by openAddModal in app.js. */
function stacksUiOnOpenAdd() {
  stacksUi.addToStackId = null;
  stacksUi.editEnv = null;
  renderServiceFields(null, null);
  const envBox = document.getElementById('project-env-section');
  if (envBox) envBox.classList.add('hidden');
}

/** Called by openEditModal in app.js. */
function stacksUiOnOpenEdit(project) {
  stacksUi.addToStackId = null;
  const stack = project.stackId ? findStack(project.stackId) : null;
  renderServiceFields(project, stack);
  const envBox = document.getElementById('project-env-section');
  const envMount = document.getElementById('project-env-editor');
  if (envBox && envMount) {
    envBox.classList.remove('hidden');
    envBox.open = Boolean(project.env && project.env.count > 0);
    const fresh = envMount.cloneNode(false); // drop listeners from the last project
    envMount.replaceWith(fresh);
    stacksUi.editEnv = createEnvEditor(fresh, project.id, { ownerLabel: project.name });
    const summary = document.getElementById('project-env-summary');
    if (summary) summary.textContent = envSummaryText(project.env);
  }
}

function envSummaryText(env) {
  if (!env || !env.count) return 'None yet';
  return `${env.count} in ${env.activeProfile}${env.profileNames && env.profileNames.length > 1 ? ` (${env.profileNames.length} profiles)` : ''}`;
}

function renderServiceFields(project, stack) {
  const mount = document.getElementById('project-service-fields');
  if (!mount) return;
  const hostname = project ? project.hostname || '' : '';
  const placeholder = stack ? `name.${stack.hostname}` : 'my-app';
  const siblings = stack ? stackServices(stack).filter((s) => !project || s.id !== project.id) : [];
  const after = new Set(project && Array.isArray(project.startAfter) ? project.startAfter : []);
  const kind = project && project.kind === 'worker' ? 'worker' : 'server';
  mount.innerHTML = `
    <div class="form-row-2">
      <div class="form-group">
        <label for="input-project-hostname">Web address <span class="muted">(optional)</span></label>
        <div class="hostname-input">
          <input id="input-project-hostname" type="text" value="${escapeHtml(hostname)}" placeholder="${escapeHtml(placeholder)}" spellcheck="false" autocomplete="off" />
          <span class="hostname-suffix">${escapeHtml(proxySuffix())}</span>
        </div>
        <div class="field-hint">${stacksUi.namedUrlStatus.running ? 'Open the app at this address instead of a port number.' : 'Named URLs are off. Turn them on in Settings.'}</div>
      </div>
      ${
        stack
          ? `<div class="form-group">
        <label for="input-service-kind">Type</label>
        <select id="input-service-kind">
          <option value="server" ${kind === 'server' ? 'selected' : ''}>Web server (gets a port)</option>
          <option value="worker" ${kind === 'worker' ? 'selected' : ''}>Worker (no port, e.g. queue or scheduler)</option>
        </select>
      </div>`
          : ''
      }
    </div>
    ${
      stack && siblings.length
        ? `<fieldset class="form-group start-after-group">
      <legend>Start after</legend>
      <div class="start-after-options">
        ${siblings
          .map(
            (s) => `<label class="checkbox-row"><input type="checkbox" name="start-after" value="${escapeHtml(s.id)}" ${after.has(s.id) ? 'checked' : ''} /><span>${escapeHtml(s.name)}</span></label>`
          )
          .join('')}
      </div>
      <div class="field-hint">This service starts once the ones ticked here answer on their port (workers: once they're up).</div>
    </fieldset>`
        : ''
    }`;
}

/** Extra fields for POST/PUT /api/projects from the modal. */
function stacksUiCollectPayload(isEdit) {
  const out = {};
  const host = document.getElementById('input-project-hostname');
  if (host && (host.value.trim() || isEdit)) {
    if (host.value.trim()) out.hostname = host.value.trim();
  }
  const kindSel = document.getElementById('input-service-kind');
  if (kindSel) out.kind = kindSel.value;
  const boxes = document.querySelectorAll('#project-service-fields input[name="start-after"]');
  if (boxes.length) out.startAfter = Array.from(boxes).filter((b) => b.checked).map((b) => b.value);
  if (!isEdit && stacksUi.addToStackId) out.stackId = stacksUi.addToStackId;
  return out;
}

/** Called after the project was saved; stores its variables if they changed. */
async function stacksUiAfterSave(projectId) {
  const ed = stacksUi.editEnv;
  if (ed && ed.ownerId === projectId && ed.dirty) {
    await ed.save();
    showToast('Environment variables saved. They apply the next time it starts.');
  }
  if (stacksUi.addToStackId) {
    stacksUi.addToStackId = null;
  }
  await loadStacks();
}

// ---------------------------------------------------------------- new stack (Add modal tab)

function stackFormEls() {
  return {
    form: document.getElementById('stack-form'),
    path: document.getElementById('input-stack-path'),
    name: document.getElementById('input-stack-name'),
    browse: document.getElementById('btn-stack-browse'),
    find: document.getElementById('btn-stack-find'),
    list: document.getElementById('stack-services-list'),
    note: document.getElementById('stack-suggest-note'),
    error: document.getElementById('stack-form-error'),
    submit: document.getElementById('btn-submit-stack'),
    cancel: document.getElementById('btn-cancel-stack'),
    addRow: document.getElementById('btn-stack-add-row')
  };
}

function resetStackForm() {
  const f = stackFormEls();
  if (!f.form) return;
  f.form.reset();
  stacksUi.suggestion = { services: [] };
  f.error.classList.add('hidden');
  f.note.textContent = '';
  renderStackServiceRows();
}

function readStackRows() {
  const f = stackFormEls();
  const svcs = stacksUi.suggestion ? stacksUi.suggestion.services : [];
  f.list.querySelectorAll('.stack-svc-row').forEach((row) => {
    const i = Number(row.dataset.index);
    const s = svcs[i];
    if (!s) return;
    s.name = row.querySelector('[data-f="name"]').value.trim();
    s.path = row.querySelector('[data-f="path"]').value.trim();
    s.command = row.querySelector('[data-f="command"]').value.trim();
    s.kind = row.querySelector('[data-f="kind"]').value;
    s.startAfter = Array.from(row.querySelectorAll('[data-f="after"]:checked')).map((c) => c.value);
  });
}

function renderStackServiceRows() {
  const f = stackFormEls();
  const svcs = stacksUi.suggestion ? stacksUi.suggestion.services : [];
  if (!svcs.length) {
    f.list.innerHTML = '<div class="env-empty">Pick the folder that holds your app, then press <strong>Find services</strong>. Portly reads Procfiles, workspaces, Docker Compose files and folders such as <code>frontend/</code> and <code>api/</code>.</div>';
    f.submit.disabled = true;
    return;
  }
  f.submit.disabled = false;
  f.list.innerHTML = svcs
    .map((s, i) => {
      const others = svcs.filter((o, j) => j !== i && o.name);
      return `
      <div class="stack-svc-row" data-index="${i}">
        <div class="stack-svc-head">
          <span class="stack-svc-step">${i + 1}</span>
          <input data-f="name" type="text" value="${escapeHtml(s.name || '')}" aria-label="Service name" placeholder="api" />
          <select data-f="kind" aria-label="Type of ${escapeHtml(s.name || 'service')}">
            <option value="server" ${s.kind !== 'worker' ? 'selected' : ''}>Web server</option>
            <option value="worker" ${s.kind === 'worker' ? 'selected' : ''}>Worker</option>
          </select>
          <button class="icon-btn danger" type="button" data-stack-row="remove" data-index="${i}" title="Leave this service out" aria-label="Remove ${escapeHtml(s.name || 'service')}">${iconX()}</button>
        </div>
        <div class="stack-svc-grid">
          <label>Folder<input data-f="path" type="text" value="${escapeHtml(s.path || '')}" spellcheck="false" /></label>
          <label>Start command<input data-f="command" type="text" value="${escapeHtml(s.command || '')}" spellcheck="false" /></label>
        </div>
        ${
          others.length
            ? `<div class="stack-svc-after"><span>Start after:</span>${others
                .map(
                  (o) => `<label class="checkbox-row"><input type="checkbox" data-f="after" value="${escapeHtml(o.name)}" ${(s.startAfter || []).includes(o.name) ? 'checked' : ''} /><span>${escapeHtml(o.name)}</span></label>`
                )
                .join('')}</div>`
            : ''
        }
      </div>`;
    })
    .join('');
}

async function findStackServices() {
  const f = stackFormEls();
  f.error.classList.add('hidden');
  const p = f.path.value.trim();
  if (!p) {
    f.error.textContent = "Choose the stack's main folder first.";
    f.error.classList.remove('hidden');
    return;
  }
  f.find.disabled = true;
  f.find.textContent = 'Looking…';
  try {
    const res = await apiRequest('/api/stacks/suggest', { method: 'POST', body: JSON.stringify({ path: p }) });
    stacksUi.suggestion = res;
    if (!f.name.value.trim()) f.name.value = res.name || '';
    const sourceLabel = {
      'Procfile.dev': 'Found in Procfile.dev.',
      Procfile: 'Found in Procfile.',
      workspaces: 'Found in your workspace packages.',
      folders: 'Found in sub-folders.',
      single: ''
    }[res.source];
    const label = sourceLabel !== undefined ? sourceLabel : res.source ? `Found in ${res.source}.` : '';
    f.note.textContent = res.services.length
      ? [label, ...(res.notes || []), 'Check the order and commands, then create the stack.'].filter(Boolean).join(' ')
      : 'No services found here. Add them one by one below.';
    renderStackServiceRows();
  } catch (err) {
    f.error.textContent = err.message;
    f.error.classList.remove('hidden');
  } finally {
    f.find.disabled = false;
    f.find.textContent = 'Find services';
  }
}

async function submitStackForm(e) {
  e.preventDefault();
  const f = stackFormEls();
  readStackRows();
  f.error.classList.add('hidden');
  const services = (stacksUi.suggestion ? stacksUi.suggestion.services : []).map((s) => ({
    name: s.name,
    path: s.path,
    command: s.command,
    kind: s.kind,
    startAfter: s.startAfter || []
  }));
  const name = f.name.value.trim();
  if (!name) {
    f.error.textContent = 'Give the stack a name.';
    f.error.classList.remove('hidden');
    f.name.focus();
    return;
  }
  f.submit.disabled = true;
  try {
    const res = await apiRequest('/api/stacks', {
      method: 'POST',
      body: JSON.stringify({ name, path: f.path.value.trim(), services })
    });
    closeModal();
    showToast(`Created the ${res.stack.name} stack with ${res.services.length} service${res.services.length === 1 ? '' : 's'}.`);
    await refreshAll();
    if (res.services[0]) selectLogProject(res.services[0].id);
  } catch (err) {
    f.error.textContent = err.message;
    f.error.classList.remove('hidden');
  } finally {
    f.submit.disabled = false;
  }
}

// ---------------------------------------------------------------- stack settings modal

function openStackModal(stackId) {
  const stack = findStack(stackId);
  const modal = document.getElementById('stack-modal');
  if (!stack || !modal) return;
  modal.dataset.stackId = stackId;
  document.getElementById('stack-modal-title').textContent = `${stack.name} settings`;
  document.getElementById('input-stack-edit-name').value = stack.name;
  document.getElementById('input-stack-edit-hostname').value = stack.hostname || '';
  document.getElementById('stack-edit-hostname-suffix').textContent = proxySuffix();
  const sel = document.getElementById('input-stack-primary');
  const web = stackServices(stack).filter((s) => s.kind !== 'worker');
  sel.innerHTML =
    `<option value="">Automatic (${escapeHtml((web[web.length - 1] || { name: 'none' }).name)})</option>` +
    web.map((s) => `<option value="${escapeHtml(s.id)}" ${!stack.primaryServiceIsDefault && s.id === stack.primaryServiceId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('');
  document.getElementById('stack-modal-error').classList.add('hidden');
  const mount = document.getElementById('stack-env-editor');
  const fresh = mount.cloneNode(false);
  mount.replaceWith(fresh);
  stacksUi.stackEnv = createEnvEditor(fresh, stackId, { ownerLabel: `any service in ${stack.name}` });
  rememberFocusFor(modal);
  modal.classList.remove('hidden');
  document.getElementById('input-stack-edit-name').focus();
}

function closeStackModal() {
  const modal = document.getElementById('stack-modal');
  if (!modal || modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  restoreFocusFor(modal);
}

async function submitStackModal(e) {
  e.preventDefault();
  const modal = document.getElementById('stack-modal');
  const stackId = modal.dataset.stackId;
  const errBox = document.getElementById('stack-modal-error');
  errBox.classList.add('hidden');
  try {
    const updated = await apiRequest(`/api/stacks/${encodeURIComponent(stackId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: document.getElementById('input-stack-edit-name').value.trim(),
        hostname: document.getElementById('input-stack-edit-hostname').value.trim(),
        primaryServiceId: document.getElementById('input-stack-primary').value || null
      })
    });
    if (stacksUi.stackEnv && stacksUi.stackEnv.dirty) await stacksUi.stackEnv.save();
    closeStackModal();
    showToast(`Saved ${updated.name}.`);
    await refreshAll();
  } catch (err) {
    errBox.textContent = err.message;
    errBox.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------- settings: named URLs

function syncNamedUrlSettingsUi() {
  const toggle = document.getElementById('input-named-urls');
  const port = document.getElementById('input-proxy-port');
  const status = document.getElementById('named-urls-status');
  if (!toggle || !port || !status) return;
  const s = stacksUi.namedUrlStatus || {};
  toggle.checked = Boolean(s.enabled);
  if (document.activeElement !== port) port.value = s.port || 1355;
  port.disabled = !s.enabled;
  status.className = `named-urls-status ${s.error ? 'error' : s.running ? 'ok' : ''}`;
  status.textContent = s.error
    ? s.error
    : s.running
      ? `On. Example: http://my-app.localhost${Number(s.port) === 80 ? '' : `:${s.port}`}`
      : 'Off. Projects open at localhost:<port>.';
}

async function applyNamedUrlSettings() {
  const toggle = document.getElementById('input-named-urls');
  const port = document.getElementById('input-proxy-port');
  try {
    const saved = await apiRequest('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ namedUrls: toggle.checked, proxyPort: Number(port.value) || 1355 })
    });
    if (saved.namedUrlStatus) stacksUi.namedUrlStatus = saved.namedUrlStatus;
    syncNamedUrlSettingsUi();
    if (saved.namedUrlStatus && saved.namedUrlStatus.error) showToast(saved.namedUrlStatus.error, 'error');
    await refreshAll();
  } catch (err) {
    showToast(err.message, 'error');
    syncNamedUrlSettingsUi();
  }
}

function stacksUiOnSettingsOpen() {
  syncNamedUrlSettingsUi();
}

// ---------------------------------------------------------------- init

function stacksUiInit() {
  // Stack actions on cards.
  els.projectsGrid.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-stack-action]');
    if (!target) return;
    try {
      await handleStackAction(target.dataset.stackAction, target.dataset.stackId, e);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // New stack tab.
  const f = stackFormEls();
  if (f.form) {
    f.form.addEventListener('submit', submitStackForm);
    f.find.addEventListener('click', findStackServices);
    f.path.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        findStackServices();
      }
    });
    f.cancel.addEventListener('click', closeModal);
    f.browse.addEventListener('click', async () => {
      try {
        const picked = await apiRequest('/api/pick-folder', { method: 'POST' });
        if (picked && picked.path) {
          f.path.value = picked.path;
          findStackServices();
        }
      } catch (err) {
        showToast("Couldn't open the folder picker. Paste the path instead.", 'error');
      }
    });
    f.addRow.addEventListener('click', () => {
      readStackRows();
      if (!stacksUi.suggestion) stacksUi.suggestion = { services: [] };
      stacksUi.suggestion.services.push({ name: '', path: f.path.value.trim(), command: '', kind: 'server', startAfter: [] });
      renderStackServiceRows();
      const inputs = f.list.querySelectorAll('[data-f="name"]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
    f.list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-stack-row="remove"]');
      if (!btn) return;
      readStackRows();
      const removed = stacksUi.suggestion.services.splice(Number(btn.dataset.index), 1)[0];
      for (const s of stacksUi.suggestion.services) {
        s.startAfter = (s.startAfter || []).filter((n) => n !== removed.name);
      }
      renderStackServiceRows();
    });
    // Names are used by the "start after" boxes, so redraw when one changes.
    f.list.addEventListener('change', (e) => {
      if (e.target.matches('[data-f="name"]')) {
        const before = stacksUi.suggestion.services.map((s) => s.name);
        readStackRows();
        stacksUi.suggestion.services.forEach((s) => {
          s.startAfter = (s.startAfter || []).map((n) => {
            const i = before.indexOf(n);
            return i >= 0 ? stacksUi.suggestion.services[i].name : n;
          });
        });
        renderStackServiceRows();
      }
    });
  }

  // Stack settings modal.
  const modal = document.getElementById('stack-modal');
  if (modal) {
    document.getElementById('stack-form-edit').addEventListener('submit', submitStackModal);
    document.getElementById('stack-modal-close').addEventListener('click', closeStackModal);
    document.getElementById('btn-cancel-stack-edit').addEventListener('click', closeStackModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeStackModal();
    });
  }

  // Named URL settings apply at once (they restart the proxy).
  const toggle = document.getElementById('input-named-urls');
  const applyBtn = document.getElementById('btn-apply-proxy-port');
  if (toggle) toggle.addEventListener('change', applyNamedUrlSettings);
  if (applyBtn) applyBtn.addEventListener('click', applyNamedUrlSettings);
}
