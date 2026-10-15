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

  // ---- Toolbar UI -----------------------------------------------------------
  const ui = document.createElement('div');
  ui.className = 'cmd-bar';
  ui.innerHTML = `
    <div class="cmd-panel" role="toolbar" aria-label="Chat selection">
      <button type="button" class="cmd-btn cmd-start" title="Alt+Shift+D">Select chats</button>
      <span class="cmd-tool cmd-count" aria-live="polite">0 selected</span>
      <button type="button" class="cmd-tool cmd-btn cmd-all">Select all</button>
      <button type="button" class="cmd-tool cmd-btn cmd-delete" disabled>Delete</button>
      <button type="button" class="cmd-tool cmd-btn cmd-done">Done</button>
    </div>
    <div class="cmd-status" role="status" aria-live="polite"></div>`;
  const $ = (sel) => ui.querySelector(sel);

  $('.cmd-start').addEventListener('click', () => setActive(true));
  $('.cmd-done').addEventListener('click', () => setActive(false));
  $('.cmd-delete').addEventListener('click', deleteSelected);
  $('.cmd-all').addEventListener('click', () => {
    const ids = rows().map(idOf);
    const allSelected = ids.length && ids.every((id) => state.selected.has(id));
    if (allSelected) state.selected.clear();
    else ids.forEach((id) => state.selected.add(id));
    render();
  });

  function status(msg, autoClearMs = 0) {
    clearTimeout(statusTimer);
    $('.cmd-status').textContent = msg;
    if (autoClearMs) statusTimer = setTimeout(() => ($('.cmd-status').textContent = ''), autoClearMs);
  }

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
    ui.classList.toggle('cmd-busy', state.busy);
    const n = state.selected.size;
    $('.cmd-count').textContent = `${n} selected`;
    $('.cmd-delete').disabled = n === 0 || state.busy;
    $('.cmd-all').disabled = state.busy;
    $('.cmd-done').disabled = state.busy;
    const ids = rows().map(idOf);
    const allSelected = ids.length > 0 && ids.every((id) => state.selected.has(id));
    $('.cmd-all').textContent = allSelected ? 'Clear' : 'Select all';
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

  function markGone(id) {
    document.querySelectorAll(ROW_SELECTOR).forEach((a) => {
      if (idOf(a) !== id) return;
      const li = a.closest('li');
      const target = li && li.querySelectorAll('a[href*="/c/"]').length === 1 ? li : a;
      target.classList.add('cmd-gone');
    });
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
  new MutationObserver(() => {
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

    for (let i = 0; i < ids.length; i++) {
      status(`Deleting ${i + 1} of ${ids.length}…`);
      try {
        await hideConversation(ids[i]);
        deleted++;
        state.selected.delete(ids[i]);
        markGone(ids[i]);
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
    } else {
      status(`Deleted ${deleted} ${deleted === 1 ? 'chat' : 'chats'}.`, 6000);
    }
    render();

    if (openId && ids.includes(openId) && !state.selected.has(openId)) location.assign('/');
  }

  // ---- Toolbar icon messages ----------------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'cmd-toggle') setActive(!state.active);
  });

  document.body.append(ui);
  render();
})();
