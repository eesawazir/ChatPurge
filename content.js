(() => {
  'use strict';
  if (window.__cmdLoaded) return;
  window.__cmdLoaded = true;

  // ---- Config ---------------------------------------------------------------
  const ID_RE = /\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const ROW_SELECTOR = 'nav a[href*="/c/"], aside a[href*="/c/"]';
  const DELAY_MS = 350;          // pause between deletions to stay under rate limits
  const TOKEN_TTL_MS = 5 * 60e3; // re-fetch the session token after 5 minutes

  // ---- State ----------------------------------------------------------------
  const state = { active: false, busy: false, selected: new Set(), anchorId: null };
  let cachedToken = null;
  let tokenTime = 0;
  let statusTimer = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const idOf = (a) => (a.getAttribute('href') || '').match(ID_RE)?.[1] ?? null;
  const rows = () =>
    [...document.querySelectorAll(ROW_SELECTOR)].filter((a) => idOf(a) && !a.closest('.cmd-gone'));

  // ---- "Select" button in the profile row ----------------------------------
  // The profile row has a trailing container (class "empty:hidden") that
  // ChatGPT keeps hidden while it's empty. We mount the button inside it.
  const PROFILE_BTN = 'button[aria-label="Open profile menu"]';
  const SLOT = ':scope > .empty\\:hidden';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cmd-trigger';
  trigger.title = 'Select chats (Alt+Shift+D)';
  trigger.innerHTML = `
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <path d="M4.75 8.25l2.25 2.25 4.25-4.75" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg><span>Select</span>`;
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation(); // never let the click reach the profile menu
    setActive(true);
  });

  function findProfileSlot() {
    let btn = document.querySelector(PROFILE_BTN);
    if (!btn) {
      // Non-English UI translates the aria-label; fall back to the menu
      // button that sits beside the avatar image.
      btn = [...document.querySelectorAll('nav button[aria-haspopup="menu"], aside button[aria-haspopup="menu"]')]
        .find((b) => b.parentElement?.querySelector('img.rounded-full'));
    }
    if (!btn) return null;
    let el = btn.parentElement;
    for (let depth = 0; el && el !== document.body && depth < 8; depth++, el = el.parentElement) {
      const slot = el.querySelector(SLOT);
      if (slot) return { slot, row: el };
    }
    return null;
  }

  let profileRow = null;
  let profileSlot = null;

  function mountTrigger() {
    const found = findProfileSlot();
    profileRow = found?.row ?? null;
    profileSlot = found?.slot ?? null;
    if (found && trigger.parentElement !== found.slot) found.slot.append(trigger);
    placeToolbar();
    // No slot found (sidebar closed, or markup changed): the toolbar icon
    // and Alt+Shift+D still work.
  }

  // While selecting, the buttons replace "Select" in the profile row's trailing
  // slot, so the avatar and name stay visible. Status messages go in a strip
  // just above the row (only while there is one). If the slot can't be found,
  // everything floats in the bottom-left corner instead.
  function placeToolbar() {
    if (!state.active) { panel.remove(); return; }
    const r = profileSlot?.isConnected && profileRow?.isConnected ? profileRow.getBoundingClientRect() : null;
    if (r && r.width > 120 && r.height > 0) {
      if (panel.parentElement !== profileSlot) profileSlot.append(panel);
      ui.classList.remove('cmd-floating');
      ui.classList.add('cmd-docked');
      ui.style.left = `${Math.round(r.left)}px`;
      ui.style.width = `${Math.round(r.width)}px`;
      ui.style.bottom = `${Math.round(innerHeight - r.top)}px`;
    } else {
      if (panel.parentElement !== ui) ui.prepend(panel);
      ui.classList.remove('cmd-docked');
      ui.classList.add('cmd-floating');
      ui.style.cssText = '';
    }
  }
  addEventListener('resize', () => placeToolbar());

  // ---- Toolbar (opened from the profile-row button, extension icon, or Alt+Shift+D)
  const SVG = 'viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const panel = document.createElement('div');
  panel.className = 'cmd-panel';
  panel.setAttribute('role', 'toolbar');
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
    </button>`;

  const ui = document.createElement('div');
  ui.className = 'cmd-bar cmd-floating';
  ui.innerHTML = `
    <span class="cmd-sr cmd-count" aria-live="polite"></span>
    <div class="cmd-status" role="status" aria-live="polite"></div>`;
  const $ = (sel) => panel.querySelector(sel) ?? ui.querySelector(sel);

  $('.cmd-done').addEventListener('click', () => setActive(false));
  $('.cmd-delete').addEventListener('click', deleteSelected);
  $('.cmd-all').addEventListener('click', () => {
    const ids = rows().map(idOf);
    const allSelected = ids.length && ids.every((id) => state.selected.has(id));
    if (allSelected) state.selected.clear();
    else ids.forEach((id) => state.selected.add(id));
    render();
  });

  function status(msg, autoClearMs = 0, action = null) {
    clearTimeout(statusTimer);
    const el = $('.cmd-status');
    el.textContent = msg;
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

  // Click a message to dismiss it (errors otherwise stay until the next action).
  $('.cmd-status').addEventListener('click', (e) => {
    if (!e.target.closest('button')) status('');
  });

  function setActive(on) {
    if (state.busy) return;
    state.active = on;
    if (!on) {
      state.selected.clear();
      state.anchorId = null;
      undecorate();
    }
    render();
  }

  function render() {
    ui.classList.toggle('cmd-on', state.active);
    trigger.hidden = state.active;
    placeToolbar();
    ui.classList.toggle('cmd-busy', state.busy);
    const n = state.selected.size;
    $('.cmd-count').textContent = `${n} selected`;
    const delLabel = n ? `Delete ${n} ${n === 1 ? 'chat' : 'chats'}` : 'Delete selected chats';
    $('.cmd-del-n').textContent = n ? String(n) : '';
    $('.cmd-delete').setAttribute('aria-label', delLabel);
    $('.cmd-delete').title = delLabel;
    $('.cmd-delete').disabled = n === 0 || state.busy;
    $('.cmd-all').disabled = state.busy;
    $('.cmd-done').disabled = state.busy;
    const ids = rows().map(idOf);
    const allSelected = ids.length > 0 && ids.every((id) => state.selected.has(id));
    const allLabel = allSelected ? 'Clear selection' : 'Select all chats';
    $('.cmd-all').classList.toggle('cmd-all-on', allSelected);
    $('.cmd-all').setAttribute('aria-label', allLabel);
    $('.cmd-all').title = allLabel;
    decorate();
  }

  // ---- Checkboxes on sidebar rows ------------------------------------------
  function decorate() {
    if (!state.active) return;
    for (const a of rows()) {
      a.classList.add('cmd-row');
      if (!a.querySelector(':scope > .cmd-check')) {
        const box = document.createElement('span');
        box.className = 'cmd-check';
        box.setAttribute('aria-hidden', 'true');
        a.append(box); // append (not prepend) is gentler on React's reconciliation
      }
      const on = state.selected.has(idOf(a));
      a.classList.toggle('cmd-selected', on);
      a.setAttribute('aria-checked', String(on));
    }
  }

  function undecorate() {
    document.querySelectorAll('a.cmd-row').forEach((a) => {
      a.classList.remove('cmd-row', 'cmd-selected');
      a.removeAttribute('aria-checked');
      a.querySelector(':scope > .cmd-check')?.remove();
    });
  }

  // Walk up from the link to the outermost wrapper that holds only this one chat,
  // so the whole row (link + menu button + spacing) collapses, not just the link.
  function rowContainer(a) {
    let el = a;
    while (el.parentElement && el.parentElement !== document.body) {
      const p = el.parentElement;
      if (p.matches('nav, aside, ol, ul, [role="list"]')) break;
      if (p.querySelectorAll('a[href*="/c/"]').length !== 1) break;
      if (p.querySelector('h1, h2, h3, h4, h5, h6')) break; // don't hide section headings
      el = p;
    }
    return el;
  }

  // Returns true if the row collapsed cleanly, false if a gap is left behind
  // (e.g. a virtualised list that positions rows with fixed offsets).
  function markGone(id) {
    let collapsed = true;
    document.querySelectorAll(ROW_SELECTOR).forEach((a) => {
      if (idOf(a) !== id) return;
      const list = rows();
      const next = list[list.indexOf(a) + 1];
      const before = next?.getBoundingClientRect().top;
      rowContainer(a).classList.add('cmd-gone');
      if (next && next.isConnected && before !== undefined) {
        const after = next.getBoundingClientRect().top;
        if (Math.abs(after - before) < 1) collapsed = false;
      }
    });
    return collapsed;
  }

  // In selection mode, clicks on a row toggle it instead of opening the chat.
  const swallow = (e) => {
    if (!state.active) return;
    if (!e.target.closest?.('a.cmd-row')) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };
  document.addEventListener('pointerdown', swallow, true);
  document.addEventListener('mousedown', swallow, true);

  document.addEventListener('click', (e) => {
    if (!state.active) return;
    const a = e.target.closest?.('a.cmd-row');
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (state.busy) return;

    const id = idOf(a);
    if (!id) return;

    if (e.shiftKey && state.anchorId) {
      // Shift+click selects the whole range between the last click and this one.
      const ids = rows().map(idOf);
      const i = ids.indexOf(state.anchorId);
      const j = ids.indexOf(id);
      if (i > -1 && j > -1) {
        const [from, to] = i < j ? [i, j] : [j, i];
        ids.slice(from, to + 1).forEach((x) => state.selected.add(x));
      }
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
      setActive(!state.active);
    } else if (e.key === 'Escape' && state.active && !state.busy) {
      setActive(false);
    }
  });

  // ChatGPT re-renders the sidebar constantly (and lazy-loads more chats on scroll).
  let queued = false;
  let mountQueued = false;
  new MutationObserver(() => {
    if (!mountQueued) {
      mountQueued = true;
      requestAnimationFrame(() => {
        mountQueued = false;
        mountTrigger(); // React re-renders the footer; put the button back if needed
      });
    }
    if (!state.active || queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      decorate();
    });
  }).observe(document.body, { childList: true, subtree: true });

  // ---- ChatGPT web API (same calls the site makes; unofficial) -------------
  async function getToken(force = false) {
    if (!force && cachedToken && Date.now() - tokenTime < TOKEN_TTL_MS) return cachedToken;
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    if (!res.ok) throw Object.assign(new Error(`Session request failed (${res.status})`), { fatal: true });
    const json = await res.json();
    if (!json?.accessToken) throw Object.assign(new Error('Not signed in'), { fatal: true });
    cachedToken = json.accessToken;
    tokenTime = Date.now();
    return cachedToken;
  }

  async function hideConversation(id, attempt = 0) {
    const token = await getToken(attempt > 0);
    const res = await fetch(`/backend-api/conversation/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ is_visible: false }),
    });
    if (res.ok) return;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(1500 * 2 ** attempt); // back off: 1.5s, 3s, 6s
      return hideConversation(id, attempt + 1);
    }
    if (res.status === 401 && attempt === 0) return hideConversation(id, 1); // refresh token once
    throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: res.status === 401 || res.status === 403 });
  }

  async function deleteSelected() {
    const ids = [...state.selected];
    if (!ids.length || state.busy) return;
    const plural = ids.length === 1 ? 'chat' : 'chats';
    if (!confirm(`Delete ${ids.length} ${plural}?\n\nDeleted chats can't be restored.`)) return;

    state.busy = true;
    render();
    const openId = location.pathname.match(ID_RE)?.[1];
    let deleted = 0;
    let stoppedEarly = null;
    let gapsLeft = false;

    for (let i = 0; i < ids.length; i++) {
      status(`Deleting ${i + 1} of ${ids.length}…`);
      try {
        await hideConversation(ids[i]);
        deleted++;
        state.selected.delete(ids[i]);
        if (!markGone(ids[i])) gapsLeft = true;
      } catch (err) {
        console.warn('[ChatPurge]', ids[i], err);
        if (err.fatal) { stoppedEarly = err.message; break; }
      }
      if (i < ids.length - 1) await sleep(DELAY_MS);
    }

    state.busy = false;
    const left = state.selected.size;
    if (stoppedEarly) {
      status(`Deleted ${deleted}. Stopped: ${stoppedEarly}. Reload the page and try again.`);
    } else if (left) {
      status(`Deleted ${deleted}. ${left} couldn't be deleted and are still selected.`);
    } else if (gapsLeft) {
      status(`Deleted ${deleted} ${deleted === 1 ? 'chat' : 'chats'}. Refresh to tidy the sidebar.`, 8000,
        { label: 'Refresh', run: () => location.reload() });
    } else {
      status(`Deleted ${deleted} ${deleted === 1 ? 'chat' : 'chats'}.`, 2000);
    }
    render();

    if (openId && ids.includes(openId) && !state.selected.has(openId)) location.assign('/');
  }

  // ---- Toolbar icon messages ----------------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'cmd-toggle') setActive(!state.active);
  });

  document.body.append(ui);
  mountTrigger();
  render();
})();
