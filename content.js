// Shared UI and delete flow. Everything specific to one website comes from ChatPurgeSite,
// defined by the matching file in sites/ (loaded first, see manifest.json):
//   rowSelector, linkSelector   sidebar chat links / any chat link
//   home                        where to go when the open chat is deleted
//   idFromPath(path)            chat id in a URL path, or null
//   kind(id)                    'chat' or another item name, for the confirmation
//   findToolbarSlot()           { slot, row } beside the user's name, or null
//   mountToolbar(slot, panel)
//   request(id)                 the delete request (a fetch Response)
//   isFatal(id, status)         true if the batch should stop
// Optional: isAlreadyGone(id, res) (a failed response that means "already deleted"),
//           checkboxHost(link), themeColors(ref), beforeBatch(), afterBatch().
(() => {
  'use strict';
  const site = globalThis.ChatPurgeSite;
  if (!site) return;

  const DELAY_MS = 350; // between deletions, to stay under rate limits
  const CONFIRM_LIST = 8;

  const state = { active: false, busy: false, selected: new Set(), anchorId: null };
  let statusTimer = null;
  let profileRow = null;
  let profileSlot = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Only links to this site count, and only their path (not a query string or another site's URL).
  const idOf = (a) => (a.origin === location.origin ? site.idFromPath(a.pathname) : null);
  const rows = () => [...document.querySelectorAll(site.rowSelector)].filter((a) => idOf(a) && !a.closest('.cmd-gone'));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  // ---- Toolbar and status bar
  const SVG = 'viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const panel = document.createElement('div');
  panel.className = 'cmd-panel';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Chat selection');
  panel.innerHTML = `
    <button type="button" class="cmd-btn cmd-icon cmd-all" aria-label="Select all chats" title="Select all chats">
      <svg class="cmd-i-all" ${SVG}><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 12.25l3 3 5-6"/></svg>
      <svg class="cmd-i-clear" ${SVG}><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 12h8"/></svg>
    </button>
    <button type="button" class="cmd-btn cmd-icon cmd-delete" disabled aria-label="Delete selected chats" title="Delete selected chats">
      <svg ${SVG}>
        <path d="M4 7h16"/><path d="M10 11v6M14 11v6"/>
        <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>
        <path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>
      </svg><span class="cmd-del-n"></span>
    </button>
    <button type="button" class="cmd-btn cmd-icon cmd-done" aria-label="Done" title="Done (Esc)">
      <svg ${SVG}><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <span class="cmd-sr cmd-count" role="status"></span>
    <span class="cmd-sr cmd-announce" role="status"></span>`;

  const ui = document.createElement('div');
  ui.className = 'cmd-bar cmd-floating';
  ui.innerHTML = '<div class="cmd-status"></div>';
  const $ = (sel) => panel.querySelector(sel) ?? ui.querySelector(sel);

  function trackProfileRow() {
    const found = site.findToolbarSlot();
    profileRow = found?.row ?? null;
    profileSlot = found?.slot ?? null;
    placeToolbar();
  }

  // Buttons go beside the user's name and status messages in a strip just above that row.
  // Without a slot, both share a small card at the sidebar's bottom-right. Nothing stays in the page while idle.
  function placeToolbar() {
    if (!state.active) {
      panel.remove();
      ui.remove();
      document.documentElement.style.removeProperty('--cmd-tick');
      return;
    }
    if (!ui.isConnected) document.body.append(ui);
    const r = profileSlot?.isConnected && profileRow?.isConnected ? profileRow.getBoundingClientRect() : null;
    if (r && r.width > 120 && r.height > 0) {
      if (panel.parentElement !== profileSlot) site.mountToolbar(profileSlot, panel);
      ui.classList.replace('cmd-floating', 'cmd-docked');
      ui.style.left = `${Math.round(r.left)}px`;
      ui.style.width = `${Math.round(r.width)}px`;
      ui.style.bottom = `${Math.round(innerHeight - r.top)}px`;
    } else {
      if (panel.parentElement !== ui) ui.prepend(panel);
      ui.classList.replace('cmd-docked', 'cmd-floating');
      ui.style.cssText = '';
      const nr = rows()[0]?.closest('nav, aside')?.getBoundingClientRect();
      if (nr && nr.width > 120) {
        ui.style.left = 'auto';
        ui.style.right = `${Math.round(innerWidth - nr.right + 12)}px`;
      }
    }
    syncTheme();
  }

  function syncTheme() {
    if (!site.themeColors) return;
    const { fg, bg } = site.themeColors(profileRow?.isConnected ? profileRow : rows()[0] ?? document.body);
    for (const el of [panel, ui]) {
      el.style.setProperty('--cmd-fg', fg);
      if (bg) el.style.setProperty('--cmd-bg', bg);
    }
    document.documentElement.style.setProperty('--cmd-tick', bg ?? '#fff');
  }

  function rowSelection() {
    const ids = rows().map(idOf);
    return { ids, all: ids.length > 0 && ids.every((id) => state.selected.has(id)) };
  }

  function status(msg, autoClearMs = 0, action = null) {
    clearTimeout(statusTimer);
    const el = $('.cmd-status');
    el.textContent = msg;
    // The strip is display:none when docked without a message, which hides it from screen readers.
    $('.cmd-announce').textContent = msg;
    ui.classList.toggle('cmd-has-status', !!msg);
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cmd-btn cmd-status-action';
      btn.textContent = action.label;
      btn.addEventListener('click', action.run);
      el.append(' ', btn);
    }
    if (autoClearMs) statusTimer = setTimeout(() => status(''), autoClearMs);
  }

  function setActive(on) {
    if (state.busy) return;
    state.active = on;
    if (on) {
      trackProfileRow();
    } else {
      state.selected.clear();
      state.anchorId = null;
      undecorate();
    }
    render();
  }

  function render() {
    ui.classList.toggle('cmd-on', state.active);
    placeToolbar();
    ui.classList.toggle('cmd-busy', state.busy);
    const n = state.selected.size;
    const delLabel = n ? `Delete ${plural(n, 'chat')}` : 'Delete selected chats';
    $('.cmd-count').textContent = `${n} selected`;
    $('.cmd-del-n').textContent = n ? String(n) : '';
    $('.cmd-delete').setAttribute('aria-label', delLabel);
    $('.cmd-delete').title = delLabel;
    $('.cmd-delete').disabled = n === 0 || state.busy;
    $('.cmd-all').disabled = state.busy;
    $('.cmd-done').disabled = state.busy;
    const allSelected = rowSelection().all;
    const allLabel = allSelected ? 'Clear selection' : 'Select all chats';
    $('.cmd-all').classList.toggle('cmd-all-on', allSelected);
    $('.cmd-all').setAttribute('aria-label', allLabel);
    $('.cmd-all').title = allLabel;
    decorate();
  }

  // ---- Checkboxes on sidebar rows
  function decorate() {
    if (!state.active) return;
    for (const a of rows()) {
      a.classList.add('cmd-row');
      const host = site.checkboxHost?.(a) ?? null;
      if (host) host.classList.add('cmd-slot-host');
      else a.classList.add('cmd-pad');
      const parent = host ?? a;
      if (!parent.querySelector(':scope > .cmd-check')) {
        const box = document.createElement('span');
        box.className = host ? 'cmd-check cmd-in-slot' : 'cmd-check';
        box.setAttribute('aria-hidden', 'true');
        parent.append(box); // append, not prepend: gentler on React's reconciliation
      }
      if (!a.hasAttribute('data-cmd-role')) {
        a.setAttribute('data-cmd-role', a.getAttribute('role') ?? '');
        a.setAttribute('role', 'checkbox');
      }
      const on = state.selected.has(idOf(a));
      a.classList.toggle('cmd-selected', on);
      a.setAttribute('aria-checked', String(on));
    }
  }

  function undecorate() {
    for (const a of document.querySelectorAll('a.cmd-row')) {
      a.classList.remove('cmd-row', 'cmd-selected', 'cmd-pad');
      a.removeAttribute('aria-checked');
      const role = a.getAttribute('data-cmd-role');
      if (role) a.setAttribute('role', role);
      else a.removeAttribute('role');
      a.removeAttribute('data-cmd-role');
      a.querySelectorAll('.cmd-check').forEach((box) => box.remove());
    }
    document.querySelectorAll('.cmd-slot-host').forEach((el) => el.classList.remove('cmd-slot-host'));
  }

  // The outermost wrapper that holds only this chat, so the whole row collapses, not just the link.
  function rowContainer(a) {
    let el = a;
    while (el.parentElement && el.parentElement !== document.body) {
      const p = el.parentElement;
      if (p.matches('nav, aside, ol, ul, [role="list"]')) break;
      if (p.querySelectorAll(site.linkSelector).length !== 1) break;
      if (p.querySelector('h1, h2, h3, h4, h5, h6')) break;
      el = p;
    }
    return el;
  }

  // False if hiding the row left a gap (the next row didn't move up).
  function markGone(id) {
    let collapsed = true;
    for (const a of document.querySelectorAll(site.rowSelector)) {
      if (idOf(a) !== id) continue;
      const list = rows();
      const next = list[list.indexOf(a) + 1];
      const before = next?.getBoundingClientRect().top;
      rowContainer(a).classList.add('cmd-gone');
      if (next?.isConnected && before !== undefined && Math.abs(next.getBoundingClientRect().top - before) < 1) {
        collapsed = false;
      }
    }
    return collapsed;
  }

  // ---- Input
  $('.cmd-done').addEventListener('click', () => setActive(false));
  $('.cmd-delete').addEventListener('click', deleteSelected);
  $('.cmd-all').addEventListener('click', () => {
    const { ids, all } = rowSelection();
    if (all) state.selected.clear();
    else ids.forEach((id) => state.selected.add(id));
    render();
  });
  $('.cmd-status').addEventListener('click', (e) => {
    if (!e.target.closest('button')) status('');
  });

  // While selecting, a click on a row toggles it instead of opening the chat or its menu.
  const swallow = (e) => {
    if (!state.active || !e.target.closest?.('a.cmd-row')) return false;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return true;
  };
  for (const type of ['pointerdown', 'mousedown', 'auxclick']) document.addEventListener(type, swallow, true);

  document.addEventListener('click', (e) => {
    if (!swallow(e) || state.busy) return;
    const id = idOf(e.target.closest('a.cmd-row'));
    if (!id) return;
    if (e.shiftKey && state.anchorId) {
      const ids = rows().map(idOf);
      const i = ids.indexOf(state.anchorId);
      const j = ids.indexOf(id);
      if (i > -1 && j > -1) ids.slice(Math.min(i, j), Math.max(i, j) + 1).forEach((x) => state.selected.add(x));
    } else if (state.selected.has(id)) {
      state.selected.delete(id);
    } else {
      state.selected.add(id);
    }
    state.anchorId = id;
    render();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && e.code === 'KeyD') {
      e.preventDefault();
      if (!e.repeat) setActive(!state.active);
    } else if (e.key === 'Escape' && state.active && !state.busy) {
      setActive(false);
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'cmd-toggle') setActive(!state.active);
  });

  addEventListener('resize', () => placeToolbar());

  // The sites re-render the sidebar and footer and lazy-load more chats, so re-apply on changes.
  let frameQueued = false;
  new MutationObserver(() => {
    if (!state.active || frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(() => {
      frameQueued = false;
      trackProfileRow();
      decorate();
    });
  }).observe(document.body, { childList: true, subtree: true });

  // ---- Deleting
  // Resolves true if the chat was already gone, false if this request deleted it.
  async function deleteOne(id, attempt = 0) {
    const res = await site.request(id);
    if (res.ok) return false;
    if (await site.isAlreadyGone?.(id, res)) return true;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(1500 * 2 ** attempt);
      return deleteOne(id, attempt + 1);
    }
    throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: site.isFatal(id, res.status) });
  }

  // Select all and Shift+click can reach rows that are out of view, so name what will be deleted.
  function confirmText(ids) {
    const titles = new Map(rows().map((a) => [idOf(a), a.querySelector('[data-row-label]') ?? a]));
    const counts = new Map([['chat', 0]]);
    for (const id of ids) counts.set(site.kind(id), (counts.get(site.kind(id)) ?? 0) + 1);
    const what = [...counts].filter(([, n]) => n).map(([kind, n]) => plural(n, kind)).join(' and ');
    const lines = ids.slice(0, CONFIRM_LIST).map((id) => {
      let title = (titles.get(id)?.textContent ?? '').replace(/\s+/g, ' ').trim() || '(no title)';
      if (title.length > 60) title = `${title.slice(0, 59)}…`;
      const kind = site.kind(id);
      return `• ${title}${kind === 'chat' ? '' : ` (${kind})`}`;
    });
    if (ids.length > CONFIRM_LIST) lines.push(`…and ${ids.length - CONFIRM_LIST} more`);
    return `Delete ${what}?\n\n${lines.join('\n')}\n\nThey can't be restored.`;
  }

  async function deleteSelected() {
    const ids = [...state.selected];
    if (!ids.length || state.busy || !confirm(confirmText(ids))) return;

    state.busy = true;
    render();
    site.beforeBatch?.();
    const openId = site.idFromPath(location.pathname);
    let deleted = 0;
    let alreadyGone = 0;
    let stoppedEarly = null;
    let gapsLeft = false;

    for (let i = 0; i < ids.length; i++) {
      status(`Deleting ${i + 1} of ${ids.length}…`);
      try {
        if (await deleteOne(ids[i])) alreadyGone++;
        deleted++;
        state.selected.delete(ids[i]);
        if (!markGone(ids[i])) gapsLeft = true;
      } catch (err) {
        console.warn('[ChatPurge]', ids[i], err);
        if (err.fatal) { stoppedEarly = err.message; break; }
      }
      if (i < ids.length - 1) await sleep(DELAY_MS);
    }

    const left = state.selected.size;
    const note = alreadyGone ? ` (${alreadyGone} already gone)` : '';
    if (stoppedEarly) {
      status(`Deleted ${deleted}. Stopped: ${stoppedEarly}. Reload the page and try again.`);
    } else if (left) {
      status(`Deleted ${deleted}${note}. ${left} couldn't be deleted and are still selected.`);
    } else if (gapsLeft) {
      status(`Deleted ${plural(deleted, 'chat')}${note}. Refresh to tidy the sidebar.`, 8000,
        { label: 'Refresh', run: () => location.reload() });
    } else {
      status(`Deleted ${plural(deleted, 'chat')}${note}.`, 2000);
    }
    render();

    // Stay busy until the site has refreshed its lists and any navigation has started.
    if (deleted) await site.afterBatch?.();
    if (openId && ids.includes(openId) && !state.selected.has(openId)) {
      location.assign(site.home);
    }
    state.busy = false;
    render();
  }

  render();
})();
