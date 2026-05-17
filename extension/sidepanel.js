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
      
      if (url.includes('linkedin.com/in/') || url.includes('x.com/') || url.includes('twitter.com/') || url.includes('bsky.app/profile/')) {
        const origin = new URL(url).origin + '/*';
        
        chrome.permissions.contains({ origins: [origin] }, (hasPermission) => {
          if (hasPermission) {
            extractData(tab.id);
          } else {
            profileDataDiv.innerHTML = `<p class="muted">Click below to allow access to ${new URL(url).hostname} and capture this profile.</p>`;
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
        profileDataDiv.innerHTML = '<p class="muted">Navigate to a supported profile (LinkedIn, X, Bluesky) to capture.</p>';
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
          profileDataDiv.innerHTML = `
            <div class="data-row">
              <div class="data-label">Source</div>
              <div class="data-value" style="text-transform: capitalize;">${response.source}</div>
            </div>
            <div class="data-row">
              <div class="data-label">Name</div>
              <div class="data-value">${response.displayName}</div>
            </div>
            <div class="data-row">
              <div class="data-label">Handle</div>
              <div class="data-value">@${response.handle}</div>
            </div>
            ${response.headline ? `<div class="data-row" style="margin-top: 12px;"><div class="data-value" style="color: #4b5563; font-size: 0.8rem;">${response.headline}</div></div>` : ''}
          `;
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
        if (!res.ok) throw new Error('Network error');
        return res.json();
      })
      .then(data => {
        showStatus('Captured successfully!', false);
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

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.active) {
      checkCurrentTab();
    }
  });

  chrome.tabs.onActivated.addListener(() => {
    checkCurrentTab();
  });
});
