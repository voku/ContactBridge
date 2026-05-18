document.addEventListener('DOMContentLoaded', () => {
  const extensionApi = globalThis.ContactBridgeExtension;
  const apiUrlInput = document.getElementById('apiUrl');
  const saveConfigBtn = document.getElementById('saveConfigBtn');
  const captureBtn = document.getElementById('captureBtn');
  const captureSection = document.getElementById('captureSection');
  const profileDataDiv = document.getElementById('profileData');
  const statusDiv = document.getElementById('status');

  let currentProfile = null;
  let currentProfiles = [];
  let currentCaptureMode = 'profile';

  chrome.storage.sync.get(['apiUrl'], (result) => {
    if (result.apiUrl) {
      const hubUrl = extensionApi.isAllowedHubUrl(result.apiUrl);
      if (hubUrl.ok) {
        apiUrlInput.value = hubUrl.url;
        enableCapture();
      } else {
        chrome.storage.sync.remove(['apiUrl']);
        showStatus(hubUrl.error, true);
      }
    }
  });

  saveConfigBtn.addEventListener('click', async () => {
    try {
      const hubUrl = await extensionApi.validateHubHealth(apiUrlInput.value);
      if (!hubUrl.ok) {
        showStatus(hubUrl.error, true);
        return;
      }

      chrome.storage.sync.set({ apiUrl: hubUrl.url }, () => {
        apiUrlInput.value = hubUrl.url;
        enableCapture();
        showStatus('Configuration saved!', false);
        setTimeout(() => { statusDiv.style.display = 'none'; }, 2000);
      });
    } catch (error) {
      console.error('Hub validation error:', error);
      showStatus('Hub validation failed unexpectedly.', true);
    }
  });

  function enableCapture() {
    captureSection.style.opacity = '1';
    captureSection.style.pointerEvents = 'auto';
    checkCurrentTab();
  }

  function setCaptureButton(label, disabled, onClick) {
    captureBtn.textContent = label;
    captureBtn.disabled = disabled;
    captureBtn.onclick = onClick || null;
  }

  function renderProfileMessage(message) {
    const text = document.createElement('p');
    text.className = 'muted';
    text.textContent = message;
    profileDataDiv.replaceChildren(text);
  }

  function resetCurrentCapture() {
    currentProfile = null;
    currentProfiles = [];
    currentCaptureMode = 'profile';
  }

  function checkCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      
      const tab = tabs[0];
      const url = tab.url || '';
      if (typeof tab.id !== 'number') {
        resetCurrentCapture();
        renderProfileMessage('Active tab unavailable. Try focusing the page again.');
        setCaptureButton('Save this profile', true);
        return;
      }

      const profileContext = extensionApi.getProfileContext(url);
      if (profileContext.isSupported && profileContext.originPattern) {
        chrome.permissions.contains({ origins: [profileContext.originPattern] }, (hasPermission) => {
          if (hasPermission) {
            if (profileContext.captureMode === 'overview') {
              extractBatchData(tab.id);
            } else {
              extractData(tab.id);
            }
          } else {
            resetCurrentCapture();
            renderProfileMessage(
              profileContext.captureMode === 'overview'
                ? `Click below to allow access to ${profileContext.hostname} and import the visible profiles on this page.`
                : `Click below to allow access to ${profileContext.hostname} and capture this profile.`
            );
            setCaptureButton(
              profileContext.captureMode === 'overview' ? 'Grant Access & Import Visible Profiles' : 'Grant Access & Capture',
              false,
              () => {
              chrome.permissions.request({ origins: [profileContext.originPattern] }, (granted) => {
                if (granted) {
                  setCaptureButton('Save this profile', true);
                  checkCurrentTab();
                }
              });
            });
          }
        });
      } else {
        resetCurrentCapture();
        renderProfileMessage('Navigate to a supported profile or a visible LinkedIn people overview page to capture.');
        setCaptureButton('Save this profile', true);
      }
    });
  }

  function extractData(tabId) {
    resetCurrentCapture();
    renderProfileMessage('Reading profile data...');
    setCaptureButton('Save this profile', true);
    chrome.runtime.sendMessage({ action: 'capture_profile', tabId }, (response) => {
      if (chrome.runtime.lastError) {
        renderProfileMessage(`Cannot access this page: ${chrome.runtime.lastError.message}`);
        setCaptureButton('Save this profile', true);
        return;
      }

      if (response?.ok && response.profile) {
        currentCaptureMode = 'profile';
        currentProfile = response.profile;
        renderProfileData(response.profile);
        setCaptureButton('Save this profile', false, saveProfile);
        return;
      }

      renderProfileMessage(response?.error || 'Could not extract profile data from this page.');
      setCaptureButton('Save this profile', true);
    });
  }

  function extractBatchData(tabId) {
    resetCurrentCapture();
    renderProfileMessage('Reading visible profiles...');
    setCaptureButton('Import visible profiles', true);
    chrome.runtime.sendMessage({ action: 'capture_profiles', tabId }, (response) => {
      if (chrome.runtime.lastError) {
        renderProfileMessage(`Cannot access this page: ${chrome.runtime.lastError.message}`);
        setCaptureButton('Import visible profiles', true);
        return;
      }

      if (response?.ok && Array.isArray(response.profiles) && response.profiles.length > 0) {
        currentCaptureMode = 'overview';
        currentProfiles = response.profiles;
        renderProfileBatchData(response.profiles);
        setCaptureButton('Import visible profiles', false, saveProfiles);
        return;
      }

      renderProfileMessage(response?.error || 'Could not find any visible profiles to import from this page.');
      setCaptureButton('Import visible profiles', true);
    });
  }

  function saveProfile() {
    if (!currentProfile) return;
    
    chrome.storage.sync.get(['apiUrl'], (result) => {
      const hubUrl = extensionApi.isAllowedHubUrl(result.apiUrl);
      if (!hubUrl.ok) {
        showStatus(hubUrl.error, true);
        return;
      }
      const apiUrl = hubUrl.url;

      const payload = {
        ...currentProfile,
        capturedAt: new Date().toISOString()
      };

      setCaptureButton('Saving...', true);

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
          setCaptureButton('Save this profile', false, saveProfile);
          statusDiv.style.display = 'none';
        }, 2000);
      })
      .catch(err => {
        showStatus('Failed: ' + err.message, true);
        setCaptureButton('Save this profile', false, saveProfile);
      });
    });
  }

  function saveProfiles() {
    if (!currentProfiles.length) return;

    chrome.storage.sync.get(['apiUrl'], (result) => {
      const hubUrl = extensionApi.isAllowedHubUrl(result.apiUrl);
      if (!hubUrl.ok) {
        showStatus(hubUrl.error, true);
        return;
      }

      const apiUrl = hubUrl.url;
      const capturedAt = new Date().toISOString();
      setCaptureButton('Importing...', true);

      fetch(`${apiUrl.replace(/(\/)$/, '')}/api/capture/manual/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profiles: currentProfiles.map((profile) => ({
            ...profile,
            capturedAt
          }))
        })
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
        const message = data.successCount === 1
          ? 'Imported 1 visible profile. Review it in ContactBridge before approving.'
          : `Imported ${data.successCount} visible profiles. Review them in ContactBridge before approving.`;
        showStatus(message, false);
        setTimeout(() => {
          setCaptureButton('Import visible profiles', false, saveProfiles);
          statusDiv.style.display = 'none';
        }, 2500);
      })
      .catch(err => {
        showStatus('Failed: ' + err.message, true);
        setCaptureButton('Import visible profiles', false, saveProfiles);
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

  function renderProfileBatchData(profiles) {
    profileDataDiv.replaceChildren();
    appendProfileRow('Source', profiles[0]?.source || 'linkedin', { capitalize: true });
    appendProfileRow('Visible profiles', String(profiles.length));

    profiles.slice(0, 4).forEach((profile, index) => {
      appendProfileRow(index === 0 ? 'Preview' : '', profile.displayName || profile.handle || 'Not available', {
        marginTop: index === 0 ? '12px' : undefined
      });
      if (profile.headline) {
        appendProfileRow('', profile.headline, { muted: true });
      }
    });

    if (profiles.length > 4) {
      appendProfileRow('', `+${profiles.length - 4} more visible profiles`, { muted: true, marginTop: '12px' });
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
