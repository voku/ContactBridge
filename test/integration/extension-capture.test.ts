import assert from 'node:assert/strict';
import test from 'node:test';

await import(new URL('../../extension/shared.js', import.meta.url).href);

const extensionApi = (globalThis as typeof globalThis & {
  ContactBridgeExtension: {
    CAPTURE_SCRIPT_FILES: string[];
    extractProfileFromDocument: (doc: any, url: string) => {
      displayName: string;
      handle: string;
      headline: string;
      profileUrl: string;
      source: string;
    };
    getProfileContext: (url: string) => {
      handle: string;
      hostname: string;
      isSupported: boolean;
      originPattern: string | null;
      profileUrl: string;
      source: string;
    };
    isAllowedHubUrl: (
      url: string,
      options?: { productionHubOrigins?: Set<string> }
    ) => { error: string; ok: boolean; url: string };
    validateHubHealth: (
      hubUrl: string,
      fetchImpl?: (url: string, options?: Record<string, unknown>) => Promise<{
        ok: boolean;
        json: () => Promise<Record<string, unknown>>;
      }>
    ) => Promise<{ error: string; ok: boolean; url: string }>;
    handleBackgroundMessage: (
      chromeApi: any,
      request: { action?: string; tabId?: number },
      sendResponse: (response: any) => void
    ) => boolean;
  };
}).ContactBridgeExtension;

const createDocument = (selectors: Record<string, string>, title = '') => ({
  querySelector(selector: string) {
    const value = selectors[selector];
    return value ? { innerText: value } : null;
  },
  title
});

test('getProfileContext only treats real profile URLs as capturable', () => {
  assert.equal(extensionApi.getProfileContext('https://www.linkedin.com/in/jane-demo').source, 'linkedin');
  assert.equal(extensionApi.getProfileContext('https://x.com/jane_demo').source, 'x');
  assert.equal(extensionApi.getProfileContext('https://x.com/home').isSupported, false);
  assert.equal(extensionApi.getProfileContext('https://x.com/explore').isSupported, false);
  assert.equal(extensionApi.getProfileContext('https://x.com/messages').isSupported, false);
  assert.equal(extensionApi.getProfileContext('https://bsky.app/profile/jane.test').source, 'bluesky');
  assert.equal(extensionApi.getProfileContext('https://www.xing.com/profile/Jane_Demo').source, 'xing');
  assert.equal(extensionApi.getProfileContext('not-a-url').isSupported, false);
});

test('extractProfileFromDocument reuses shared selectors for supported networks', () => {
  const linkedinProfile = extensionApi.extractProfileFromDocument(createDocument({
    '.text-body-medium': 'Product designer',
    h1: 'Jane Demo'
  }), 'https://www.linkedin.com/in/jane-demo');

  assert.deepEqual(linkedinProfile, {
    displayName: 'Jane Demo',
    handle: 'jane-demo',
    headline: 'Product designer',
    profileUrl: 'https://www.linkedin.com/in/jane-demo',
    source: 'linkedin'
  });

  const xingProfile = extensionApi.extractProfileFromDocument(createDocument({
    '[data-qa="profile-top-card-headline"]': 'Design lead'
  }, 'Jane Demo | XING'), 'https://www.xing.com/profile/Jane_Demo');

  assert.deepEqual(xingProfile, {
    displayName: 'Jane Demo',
    handle: 'Jane_Demo',
    headline: 'Design lead',
    profileUrl: 'https://www.xing.com/profile/Jane_Demo',
    source: 'xing'
  });

  const xingProfileTitleOnlyFallback = extensionApi.extractProfileFromDocument(createDocument({}, 'Jane Example | XING'),
    'https://www.xing.com/profile/Jane_Example');

  assert.deepEqual(xingProfileTitleOnlyFallback, {
    displayName: 'Jane Example',
    handle: 'Jane_Example',
    headline: '',
    profileUrl: 'https://www.xing.com/profile/Jane_Example',
    source: 'xing'
  });
});

