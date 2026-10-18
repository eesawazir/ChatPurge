// Clicking the toolbar icon toggles selection mode in the current ChatGPT or Claude tab.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'cmd-toggle' }).catch(() => {
    // No content script in this tab (not chatgpt.com or claude.ai) – ignore.
  });
});
