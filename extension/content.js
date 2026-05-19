function extractProfile() {
  return globalThis.ContactBridgeExtension.extractProfileFromDocument(document, window.location.href);
}

function extractProfiles() {
  return globalThis.ContactBridgeExtension.extractProfilesFromDocument(document, window.location.href);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'get_profile') {
    sendResponse(extractProfile());
  } else if (request.action === 'get_profiles') {
    sendResponse(extractProfiles());
  }
});
