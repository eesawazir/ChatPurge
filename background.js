// Clicking the toolbar icon toggles selection mode in the current ChatGPT tab.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'cmd-toggle' }).catch(() => {
    // No content script in this tab (not chatgpt.com) – ignore.
  });
});
