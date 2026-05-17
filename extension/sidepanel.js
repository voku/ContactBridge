document.addEventListener('DOMContentLoaded', () => {
  const extensionApi = globalThis.ContactBridgeExtension;
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

  function renderProfileMessage(message) {
    const text = document.createElement('p');
    text.className = 'muted';
    text.textContent = message;
    profileDataDiv.replaceChildren(text);
  }

  function checkCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      
      const tab = tabs[0];
      const url = tab.url || '';
      if (typeof tab.id !== 'number') {
        currentProfile = null;
        renderProfileMessage('Active tab unavailable. Try focusing the page again.');
        captureBtn.disabled = true;
        captureBtn.textContent = 'Save this profile';
        return;
      }

      const profileContext = extensionApi.getProfileContext(url);
      if (profileContext.isSupported && profileContext.originPattern) {
        chrome.permissions.contains({ origins: [profileContext.originPattern] }, (hasPermission) => {
          if (hasPermission) {
            extractData(tab.id);
          } else {
            renderProfileMessage(`Click below to allow access to ${profileContext.hostname} and capture this profile.`);
            captureBtn.textContent = 'Grant Access & Capture';
            captureBtn.disabled = false;
            captureBtn.onclick = () => {
              chrome.permissions.request({ origins: [profileContext.originPattern] }, (granted) => {
                if (granted) {
                  captureBtn.textContent = 'Save this profile';
                  checkCurrentTab();
                }
              });
            };
          }
        });
      } else {
        currentProfile = null;
        renderProfileMessage('Navigate to a supported profile (LinkedIn, X, Bluesky, XING) to capture.');
        captureBtn.disabled = true;
        captureBtn.textContent = 'Save this profile';
      }
    });
  }

  function extractData(tabId) {
    currentProfile = null;
    renderProfileMessage('Reading profile data...');
    captureBtn.disabled = true;
    chrome.runtime.sendMessage({ action: 'capture_profile', tabId }, (response) => {
      if (chrome.runtime.lastError) {
        renderProfileMessage(`Cannot access this page: ${chrome.runtime.lastError.message}`);
        captureBtn.textContent = 'Save this profile';
        return;
      }

      if (response?.ok && response.profile) {
        currentProfile = response.profile;
        renderProfileData(response.profile);
        captureBtn.disabled = false;
        captureBtn.textContent = 'Save this profile';
        captureBtn.onclick = saveProfile;
        return;
      }

      renderProfileMessage(response?.error || 'Could not extract profile data from this page.');
      captureBtn.textContent = 'Save this profile';
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
