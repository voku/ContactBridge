importScripts('shared.js');

chrome.sidePanel.setPanelBehavior({ openPanelOnAction: true }).catch(console.error);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  return globalThis.ContactBridgeExtension.handleBackgroundMessage(chrome, request, sendResponse);
});