test('isAllowedHubUrl enforces local-only default and allows explicitly packaged production origins', () => {
  assert.deepEqual(extensionApi.isAllowedHubUrl('http://localhost:3000'), {
    error: '',
    ok: true,
    url: 'http://localhost:3000'
  });

  const rejectedUnknownHub = extensionApi.isAllowedHubUrl('https://unknown.example.test');
  assert.equal(rejectedUnknownHub.ok, false);
  assert.match(rejectedUnknownHub.error, /only sends captures to local ContactBridge hubs/i);

  const allowedPackagedHub = extensionApi.isAllowedHubUrl('https://hub.example.test', {
    productionHubOrigins: new Set(['https://hub.example.test'])
  });
  assert.deepEqual(allowedPackagedHub, {
    error: '',
    ok: true,
    url: 'https://hub.example.test'
  });
});

test('validateHubHealth accepts compatible hubs and rejects incompatible ones', async () => {
  const okResponse = await extensionApi.validateHubHealth(
    'http://localhost:3000',
    async () => ({
      ok: true,
      json: async () => ({
        appName: 'ContactBridge',
        appMode: 'local',
        capabilities: ['capture.manual.v1']
      })
    })
  );
  assert.equal(okResponse.ok, true);
  assert.equal(okResponse.url, 'http://localhost:3000');

  const badResponse = await extensionApi.validateHubHealth(
    'http://localhost:3000',
    async () => ({
      ok: true,
      json: async () => ({
        appName: 'Not-ContactBridge',
        appMode: 'local',
        capabilities: []
      })
    })
  );
  assert.equal(badResponse.ok, false);
  assert.match(badResponse.error, /does not look like a compatible ContactBridge hub/i);
});

test('handleBackgroundMessage routes capture requests through script injection', async () => {
  const calls: Array<{ type: string; payload: any }> = [];
  const chromeApi = {
    runtime: {
      lastError: null as null | { message: string }
    },
    scripting: {
      executeScript(payload: any, callback: () => void) {
        calls.push({ payload, type: 'executeScript' });
        chromeApi.runtime.lastError = null;
        callback();
      }
    },
    tabs: {
      sendMessage(tabId: number, payload: any, callback: (response: any) => void) {
        calls.push({ payload: { payload, tabId }, type: 'sendMessage' });
        chromeApi.runtime.lastError = null;
        callback({
          displayName: 'Jane Demo',
          handle: 'jane-demo',
          headline: 'Product designer',
          profileUrl: 'https://www.linkedin.com/in/jane-demo',
          source: 'linkedin'
        });
      }
    }
  };

  const response = await new Promise<any>((resolve) => {
    const keepAlive = extensionApi.handleBackgroundMessage(chromeApi, { action: 'capture_profile', tabId: 42 }, resolve);
    assert.equal(keepAlive, true);
  });

  assert.deepEqual(calls, [
    {
      payload: {
        files: extensionApi.CAPTURE_SCRIPT_FILES,
        target: { tabId: 42 }
      },
      type: 'executeScript'
    },
    {
      payload: {
        payload: { action: 'get_profile' },
        tabId: 42
      },
      type: 'sendMessage'
    }
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.profile.handle, 'jane-demo');
});

test('handleBackgroundMessage returns injection errors to the side panel', async () => {
  const chromeApi = {
    runtime: {
      lastError: null as null | { message: string }
    },
    scripting: {
      executeScript(_payload: any, callback: () => void) {
        chromeApi.runtime.lastError = { message: 'Missing host permission' };
        callback();
      }
    },
    tabs: {
      sendMessage() {
        throw new Error('sendMessage should not be called when injection fails');
      }
    }
  };

  const response = await new Promise<any>((resolve) => {
    const keepAlive = extensionApi.handleBackgroundMessage(chromeApi, { action: 'capture_profile', tabId: 7 }, resolve);
    assert.equal(keepAlive, true);
  });

  assert.deepEqual(response, {
    error: 'Cannot access this page: Missing host permission',
    ok: false
  });
});
