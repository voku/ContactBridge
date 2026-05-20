document.addEventListener('DOMContentLoaded', () => {
  const extensionApi = globalThis.ContactBridgeExtension;
  const configForm = document.getElementById('configForm');
  const apiUrlInput = document.getElementById('apiUrl');
  const apiUrlError = document.getElementById('apiUrlError');
  const apiUrlErrorText = document.getElementById('apiUrlErrorText');
  const captureBtn = document.getElementById('captureBtn');
  const captureSection = document.getElementById('captureSection');
  const profileDataDiv = document.getElementById('profileData');
  const statusDiv = document.getElementById('status');
  const supportsUserInvalid = globalThis.CSS?.supports?.('selector(:user-invalid)') ?? false;
  const defaultApiUrlErrorMessage = 'Enter a valid ContactBridge hub URL.';

  let currentProfile = null;
  let currentProfiles = [];
  let statusResetTimer = null;

  captureSection.inert = true;

  function clearStatus() {
    if (statusResetTimer !== null) {
      clearTimeout(statusResetTimer);
      statusResetTimer = null;
    }
    statusDiv.hidden = true;
    statusDiv.removeAttribute('data-variant');
    statusDiv.removeAttribute('role');
    statusDiv.setAttribute('aria-live', 'polite');
    statusDiv.textContent = '';
  }

  function queueStatusReset(delay = 2000) {
    if (statusResetTimer !== null) {
      clearTimeout(statusResetTimer);
    }
    statusResetTimer = globalThis.setTimeout(() => {
      clearStatus();
    }, delay);
  }

  function syncApiUrlFieldState(message = '') {
    const hasCustomError = apiUrlInput.validity.customError;
    const isUserInvalid = supportsUserInvalid && apiUrlInput.matches(':user-invalid');
    const isInvalid = hasCustomError || isUserInvalid;
    const nextMessage = message || (isInvalid ? apiUrlInput.validationMessage || defaultApiUrlErrorMessage : defaultApiUrlErrorMessage);

    apiUrlErrorText.textContent = nextMessage;
    apiUrlError.hidden = !isInvalid;

    if (isInvalid) {
      apiUrlInput.setAttribute('aria-invalid', 'true');
    } else {
      apiUrlInput.removeAttribute('aria-invalid');
    }
  }

  function setCaptureBusy(isBusy) {
    captureSection.setAttribute('aria-busy', String(isBusy));
  }

  chrome.storage.sync.get(['apiUrl'], (result) => {
    if (result.apiUrl) {
      const hubUrl = extensionApi.isAllowedHubUrl(result.apiUrl);
      if (hubUrl.ok) {
        apiUrlInput.value = hubUrl.url;
        apiUrlInput.setCustomValidity('');
        syncApiUrlFieldState();
        enableCapture();
      } else {
        chrome.storage.sync.remove(['apiUrl']);
        apiUrlInput.setCustomValidity(hubUrl.error);
        syncApiUrlFieldState(hubUrl.error);
      }
    }
  });

  configForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearStatus();
    apiUrlInput.setCustomValidity('');
    syncApiUrlFieldState();

    if (!apiUrlInput.reportValidity()) {
      syncApiUrlFieldState(apiUrlInput.validationMessage);
      return;
    }

    try {
      const hubUrl = await extensionApi.validateHubHealth(apiUrlInput.value);
      if (!hubUrl.ok) {
        apiUrlInput.setCustomValidity(hubUrl.error);
        syncApiUrlFieldState(hubUrl.error);
        apiUrlInput.reportValidity();
        apiUrlInput.focus();
        return;
      }

      chrome.storage.sync.set({ apiUrl: hubUrl.url }, () => {
        apiUrlInput.value = hubUrl.url;
        apiUrlInput.setCustomValidity('');
        syncApiUrlFieldState();
        enableCapture();
        showStatus('Configuration saved!', false);
        queueStatusReset();
      });
    } catch (error) {
      console.error('Hub validation error:', error);
      apiUrlInput.setCustomValidity('Hub validation failed unexpectedly.');
      syncApiUrlFieldState('Hub validation failed unexpectedly.');
      apiUrlInput.reportValidity();
      apiUrlInput.focus();
    }
  });

  apiUrlInput.addEventListener('blur', () => {
    syncApiUrlFieldState();
  });

  apiUrlInput.addEventListener('input', () => {
    if (apiUrlInput.validity.customError) {
      apiUrlInput.setCustomValidity('');
    }
    syncApiUrlFieldState();
  });

  apiUrlInput.addEventListener('invalid', () => {
    syncApiUrlFieldState(apiUrlInput.validationMessage);
  });

  function enableCapture() {
    captureSection.classList.remove('capture-disabled');
    captureSection.removeAttribute('aria-disabled');
    captureSection.inert = false;
    setCaptureBusy(false);
    checkCurrentTab();
  }

  function setCaptureButton(label, disabled, onClick) {
    captureBtn.textContent = label;
    captureBtn.disabled = disabled;
    captureBtn.onclick = null;
    if (onClick) {
      captureBtn.onclick = onClick;
    }
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
    setCaptureBusy(true);
    renderProfileMessage('Reading profile data...');
    setCaptureButton('Save this profile', true);
    chrome.runtime.sendMessage({ action: 'capture_profile', tabId }, (response) => {
      setCaptureBusy(false);
      if (chrome.runtime.lastError) {
        renderProfileMessage(`Cannot access this page: ${chrome.runtime.lastError.message}`);
        setCaptureButton('Save this profile', true);
        return;
      }

      if (response?.ok && response.profile) {
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
    setCaptureBusy(true);
    renderProfileMessage('Reading visible profiles...');
    setCaptureButton('Import visible profiles', true);
    chrome.runtime.sendMessage({ action: 'capture_profiles', tabId }, (response) => {
      setCaptureBusy(false);
      if (chrome.runtime.lastError) {
        renderProfileMessage(`Cannot access this page: ${chrome.runtime.lastError.message}`);
        setCaptureButton('Import visible profiles', true);
        return;
      }

      if (response?.ok && Array.isArray(response.profiles) && response.profiles.length > 0) {
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

      setCaptureBusy(true);
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
        queueStatusReset();
        setTimeout(() => {
          setCaptureBusy(false);
          setCaptureButton('Save this profile', false, saveProfile);
        }, 2000);
      })
      .catch(err => {
        setCaptureBusy(false);
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
      setCaptureBusy(true);
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
        queueStatusReset(2500);
        setTimeout(() => {
          setCaptureBusy(false);
          setCaptureButton('Import visible profiles', false, saveProfiles);
        }, 2500);
      })
      .catch(err => {
        setCaptureBusy(false);
        showStatus('Failed: ' + err.message, true);
        setCaptureButton('Import visible profiles', false, saveProfiles);
      });
    });
  }

  function showStatus(msg, isError) {
    statusDiv.textContent = msg;
    statusDiv.dataset.variant = isError ? 'error' : 'success';
    statusDiv.hidden = false;
    statusDiv.setAttribute('role', isError ? 'alert' : 'status');
    statusDiv.setAttribute('aria-live', isError ? 'assertive' : 'polite');
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
    appendProfileRow('Source', profiles[0]?.source || 'Not available', { capitalize: true });
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
