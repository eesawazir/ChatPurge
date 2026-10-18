// ChatGPT (chatgpt.com, chat.openai.com). Loaded before content.js, which uses ChatPurgeSite.
(() => {
  'use strict';
  const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const CHAT_PATH = new RegExp(`/c/(${UUID})`, 'i');
  const TOKEN_TTL_MS = 5 * 60e3;
  let token = null;
  let tokenTime = 0;

  async function getToken(force) {
    if (!force && token && Date.now() - tokenTime < TOKEN_TTL_MS) return token;
    const res = await fetch('/api/auth/session', { credentials: 'include' });
    if (!res.ok) throw Object.assign(new Error(`Session request failed (${res.status})`), { fatal: true });
    const json = await res.json();
    if (!json?.accessToken) throw Object.assign(new Error('Not signed in'), { fatal: true });
    token = json.accessToken;
    tokenTime = Date.now();
    return token;
  }

  // The profile row ends in a container that ChatGPT hides while it is empty ("empty:hidden").
  function slotAbove(el) {
    for (let depth = 0; el && el !== document.body && depth < 8; depth++, el = el.parentElement) {
      const slot = el.querySelector(':scope > .empty\\:hidden');
      if (slot) return { slot, row: el };
    }
    return null;
  }

  // ChatGPT can render more than one profile button (e.g. a hidden copy), so try them all
  // and prefer the one on screen.
  function findToolbarSlot() {
    let buttons = [...document.querySelectorAll('button[aria-label="Open profile menu"]')];
    if (!buttons.length) {
      // Translated UIs change the label: use the menu button next to the avatar instead.
      buttons = [...document.querySelectorAll('nav button[aria-haspopup="menu"], aside button[aria-haspopup="menu"]')]
        .filter((b) => b.parentElement?.querySelector('img.rounded-full'));
    }
    let hidden = null;
    for (const btn of buttons) {
      const found = slotAbove(btn.parentElement);
      if (!found) continue;
      if (found.row.getClientRects().length) return found;
      hidden ??= found;
    }
    return hidden;
  }

  globalThis.ChatPurgeSite = {
    rowSelector: 'nav a[href*="/c/"], aside a[href*="/c/"]',
    linkSelector: 'a[href*="/c/"]',
    home: '/',
    idFromPath: (path) => path.match(CHAT_PATH)?.[1] ?? null,
    kind: () => 'chat',
    findToolbarSlot,
    mountToolbar: (slot, panel) => slot.append(panel),

    async request(id, attempt) {
      const auth = await getToken(attempt > 0);
      return fetch(`/backend-api/conversation/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
        body: JSON.stringify({ is_visible: false }),
      });
    },
    isAlreadyGone: async () => false,
    isFatal: (id, status) => status === 401 || status === 403,
  };
})();
