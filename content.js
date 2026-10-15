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

  // ---- UI: a small trigger in the profile row, and a toolbar that covers ---
  // ---- the profile row while selecting (so no chats are ever hidden). -------
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cmd-trigger';
  trigger.title = 'Select chats (Alt+Shift+D)';
  trigger.setAttribute('aria-label', 'Select chats');
  trigger.innerHTML = `
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <path d="M4.75 8.25l2.25 2.25 4.25-4.75" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    </svg><span>Select</span>`;
  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(true);
  });

  const ui = document.createElement('div');
  ui.className = 'cmd-bar';
  ui.innerHTML = `
    <div class="cmd-panel" role="toolbar" aria-label="Chat selection">
      <button type="button" class="cmd-btn cmd-all">Select all</button>
      <button type="button" class="cmd-btn cmd-delete" disabled>Delete</button>
      <button type="button" class="cmd-btn cmd-done">Done</button>
    </div>
    <span class="cmd-sr cmd-count" aria-live="polite"></span>
    <div class="cmd-status" role="status" aria-live="polite"></div>`;
  const $ = (sel) => ui.querySelector(sel);

  $('.cmd-done').addEventListener('click', () => setActive(false));
  $('.cmd-delete').addEventListener('click', deleteSelected);
  $('.cmd-all').addEventListener('click', () => {
    const ids = rows().map(idOf);
    const allSelected = ids.length && ids.every((id) => state.selected.has(id));
    if (allSelected) state.selected.clear();
    else ids.forEach((id) => state.selected.add(id));
    render();
  });

  // ---- Find the profile row (avatar + name) at the bottom of the sidebar ---
  // ChatGPT's markup has no stable hook for it, so this works from geometry:
  // find the full-height sidebar, look at what sits at its bottom-left corner,
  // and climb to the row that spans the sidebar's width.
  function findSidebar() {
    let el = document.querySelector(ROW_SELECTOR);
    while (el && el !== document.body) {
      const r = el.getBoundingClientRect();
      if (r.height >= innerHeight * 0.8 && r.width < innerWidth * 0.6) return el;
      el = el.parentElement;
    }
    return null;
  }

  function findProfileRow() {
    const side = findSidebar();
    if (!side) return null;
    const sr = side.getBoundingClientRect();
    if (sr.width < 180) return null; // collapsed icon rail
    const hit = document
      .elementsFromPoint(sr.left + 28, sr.bottom - 26)
      .find((el) => !ui.contains(el) && !trigger.contains(el) && side.contains(el));
    if (!hit || hit.closest(ROW_SELECTOR)) return null; // that's a chat, not the footer
    let el = hit;
    while (el.parentElement && el.parentElement !== side) {
      if (el.getBoundingClientRect().width >= sr.width * 0.8) break;
      el = el.parentElement;
    }
    const r = el.getBoundingClientRect();
    if (r.height < 28 || r.height > 120 || el.querySelector('a[href*="/c/"]')) return null;
    return el;
  }

  function place() {
    const row = findProfileRow();
    const r = row?.getBoundingClientRect();

    // Trigger: right side of the profile row, vertically centred.
    if (r && !state.active) {
      trigger.hidden = false;
      const h = trigger.offsetHeight || 28;
      trigger.style.top = `${Math.round(r.top + (r.height - h) / 2)}px`;
      trigger.style.left = `${Math.round(r.right - trigger.offsetWidth - 10)}px`;
    } else {
      trigger.hidden = true; // sidebar closed: use the toolbar icon or Alt+Shift+D
    }

    // Toolbar: sits exactly over the profile row, growing upward if a status shows.
    if (r) {
      ui.classList.remove('cmd-floating');
      ui.style.left = `${Math.round(r.left)}px`;
      ui.style.width = `${Math.round(r.width)}px`;
      ui.style.bottom = `${Math.round(innerHeight - r.bottom)}px`;
      ui.style.minHeight = `${Math.round(r.height)}px`;
    } else {
      ui.classList.add('cmd-floating');
      ui.style.cssText = '';
    }
  }

  let placeQueued = false;
  const schedulePlace = () => {
    if (placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => {
      placeQueued = false;
      place();
    });
  };
  addEventListener('resize', schedulePlace);
  document.addEventListener('transitionend', schedulePlace, true); // sidebar open/close
  setInterval(schedulePlace, 1000); // cheap safety net for layout shifts we can't observe

  function status(msg, autoClearMs = 0, action = null) {
    clearTimeout(statusTimer);
    const el = $('.cmd-status');
    el.textContent = msg;
    if (action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cmd-btn cmd-status-action';
      btn.textContent = action.label;
      btn.addEventListener('click', action.run);
      el.append(' ', btn);
    }
    if (autoClearMs) statusTimer = setTimeout(() => (el.textContent = ''), autoClearMs);
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
    $('.cmd-delete').textContent = n ? `Delete ${n}` : 'Delete';
    $('.cmd-delete').disabled = n === 0 || state.busy;
    $('.cmd-all').disabled = state.busy;
    $('.cmd-done').disabled = state.busy;
    const ids = rows().map(idOf);
    const allSelected = ids.length > 0 && ids.every((id) => state.selected.has(id));
    $('.cmd-all').textContent = allSelected ? 'Clear' : 'Select all';
    decorate();
    place();
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
  new MutationObserver(() => {
    schedulePlace();
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

  document.body.append(trigger, ui);
  render();
})();
