// claude.ai: chats and Cowork sessions. Loaded before content.js, which uses ChatPurgeSite.
(() => {
  'use strict';
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const ORG_ID = new RegExp(`^${UUID}$`, 'i');
  const ITEM_PATH = new RegExp(`/(?:chat/(${UUID})|cowork/(cse_[A-Za-z0-9]+))`, 'i');
  const RECENT_DELETE_KEY = 'chatpurge:last-delete'; // read by claude-bridge.js on the next page load
  let cachedOrg = null;

  const isCowork = (id) => id.startsWith('cse_');

  async function getOrgId() {
    let id = '';
    try { id = decodeURIComponent(document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]+)/)?.[1] ?? ''); } catch {}
    if (ORG_ID.test(id)) return id;
    if (cachedOrg) return cachedOrg;
    const res = await fetch('/api/organizations', { credentials: 'include' });
    if (!res.ok) throw Object.assign(new Error(`Organization request failed (${res.status})`), { fatal: true });
    const orgs = await res.json();
    id = (orgs.find?.((o) => o.capabilities?.includes?.('chat')) ?? orgs[0])?.uuid ?? '';
    if (!ORG_ID.test(id)) throw Object.assign(new Error('Could not find your organization'), { fatal: true });
    return (cachedOrg = id);
  }

  // The footer row is [wrapper around the user menu button][the site's own icons].
  function findToolbarSlot() {
    let hidden = null;
    for (const btn of document.querySelectorAll('button[data-testid="user-menu-button"]')) {
      let el = btn.parentElement;
      for (let depth = 0; el && el !== document.body && depth < 2; depth++, el = el.parentElement) {
        const slot = el.nextElementSibling;
        if (!slot || !el.parentElement || !slot.querySelector('button, a')) continue;
        const found = { slot, row: el.parentElement };
        if (found.row.getClientRects().length) return found;
        hidden ??= found;
        break;
      }
    }
    return hidden;
  }

  // claude.ai has no theme variables to follow, so copy the sidebar's own colours.
  function themeColors(ref) {
    const fg = getComputedStyle(ref).color;
    for (let el = ref; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return { fg, bg };
    }
    return { fg, bg: null };
  }

  function markRecentDelete() {
    try { localStorage.setItem(RECENT_DELETE_KEY, String(Date.now())); } catch {}
  }

  // Ask claude-bridge.js to make the app refetch its sidebar lists, waiting at most 3 s for the reply.
  function refreshLists() {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); document.removeEventListener('cmd:lists-refreshed', done); resolve(); };
      const timer = setTimeout(done, 3000);
      document.addEventListener('cmd:lists-refreshed', done);
      document.dispatchEvent(new CustomEvent('cmd:refresh-lists'));
    });
  }

  globalThis.ChatPurgeSite = {
    rowSelector: '[data-row-key] a[href^="/chat/"], [data-row-key] a[href^="/cowork/"]',
    linkSelector: 'a[href^="/chat/"], a[href^="/cowork/"]',
    home: '/new',
    idFromPath(path) {
      const m = path.match(ITEM_PATH);
      return m ? m[1] ?? m[2] ?? null : null;
    },
    kind: (id) => (isCowork(id) ? 'Cowork session' : 'chat'),
    findToolbarSlot,
    mountToolbar: (slot, panel) => slot.prepend(panel), // the site's icons stay at the far right
    checkboxHost: (link) => link.querySelector(':scope > .df-leading-slot'),
    themeColors,

    async request(id) {
      if (isCowork(id)) {
        return fetch(`/v1/code/sessions/${id}`, {
          method: 'DELETE',
          credentials: 'include',
          headers: { 'anthropic-version': '2023-06-01' }, // required: the server answers 400 without it
        });
      }
      const org = await getOrgId();
      return fetch(`/api/organizations/${org}/chat_conversations/${id}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    },
    // Only this exact error counts, so a changed endpoint can't make every chat look deleted.
    async isAlreadyGone(id, res) {
      if (isCowork(id) || res.status !== 404) return false;
      const body = await res.clone().json().catch(() => null);
      return (body?.error?.details?.error_code ?? body?.error?.error_code) === 'chat_conversation_not_found';
    },
    // A rejected Cowork session doesn't stop the chats in the same batch.
    isFatal: (id, status) => (status === 401 || status === 403) && !isCowork(id),

    beforeBatch: markRecentDelete,
    async afterBatch() {
      markRecentDelete();
      await refreshLists();
    },
  };
})();
