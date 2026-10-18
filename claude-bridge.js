// Runs in the page's own JavaScript context on claude.ai (manifest "world": "MAIN"),
// because the extension's normal content script cannot see page objects.
//
// claude.ai keeps its sidebar chat list in a React Query cache and does not refetch it after
// a delete made behind its back, so deleted chats come back after a refresh. When a batch
// finishes, content.js dispatches "cmd:refresh-lists" and this script asks the app to refetch
// its chat and Cowork session lists. It answers with "cmd:lists-refreshed" so content.js knows when it is done.
//
// It also catches up after a reload that came too soon after a delete (see catchUpAfterReload).
// If the cache client can't be found or changes shape, this does nothing: deleting still works.
(() => {
  'use strict';
  if (window.__cmdBridgeLoaded) return;
  window.__cmdBridgeLoaded = true;

  let client = null;
  // The sidebar's chat list and its Cowork session list.
  const LISTS = ['chat_conversation_list', 'cowork-remote-sessions'];

  // The QueryClient is passed to React as a prop of its provider, so walk React's fiber tree.
  function findClient() {
    const roots = [document.getElementById('root'), document.getElementById('__next'), document.body, ...document.body.children];
    for (const el of roots) {
      const key = el && Object.keys(el).find((k) => k.startsWith('__reactContainer$'));
      if (!key) continue;
      const stack = [el[key]];
      for (let n = 0; stack.length && n < 50000; n++) {
        const fiber = stack.pop();
        const props = fiber?.memoizedProps;
        if (props?.client?.invalidateQueries) return props.client;
        if (props?.value?.invalidateQueries && props.value.getQueryCache) return props.value;
        if (fiber?.sibling) stack.push(fiber.sibling);
        if (fiber?.child) stack.push(fiber.child);
      }
    }
    return null;
  }

  const reply = () => document.dispatchEvent(new CustomEvent('cmd:lists-refreshed'));
  const refresh = () => Promise.resolve(client.invalidateQueries({ predicate: (q) => LISTS.includes(q.queryKey?.[0]) }))
    .catch(() => {});

  document.addEventListener('cmd:refresh-lists', () => {
    try {
      client ??= findClient();
      if (!client) return reply();
      refresh().finally(reply);
    } catch {
      client = null;
      reply();
    }
  });

  // A reload soon after a delete (or during a batch) can restore the app's saved list from before the
  // delete, which it then treats as current for about a minute. content.js records when it last deleted
  // something; if that was recent, wait until the app has restored its list and ask it to refetch.
  const RECENT_DELETE_KEY = 'chatpurge:last-delete';
  const CATCH_UP_MS = 5 * 60e3;
  const CATCH_UP_WAIT_MS = 15e3;
  function catchUpAfterReload() {
    let last = 0;
    try { last = Number(localStorage.getItem(RECENT_DELETE_KEY)) || 0; } catch { return; }
    if (!last || Date.now() - last > CATCH_UP_MS) return;
    const started = Date.now();
    const tick = () => {
      try {
        client ??= findClient();
        const restored = client?.getQueryCache?.().getAll()
          .some((q) => q.queryKey?.[0] === 'chat_conversation_list' && q.state.data);
        if (restored) { refresh(); return; }
      } catch {
        client = null;
      }
      if (Date.now() - started < CATCH_UP_WAIT_MS) setTimeout(tick, 250);
    };
    tick();
  }
  catchUpAfterReload();
})();
