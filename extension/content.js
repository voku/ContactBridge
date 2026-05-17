function extractProfile() {
  const url = window.location.href;
  let source = 'unknown';
  let displayName = '';
  let handle = '';
  let headline = '';

  if (url.includes('linkedin.com/in/')) {
    source = 'linkedin';
    displayName = document.querySelector('h1')?.innerText || '';
    headline = document.querySelector('.text-body-medium')?.innerText || '';
    const match = url.match(/linkedin\.com\/in\/([^\/]+)/);
    handle = match ? match[1] : '';
  } else if (url.includes('x.com/') || url.includes('twitter.com/')) {
    source = 'x';
    const matches = url.match(/(?:x|twitter)\.com\/([^\/]+)/);
    if (matches && matches[1] !== 'home' && matches[1] !== 'explore') {
      handle = matches[1];
      const nameEl = document.querySelector('[data-testid="UserName"] span');
      displayName = nameEl ? nameEl.innerText : handle;
      const descEl = document.querySelector('[data-testid="UserDescription"]');
      headline = descEl ? descEl.innerText : '';
    }
  } else if (url.includes('xing.com/profile/')) {
    source = 'xing';
    const matches = url.match(/xing\.com\/profile\/([^/?#]+)/i);
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
  } else if (url.includes('bsky.app/profile/')) {
    source = 'bluesky';
    const matches = url.match(/bsky\.app\/profile\/([^\/]+)/);
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
