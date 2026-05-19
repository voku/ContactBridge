importScripts('shared.js');

globalThis.ContactBridgeExtension.registerSidePanelAction(chrome, console);

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  return globalThis.ContactBridgeExtension.handleBackgroundMessage(chrome, request, sendResponse);
});
