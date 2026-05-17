chrome.sidePanel.setPanelBehavior({ openPanelOnAction: true }).catch(console.error);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'capture_profile') {
    // Message routing if needed
  }
});
