(() => {
  const CAPTURE_SCRIPT_FILES = ['shared.js', 'content.js'];
  const X_RESERVED_PATH_SEGMENTS = new Set([
    '',
    'compose',
    'explore',
    'hashtag',
    'home',
    'i',
    'intent',
    'login',
    'messages',
    'notifications',
    'privacy',
    'search',
    'settings',
    'share',
    'signup',
    'tos'
  ]);

  const trimText = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

  // Add reviewed production hub origins here before packaging a hosted extension build.
  // Values must be origins with protocol and host, for example: 'https://contactbridge.example.com'.
  const ALLOWED_PRODUCTION_HUB_ORIGINS = new Set([]);

  const isAllowedHubUrl = (url) => {
    if (typeof url !== 'string' || !url.trim()) {
      return { error: 'Enter a ContactBridge Hub URL.', ok: false, url: '' };
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url.trim());
    } catch {
      return { error: 'Hub URL must be a valid absolute URL.', ok: false, url: '' };
    }

    parsedUrl.search = '';
    parsedUrl.hash = '';

    const hostname = parsedUrl.hostname.toLowerCase();
    const isLocalHub = parsedUrl.protocol === 'http:'
      && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
    const isConfiguredProductionHub = parsedUrl.protocol === 'https:'
      && ALLOWED_PRODUCTION_HUB_ORIGINS.has(parsedUrl.origin);

    if (!isLocalHub && !isConfiguredProductionHub) {
      return {
        error: 'For safety, the extension only sends captures to local ContactBridge hubs unless a production origin is explicitly packaged.',
        ok: false,
        url: ''
      };
    }

    return { error: '', ok: true, url: parsedUrl.origin };
  };

  const getElementText = (doc, selector) => trimText(doc?.querySelector?.(selector)?.innerText || '');

  const getProfileContext = (url) => {
    const fallback = {
      handle: '',
      hostname: '',
      isSupported: false,
      originPattern: null,
      profileUrl: typeof url === 'string' ? url : '',
      source: 'unknown'
    };

    if (typeof url !== 'string' || !url) {
      return fallback;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      return fallback;
    }

    const hostname = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname;
    const profileUrl = parsedUrl.toString();

    if (/(^|\.)linkedin\.com$/.test(hostname) && pathname.startsWith('/in/')) {
      const match = pathname.match(/^\/in\/([^/?#]+)/);
      return {
        handle: match ? decodeURIComponent(match[1]) : '',
        hostname,
        isSupported: true,
        originPattern: `${parsedUrl.origin}/*`,
        profileUrl,
        source: 'linkedin'
      };
    }

    if (/(^|\.)x\.com$/.test(hostname) || /(^|\.)twitter\.com$/.test(hostname)) {
      const match = pathname.match(/^\/([^/?#]+)/);
      const handle = match ? match[1] : '';
      if (handle && !X_RESERVED_PATH_SEGMENTS.has(handle.toLowerCase())) {
        return {
          handle,
          hostname,
          isSupported: true,
          originPattern: `${parsedUrl.origin}/*`,
          profileUrl,
          source: 'x'
        };
      }
    }

    if (/(^|\.)xing\.com$/.test(hostname) && pathname.startsWith('/profile/')) {
      const match = pathname.match(/^\/profile\/([^/?#]+)/i);
      return {
        handle: match ? decodeURIComponent(match[1]) : '',
        hostname,
        isSupported: true,
        originPattern: `${parsedUrl.origin}/*`,
        profileUrl,
        source: 'xing'
      };
    }

    if (hostname === 'bsky.app' && pathname.startsWith('/profile/')) {
      const match = pathname.match(/^\/profile\/([^/?#]+)/);
      return {
        handle: match ? match[1] : '',
        hostname,
        isSupported: true,
        originPattern: `${parsedUrl.origin}/*`,
        profileUrl,
        source: 'bluesky'
      };
    }

    return fallback;
  };

  const extractProfileFromDocument = (doc, url) => {
    const profileContext = getProfileContext(url);
    if (!profileContext.isSupported) {
      return {
        displayName: '',
        handle: '',
        headline: '',
        profileUrl: profileContext.profileUrl,
        source: 'unknown'
      };
    }

    let displayName = '';
    let headline = '';

    if (profileContext.source === 'linkedin') {
      displayName = getElementText(doc, 'h1');
      headline = getElementText(doc, '.text-body-medium');
    } else if (profileContext.source === 'x') {
      displayName = getElementText(doc, '[data-testid="UserName"] span') || profileContext.handle;
      headline = getElementText(doc, '[data-testid="UserDescription"]');
    } else if (profileContext.source === 'xing') {
      const fallbackTitle = trimText(doc?.title?.split('|')[0] || '');
      displayName =
        getElementText(doc, 'h1') ||
        getElementText(doc, '[data-qa="profile-top-card-full-name"]') ||
        fallbackTitle ||
        profileContext.handle;
      headline =
        getElementText(doc, '[data-qa="profile-top-card-headline"]') ||
        getElementText(doc, 'main h2');
    } else if (profileContext.source === 'bluesky') {
      displayName = trimText(doc?.title?.split('—')[0] || '') || profileContext.handle;
    }

    return {
      displayName,
      handle: profileContext.handle,
      headline,
      profileUrl: profileContext.profileUrl,
      source: profileContext.source
    };
  };

  const requestCapturedProfile = (chromeApi, tabId, callback) => {
    chromeApi.scripting.executeScript({
      files: CAPTURE_SCRIPT_FILES,
      target: { tabId }
    }, () => {
      const injectionError = chromeApi.runtime.lastError;
      if (injectionError) {
        callback({ error: `Cannot access this page: ${injectionError.message}`, ok: false });
        return;
      }

      chromeApi.tabs.sendMessage(tabId, { action: 'get_profile' }, (response) => {
        const messageError = chromeApi.runtime.lastError;
        if (messageError) {
          callback({ error: `Could not read profile data from this page: ${messageError.message}`, ok: false });
          return;
        }

        if (!response || response.source === 'unknown') {
          callback({ error: 'Could not extract profile data from this page.', ok: false });
          return;
        }

        callback({ ok: true, profile: response });
      });
    });
  };

  const handleBackgroundMessage = (chromeApi, request, sendResponse) => {
    if (request?.action !== 'capture_profile') {
      return false;
    }

    if (!Number.isInteger(request.tabId)) {
      sendResponse({ error: 'Active tab unavailable.', ok: false });
      return false;
    }

    requestCapturedProfile(chromeApi, request.tabId, sendResponse);
    return true;
  };

  globalThis.ContactBridgeExtension = {
    CAPTURE_SCRIPT_FILES,
    extractProfileFromDocument,
    getProfileContext,
    isAllowedHubUrl,
    handleBackgroundMessage,
    requestCapturedProfile
  };
})();
