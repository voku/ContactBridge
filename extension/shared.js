(() => {
  const CAPTURE_SCRIPT_FILES = ['shared.js', 'content.js'];
  const LINKEDIN_OVERVIEW_PATH_PATTERNS = [
    /^\/feed\/followers\/?$/i,
    /^\/search\/results\/people\/?$/i
  ];
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
  const toTextLines = (value) => String(value ?? '')
    .split(/\n+/)
    .map((entry) => trimText(entry))
    .filter(Boolean);
  const GENERIC_LINKEDIN_OVERVIEW_LINES = new Set([
    'connect',
    'follow',
    'following',
    'message',
    'pending',
    'profile',
    'remove',
    'see more',
    'view profile'
  ]);

  // Add reviewed production hub origins here before packaging a hosted extension build.
  // Values must be origins with protocol and host, for example: 'https://contactbridge.example.com'.
  const PACKAGED_PRODUCTION_HUB_ORIGINS = Object.freeze([]);
  const ALLOWED_PRODUCTION_HUB_ORIGINS = new Set(PACKAGED_PRODUCTION_HUB_ORIGINS);

  const isAllowedHubUrl = (url, options = {}) => {
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
    const productionHubOrigins = options.productionHubOrigins instanceof Set
      ? options.productionHubOrigins
      : ALLOWED_PRODUCTION_HUB_ORIGINS;
    const isLocalHub = parsedUrl.protocol === 'http:'
      && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]');
    const isConfiguredProductionHub = parsedUrl.protocol === 'https:'
      && productionHubOrigins.has(parsedUrl.origin);

    if (!isLocalHub && !isConfiguredProductionHub) {
      return {
        error: 'For safety, the extension only sends captures to local ContactBridge hubs unless a production origin is explicitly packaged.',
        ok: false,
        url: ''
      };
    }

    return { error: '', ok: true, url: parsedUrl.origin };
  };

  const validateHubHealth = async (hubUrl, fetchImpl = fetch) => {
    const allowedHubUrl = isAllowedHubUrl(hubUrl);
    if (!allowedHubUrl.ok) {
      return allowedHubUrl;
    }

    try {
      const response = await fetchImpl(`${allowedHubUrl.url}/api/extension/health`, {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) {
        return {
          error: 'Hub validation failed. Make sure this ContactBridge hub is running and reachable.',
          ok: false,
          url: ''
        };
      }

      const payload = await response.json();
      const hasValidShape = payload
        && payload.appName === 'ContactBridge'
        && typeof payload.appMode === 'string'
        && Array.isArray(payload.capabilities)
        && payload.capabilities.includes('capture.manual.v1');

      if (!hasValidShape) {
        return {
          error: 'Hub validation failed. This URL does not look like a compatible ContactBridge hub.',
          ok: false,
          url: ''
        };
      }

      return { error: '', ok: true, url: allowedHubUrl.url };
    } catch (error) {
      console.error('Hub health check failed:', error);
      return {
        error: 'Hub validation failed. Could not reach the ContactBridge hub health endpoint.',
        ok: false,
        url: ''
      };
    }
  };

  const getElementText = (doc, selector) => trimText(doc?.querySelector?.(selector)?.innerText || '');

  const normalizeProfileUrl = (href, baseUrl, matchPattern, hostnamePattern) => {
    if (typeof href !== 'string' || !href.trim()) {
      return null;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(href, baseUrl);
    } catch {
      return null;
    }

    parsedUrl.search = '';
    parsedUrl.hash = '';

    if (hostnamePattern && !hostnamePattern.test(parsedUrl.hostname.toLowerCase())) {
      return null;
    }

    return matchPattern.test(parsedUrl.pathname) ? parsedUrl.toString() : null;
  };

  const getLinkedInOverviewAnchorHref = (anchor) => {
    if (typeof anchor?.getAttribute === 'function') {
      const href = anchor.getAttribute('href');
      if (typeof href === 'string' && href) {
        return href;
      }
    }

    return typeof anchor?.href === 'string' ? anchor.href : '';
  };

  const getLinkedInOverviewCard = (anchor) => {
    if (!anchor) {
      return null;
    }

    if (typeof anchor.closest === 'function') {
      const matched = anchor.closest('li, article, section, [data-view-name], [data-urn]');
      if (matched) {
        return matched;
      }
    }

    return anchor.parentElement || anchor;
  };

  const getLinkedInOverviewName = (anchor, card, handle) => {
    const candidates = [
      trimText(anchor?.innerText),
      trimText(anchor?.textContent),
      trimText(anchor?.ariaLabel),
      ...toTextLines(card?.innerText).slice(0, 2)
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const normalizedCandidate = candidate
        .replace(/^view\s+/i, '')
        .replace(/['’]s profile$/i, '')
        .replace(/\s+profile$/i, '')
        .trim();

      if (normalizedCandidate) {
        return normalizedCandidate;
      }
    }

    return handle;
  };

  const getLinkedInOverviewHeadline = (card, displayName) => {
    const textLines = toTextLines(card?.innerText);
    const normalizedDisplayName = trimText(displayName).toLowerCase();

    return textLines.find((line) => {
      const normalizedLine = line.toLowerCase();
      if (!normalizedLine || normalizedLine === normalizedDisplayName) {
        return false;
      }

      if (GENERIC_LINKEDIN_OVERVIEW_LINES.has(normalizedLine)) {
        return false;
      }

      if (/^\d+\s+(followers?|connections?)$/i.test(line)) {
        return false;
      }

      return true;
    }) || '';
  };

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
        captureMode: 'profile',
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
          captureMode: 'profile',
          originPattern: `${parsedUrl.origin}/*`,
          profileUrl,
          source: 'x'
        };
      }
    }

    if (/(^|\.)xing\.com$/.test(hostname) && pathname.startsWith('/profile/')) {
      const match = pathname.match(/^\/profile\/([^/?#]+)/i);
        return {
          captureMode: 'profile',
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
        captureMode: 'profile',
        handle: match ? match[1] : '',
        hostname,
        isSupported: true,
        originPattern: `${parsedUrl.origin}/*`,
        profileUrl,
        source: 'bluesky'
      };
    }

    if (/(^|\.)linkedin\.com$/.test(hostname) && LINKEDIN_OVERVIEW_PATH_PATTERNS.some((pattern) => pattern.test(pathname))) {
      return {
        captureMode: 'overview',
        handle: '',
        hostname,
        isSupported: true,
        originPattern: `${parsedUrl.origin}/*`,
        profileUrl,
        source: 'linkedin'
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

  const extractProfilesFromDocument = (doc, url) => {
    const profileContext = getProfileContext(url);
    if (profileContext.captureMode !== 'overview' || profileContext.source !== 'linkedin') {
      return [];
    }

    const anchors = Array.from(doc?.querySelectorAll?.('a[href*="/in/"]') || []);
    const profilesBySourceId = new Map();

    for (const anchor of anchors) {
      const profileUrl = normalizeProfileUrl(
        getLinkedInOverviewAnchorHref(anchor),
        url,
        /^\/in\/([^/?#]+)\/?$/i,
        /(^|\.)linkedin\.com$/i
      );
      if (!profileUrl) {
        continue;
      }

      const match = new URL(profileUrl).pathname.match(/^\/in\/([^/?#]+)\/?$/i);
      const handle = match ? decodeURIComponent(match[1]) : '';
      if (!handle) {
        continue;
      }

      const sourceProfileId = handle.toLowerCase();
      if (profilesBySourceId.has(sourceProfileId)) {
        continue;
      }

      const card = getLinkedInOverviewCard(anchor);
      const displayName = getLinkedInOverviewName(anchor, card, handle);
      const headline = getLinkedInOverviewHeadline(card, displayName);
      profilesBySourceId.set(sourceProfileId, {
        displayName,
        handle,
        headline,
        profileUrl,
        source: 'linkedin'
      });
    }

    return Array.from(profilesBySourceId.values());
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

  const requestCapturedProfiles = (chromeApi, tabId, callback) => {
    chromeApi.scripting.executeScript({
      files: CAPTURE_SCRIPT_FILES,
      target: { tabId }
    }, () => {
      const injectionError = chromeApi.runtime.lastError;
      if (injectionError) {
        callback({ error: `Cannot access this page: ${injectionError.message}`, ok: false });
        return;
      }

      chromeApi.tabs.sendMessage(tabId, { action: 'get_profiles' }, (response) => {
        const messageError = chromeApi.runtime.lastError;
        if (messageError) {
          callback({ error: `Could not read visible profiles from this page: ${messageError.message}`, ok: false });
          return;
        }

        if (!Array.isArray(response) || response.length === 0) {
          callback({ error: 'Could not find any visible profiles to import from this page.', ok: false });
          return;
        }

        callback({ ok: true, profiles: response });
      });
    });
  };

  const registerSidePanelAction = (chromeApi, logger = console) => {
    if (!chromeApi?.sidePanel) {
      return;
    }

    if (typeof chromeApi.sidePanel.setPanelBehavior === 'function') {
      Promise.resolve(
        chromeApi.sidePanel.setPanelBehavior({ openPanelOnAction: true })
      ).catch((error) => {
        logger?.error?.('Failed to enable side panel action behavior:', error);
      });
    }

    if (
      typeof chromeApi.sidePanel.open === 'function'
      && chromeApi.action?.onClicked
      && typeof chromeApi.action.onClicked.addListener === 'function'
    ) {
      chromeApi.action.onClicked.addListener((tab) => {
        const windowId = tab?.windowId;
        if (!Number.isInteger(windowId)) {
          logger?.warn?.('Cannot open ContactBridge side panel without a browser window.');
          return;
        }

        Promise.resolve(chromeApi.sidePanel.open({ windowId })).catch((error) => {
          logger?.error?.('Failed to open ContactBridge side panel:', error);
        });
      });
    }
  };

  const handleBackgroundMessage = (chromeApi, request, sendResponse) => {
    if (request?.action !== 'capture_profile' && request?.action !== 'capture_profiles') {
      return false;
    }

    if (!Number.isInteger(request.tabId)) {
      sendResponse({ error: 'Active tab unavailable.', ok: false });
      return false;
    }

    if (request.action === 'capture_profiles') {
      requestCapturedProfiles(chromeApi, request.tabId, sendResponse);
      return true;
    }

    requestCapturedProfile(chromeApi, request.tabId, sendResponse);
    return true;
  };

  globalThis.ContactBridgeExtension = {
    CAPTURE_SCRIPT_FILES,
    extractProfileFromDocument,
    extractProfilesFromDocument,
    getProfileContext,
    isAllowedHubUrl,
    validateHubHealth,
    handleBackgroundMessage,
    registerSidePanelAction,
    requestCapturedProfile,
    requestCapturedProfiles
  };
})();
