// The toolbar icon toggles selection mode in the current tab.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'cmd-toggle' }).catch(() => {}); // not a ChatGPT or Claude tab
});
