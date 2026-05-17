document.addEventListener('DOMContentLoaded', () => {
  const apiUrlInput = document.getElementById('apiUrl');
  const saveConfigBtn = document.getElementById('saveConfigBtn');
  const captureBtn = document.getElementById('captureBtn');
  const captureSection = document.getElementById('captureSection');
  const profileDataDiv = document.getElementById('profileData');
  const statusDiv = document.getElementById('status');

  let currentProfile = null;

  chrome.storage.sync.get(['apiUrl'], (result) => {
    if (result.apiUrl) {
      apiUrlInput.value = result.apiUrl;
      enableCapture();
    }
  });

  saveConfigBtn.addEventListener('click', () => {
    const url = apiUrlInput.value.trim();
    if (url) {
      chrome.storage.sync.set({ apiUrl: url }, () => {
        enableCapture();
        showStatus('Configuration saved!', false);
        setTimeout(() => { statusDiv.style.display = 'none'; }, 2000);
      });
    }
  });

  function enableCapture() {
    captureSection.style.opacity = '1';
    captureSection.style.pointerEvents = 'auto';
    checkCurrentTab();
  }

  function checkCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      
      const tab = tabs[0];
      const url = tab.url || '';

      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        profileDataDiv.innerHTML = '<p class="muted">Navigate to a supported profile (LinkedIn, X, Bluesky, XING) to capture.</p>';
        captureBtn.disabled = true;
        return;
      }

      const hostname = parsedUrl.hostname.toLowerCase();
      const pathname = parsedUrl.pathname;
      const isSupportedProfile =
        (/(^|\.)linkedin\.com$/.test(hostname) && pathname.startsWith('/in/')) ||
        ((/(^|\.)x\.com$/.test(hostname) || /(^|\.)twitter\.com$/.test(hostname)) && pathname !== '/') ||
        (hostname === 'bsky.app' && pathname.startsWith('/profile/')) ||
        (/(^|\.)xing\.com$/.test(hostname) && pathname.startsWith('/profile/'));

      if (isSupportedProfile) {
        const origin = parsedUrl.origin + '/*';
        
        chrome.permissions.contains({ origins: [origin] }, (hasPermission) => {
          if (hasPermission) {
            extractData(tab.id);
          } else {
            profileDataDiv.innerHTML = `<p class="muted">Click below to allow access to ${parsedUrl.hostname} and capture this profile.</p>`;
            captureBtn.textContent = 'Grant Access & Capture';
            captureBtn.disabled = false;
            captureBtn.onclick = () => {
              chrome.permissions.request({ origins: [origin] }, (granted) => {
                if (granted) {
                  captureBtn.textContent = 'Save this profile';
                  checkCurrentTab();
                }
              });
            };
          }
        });
      } else {
        profileDataDiv.innerHTML = '<p class="muted">Navigate to a supported profile (LinkedIn, X, Bluesky, XING) to capture.</p>';
        captureBtn.disabled = true;
      }
    });
  }

  function extractData(tabId) {
    chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    }, () => {
      if (chrome.runtime.lastError) {
         profileDataDiv.innerHTML = `<p class="muted">Cannot access this page: ${chrome.runtime.lastError.message}</p>`;
         return;
      }
      chrome.tabs.sendMessage(tabId, { action: 'get_profile' }, (response) => {
        if (response && response.source !== 'unknown') {
          currentProfile = response;
          renderProfileData(response);
          captureBtn.disabled = false;
          captureBtn.textContent = 'Save this profile';
          captureBtn.onclick = saveProfile;
        } else {
          profileDataDiv.innerHTML = '<p class="muted">Could not extract profile data from this page.</p>';
          captureBtn.disabled = true;
        }
      });
    });
  }

  function saveProfile() {
    if (!currentProfile) return;
    
    chrome.storage.sync.get(['apiUrl'], (result) => {
      const apiUrl = result.apiUrl;
      if (!apiUrl) {
        showStatus('Please set Hub URL first', true);
        return;
      }

      const payload = {
        ...currentProfile,
        capturedAt: new Date().toISOString()
      };

      captureBtn.disabled = true;
      captureBtn.textContent = 'Saving...';

      fetch(`${apiUrl.replace(/(\/)$/, '')}/api/capture/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(res => {
        if (!res.ok) {
          return res.json()
            .catch(() => ({ error: 'Network error' }))
            .then((payload) => {
              throw new Error(payload.error || 'Network error');
            });
        }
        return res.json();
      })
      .then(data => {
        const message = data.status === 'pending'
          ? 'Captured successfully. Review it in ContactBridge before approving.'
          : 'Captured successfully!';
        showStatus(message, false);
        setTimeout(() => {
          captureBtn.disabled = false;
          captureBtn.textContent = 'Save this profile';
          statusDiv.style.display = 'none';
        }, 2000);
      })
      .catch(err => {
        showStatus('Failed: ' + err.message, true);
        captureBtn.disabled = false;
        captureBtn.textContent = 'Save this profile';
      });
    });
  }

  function showStatus(msg, isError) {
    statusDiv.textContent = msg;
    statusDiv.className = isError ? 'error' : '';
    statusDiv.style.display = 'block';
  }

  function appendProfileRow(label, value, options = {}) {
    const row = document.createElement('div');
    row.className = 'data-row';
    if (options.marginTop) {
      row.style.marginTop = options.marginTop;
    }

    if (label) {
      const labelDiv = document.createElement('div');
      labelDiv.className = 'data-label';
      labelDiv.textContent = label;
      row.appendChild(labelDiv);
    }

    const valueDiv = document.createElement('div');
    valueDiv.className = 'data-value';
    if (options.capitalize) {
      valueDiv.style.textTransform = 'capitalize';
    }
    if (options.muted) {
      valueDiv.style.color = '#4b5563';
      valueDiv.style.fontSize = '0.8rem';
    }
    valueDiv.textContent = value;
    row.appendChild(valueDiv);
    profileDataDiv.appendChild(row);
  }

  function renderProfileData(profile) {
    profileDataDiv.replaceChildren();
    appendProfileRow('Source', profile.source || 'Not available', { capitalize: true });
    appendProfileRow('Name', profile.displayName || 'Not available');
    appendProfileRow('Handle', profile.handle ? `@${profile.handle}` : 'Not available');

    if (profile.headline) {
      appendProfileRow('', profile.headline, { muted: true, marginTop: '12px' });
    }
  }

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active) {
      checkCurrentTab();
    }
  });

  chrome.tabs.onActivated.addListener(() => {
    checkCurrentTab();
  });
});
