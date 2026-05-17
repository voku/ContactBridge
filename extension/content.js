function extractProfile() {
  return globalThis.ContactBridgeExtension.extractProfileFromDocument(document, window.location.href);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'get_profile') {
    sendResponse(extractProfile());
  }
});
