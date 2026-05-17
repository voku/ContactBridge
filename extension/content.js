function extractProfile() {
  const url = window.location.href;
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { source: 'unknown', profileUrl: url, displayName: '', handle: '', headline: '' };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const pathname = parsedUrl.pathname;
  let source = 'unknown';
  let displayName = '';
  let handle = '';
  let headline = '';

  if (/(^|\.)linkedin\.com$/.test(hostname) && pathname.startsWith('/in/')) {
    source = 'linkedin';
    displayName = document.querySelector('h1')?.innerText || '';
    headline = document.querySelector('.text-body-medium')?.innerText || '';
    const match = pathname.match(/^\/in\/([^/]+)/);
    handle = match ? match[1] : '';
  } else if ((/(^|\.)x\.com$/.test(hostname) || /(^|\.)twitter\.com$/.test(hostname)) && pathname !== '/') {
    source = 'x';
    const matches = pathname.match(/^\/([^/]+)/);
    if (matches && matches[1] !== 'home' && matches[1] !== 'explore') {
      handle = matches[1];
      const nameEl = document.querySelector('[data-testid="UserName"] span');
      displayName = nameEl ? nameEl.innerText : handle;
      const descEl = document.querySelector('[data-testid="UserDescription"]');
      headline = descEl ? descEl.innerText : '';
    }
  } else if (/(^|\.)xing\.com$/.test(hostname) && pathname.startsWith('/profile/')) {
    source = 'xing';
    const matches = pathname.match(/^\/profile\/([^/?#]+)/i);
    handle = matches ? decodeURIComponent(matches[1]) : '';
    const title = document.title.split('|')[0]?.trim() || '';
    displayName =
      document.querySelector('h1')?.innerText ||
      document.querySelector('[data-qa="profile-top-card-full-name"]')?.innerText ||
      title ||
      handle;
    headline =
      document.querySelector('[data-qa="profile-top-card-headline"]')?.innerText ||
      document.querySelector('main h2')?.innerText ||
      '';
  } else if (hostname === 'bsky.app' && pathname.startsWith('/profile/')) {
    source = 'bluesky';
    const matches = pathname.match(/^\/profile\/([^/]+)/);
    if (matches) {
      handle = matches[1];
      // Basic extraction, DOM can be complex
      displayName = document.title.split('—')[0].trim() || handle; 
    }
  }

  return { source, profileUrl: url, displayName, handle, headline };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'get_profile') {
    sendResponse(extractProfile());
  }
});
