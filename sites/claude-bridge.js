// claude.ai, in the page's own context ("world": "MAIN"), because content scripts can't reach the
// app's objects. It finds the app's React Query client and makes it refetch the sidebar lists:
//  - when content.js asks after a batch ("cmd:refresh-lists", answered with "cmd:lists-refreshed");
//  - on a page load soon after a delete, because the app would otherwise restore its saved list
//    from before the delete and treat it as current for about a minute.
// If the client can't be found, it does nothing.
(() => {
  'use strict';
  if (window.__cmdBridgeLoaded) return;
  window.__cmdBridgeLoaded = true;

  const LISTS = ['chat_conversation_list', 'cowork-remote-sessions'];
  const RECENT_DELETE_KEY = 'chatpurge:last-delete';
  const CATCH_UP_MS = 5 * 60e3;
  const CATCH_UP_WAIT_MS = 15e3;
  let client = null;

  // The client is a prop of its React provider, so walk the fiber tree from the root.
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

  const refresh = () => Promise.resolve(client.invalidateQueries({ predicate: (q) => LISTS.includes(q.queryKey?.[0]) }))
    .catch(() => {});
  const reply = () => document.dispatchEvent(new CustomEvent('cmd:lists-refreshed'));

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
