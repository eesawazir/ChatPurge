// Runs in the page's own JavaScript context on claude.ai (manifest "world": "MAIN"),
// because the extension's normal content script cannot see page objects.
//
// claude.ai keeps its sidebar chat list in a React Query cache and does not refetch it after
// a delete made behind its back, so deleted chats come back after a refresh. When a batch
// finishes, content.js dispatches "cmd:refresh-lists" and this script asks the app to refetch
// its chat lists. It answers with "cmd:lists-refreshed" so content.js knows when it is done.
//
// If the cache client can't be found or changes shape, this does nothing: deleting still works.
(() => {
  'use strict';
  if (window.__cmdBridgeLoaded) return;
  window.__cmdBridgeLoaded = true;

  let client = null;

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

  document.addEventListener('cmd:refresh-lists', () => {
    try {
      client ??= findClient();
      if (!client) return reply();
      Promise.resolve(client.invalidateQueries({ predicate: (q) => q.queryKey?.[0] === 'chat_conversation_list' }))
        .catch(() => {})
        .finally(reply);
    } catch {
      client = null;
      reply();
    }
  });
})();
