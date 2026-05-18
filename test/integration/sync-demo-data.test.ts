import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const demoDataDir = path.join(repoRoot, 'test', 'demo-data');
const MAX_HEALTH_CHECK_ATTEMPTS = 50;
const HEALTH_CHECK_INTERVAL_MS = 200;
const SERVER_SHUTDOWN_TIMEOUT_MS = 5_000;

type SyncCase = {
  name: string;
  sourceType: string;
  endpoint: string;
  payload: Record<string, unknown>;
  expectedNames: string[];
};

const syncCases: SyncCase[] = [
  {
    name: 'bluesky',
    sourceType: 'bluesky',
    endpoint: '/api/sync/bluesky',
    payload: { identifier: 'demo.bsky.social', password: 'demo-app-password' },
    expectedNames: ['Alice Demo', 'Bob Demo']
  },
  {
    name: 'mastodon',
    sourceType: 'mastodon',
    endpoint: '/api/sync/mastodon',
    payload: { instance: 'mastodon.social', token: 'demo-token' },
    expectedNames: ['Carol Demo', 'Dave Demo']
  },
  {
    name: 'x',
    sourceType: 'x',
    endpoint: '/api/sync/x',
    payload: { accessToken: 'demo-token' },
    expectedNames: ['Eve Demo', 'Frank Demo']
  },
  {
    name: 'linkedin',
    sourceType: 'linkedin',
    endpoint: '/api/sync/linkedin',
    payload: { handle: 'demo-linkedin', token: 'demo-token' },
    expectedNames: ['Grace Demo', 'Heidi Demo']
  },
  {
    name: 'github',
    sourceType: 'github',
    endpoint: '/api/sync/github',
    payload: { token: 'demo-token' },
    expectedNames: ['ivan-demo', 'judy-demo']
  },
  {
    name: 'google',
    sourceType: 'google',
    endpoint: '/api/sync/google',
    payload: { token: 'demo-token' },
    expectedNames: ['Cathy Demo', 'Louis Demo']
  }
];

type ServerHandle = {
  baseUrl: string;
  process: ChildProcessWithoutNullStreams;
  tempDir: string;
  dbPath: string;
};

type StartServerOptions = {
  appMode?: string;
  demoDataDir?: string;
  envOverrides?: Record<string, string | undefined>;
  healthCheckOrigin?: string;
  nodeEnv?: string;
};

const getFreePort = async (): Promise<number> => {
  const server = await import('node:net').then(({ createServer }) => createServer());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || !address || address.port === 0) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    throw new Error('Failed to allocate a test port');
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
};

const waitForHealth = async (baseUrl: string, options: { origin?: string } = {}) => {
  for (let attempt = 0; attempt < MAX_HEALTH_CHECK_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        ...(options.origin ? { headers: { Origin: options.origin } } : {})
      });
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(HEALTH_CHECK_INTERVAL_MS);
  }

  throw new Error(`Server did not become healthy: ${baseUrl}`);
};

const startServer = async (options: StartServerOptions = {}): Promise<ServerHandle> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contactbridge-it-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = path.join(tempDir, 'test.sqlite');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONTACTBRIDGE_DB_PATH: dbPath,
    CONTACTBRIDGE_DEMO_DATA_DIR: options.demoDataDir || demoDataDir,
    CONTACTBRIDGE_DISABLE_FRONTEND: '1',
    NODE_ENV: options.nodeEnv || 'test',
    PORT: String(port),
    ...options.envOverrides
  };
  if (options.appMode !== undefined) {
    env.APP_MODE = options.appMode;
  }
  const serverProcess = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'server.ts')],
    {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let stderr = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  serverProcess.once('exit', (code) => {
    if (code !== null && code !== 0 && !stderr.trim()) {
      stderr = `Server exited early with code ${code}`;
    }
  });

  try {
    await waitForHealth(baseUrl, { origin: options.healthCheckOrigin });
  } catch (error) {
    serverProcess.kill('SIGTERM');
    throw new Error([(error as Error).message, stderr].filter(Boolean).join('\n'));
  }

  return { baseUrl, process: serverProcess, tempDir, dbPath };
};

const startServerExpectFailure = async (options: StartServerOptions = {}) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contactbridge-it-fail-'));
  const port = await getFreePort();
  const dbPath = path.join(tempDir, 'test.sqlite');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CONTACTBRIDGE_DB_PATH: dbPath,
    CONTACTBRIDGE_DEMO_DATA_DIR: options.demoDataDir || demoDataDir,
    CONTACTBRIDGE_DISABLE_FRONTEND: '1',
    NODE_ENV: options.nodeEnv || 'test',
    PORT: String(port),
    ...options.envOverrides
  };
  if (options.appMode !== undefined) {
    env.APP_MODE = options.appMode;
  }

  const serverProcess = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'server.ts')],
    {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  let output = '';
  serverProcess.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  serverProcess.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => serverProcess.once('exit', (code) => resolve(code))),
    delay(5_000).then(() => null)
  ]);

  if (exitCode === null) {
    serverProcess.kill('SIGTERM');
    await new Promise<void>((resolve) => serverProcess.once('exit', () => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
    throw new Error('Expected server startup to fail, but it stayed running.');
  }

  await fs.rm(tempDir, { recursive: true, force: true });
  return { exitCode, output };
};

const stopServer = async ({ process, tempDir }: ServerHandle) => {
  if (!process.killed) {
    process.kill('SIGTERM');
    const exitedCleanly = await Promise.race([
      new Promise<boolean>((resolve) => process.once('exit', () => resolve(true))),
      delay(SERVER_SHUTDOWN_TIMEOUT_MS).then(() => false)
    ]);

    if (!exitedCleanly && !process.killed) {
      process.kill('SIGKILL');
      await new Promise<void>((resolve) => process.once('exit', () => resolve()));
    }
  }

  await fs.rm(tempDir, { recursive: true, force: true });
};

const postJson = async <T>(baseUrl: string, pathname: string, body: Record<string, unknown>): Promise<T> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  assert.equal(response.ok, true, `Expected ${pathname} to succeed`);
  return response.json() as Promise<T>;
};

const getJson = async <T>(baseUrl: string, pathname: string): Promise<T> => {
  const response = await fetch(`${baseUrl}${pathname}`);
  assert.equal(response.ok, true, `Expected ${pathname} to succeed`);
  return response.json() as Promise<T>;
};

const getText = async (
  baseUrl: string,
  pathname: string,
  options: { headers?: Record<string, string> } = {}
) => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...(options.headers ? { headers: options.headers } : {})
  });
  assert.equal(response.ok, true, `Expected ${pathname} to succeed`);
  return response.text();
};

const deleteJson = async <T>(baseUrl: string, pathname: string): Promise<T> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'DELETE',
    headers: pathname === '/api/database' ? { 'X-ContactBridge-Confirm-Reset': 'erase-local-data' } : undefined
  });
  assert.equal(response.ok, true, `Expected ${pathname} to succeed`);
  return response.json() as Promise<T>;
};

const patchJson = async <T>(baseUrl: string, pathname: string, body: Record<string, unknown>): Promise<T> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  assert.equal(response.ok, true, `Expected ${pathname} to succeed`);
  return response.json() as Promise<T>;
};

const postSync = async <T>(baseUrl: string, pathname: string, body: Record<string, unknown>): Promise<T> => {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  assert.equal(response.ok, true, `Expected ${pathname} to succeed`);
  const text = await response.text();
  const payloads = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const successPayload = payloads.find((payload) => payload.type === 'success');
  assert.ok(successPayload, `Expected ${pathname} to emit a success payload`);
  return successPayload as T;
};

for (const syncCase of syncCases) {
  test(`syncs ${syncCase.name} demo data end-to-end`, async (t) => {
    const server = await startServer();
    t.after(() => stopServer(server));

    const sourceAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
      sourceType: syncCase.sourceType,
      accountIdentifier: `${syncCase.name}-demo-account`,
      displayName: `${syncCase.name} demo`,
      authStatus: 'pending'
    });

    const syncResult = await postSync<{ success: boolean; count: number; insertedCount: number; updatedCount: number }>(
      server.baseUrl,
      syncCase.endpoint,
      {
        sourceAccountId: sourceAccount.id,
        ...syncCase.payload
      }
    );

    assert.equal(syncResult.success, true);
    assert.equal(syncResult.count, syncCase.expectedNames.length);
    assert.equal(syncResult.insertedCount, syncCase.expectedNames.length);
    assert.equal(syncResult.updatedCount, 0);

    const accounts = await getJson<Array<{ id: string; authStatus: string }>>(server.baseUrl, '/api/source-accounts');
    assert.equal(accounts.find((account) => account.id === sourceAccount.id)?.authStatus, 'connected');

    const candidates = await getJson<Array<{ canonicalName: string; profiles: Array<{ sourceType: string }> }>>(server.baseUrl, '/api/candidates');
    assert.deepEqual(
      candidates.map((candidate) => candidate.canonicalName).sort(),
      [...syncCase.expectedNames].sort()
    );
    assert.ok(
      candidates.every((candidate) => candidate.profiles.length === 1 && candidate.profiles[0]?.sourceType === syncCase.sourceType)
    );

    const dashboard = await getJson<{ totalCandidates: number; indexedProfiles: number; failedSyncJobs: number }>(server.baseUrl, '/api/dashboard');
    assert.equal(dashboard.totalCandidates, syncCase.expectedNames.length);
    assert.equal(dashboard.indexedProfiles, syncCase.expectedNames.length);
    assert.equal(dashboard.failedSyncJobs, 0);

    const jobs = await getJson<Array<{ status: string; sourceType: string }>>(server.baseUrl, '/api/dashboard/sync-jobs');
    assert.ok(jobs.length > 0);
    assert.equal(jobs[0]?.status, 'completed');
    assert.equal(jobs[0]?.sourceType, syncCase.sourceType);
  });
}

test('sync preserves both relationship directions for mutual Bluesky profiles', async (t) => {
  const overrideDemoDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'contactbridge-demo-'));
  const overrideDemoDataDir = path.join(overrideDemoDataRoot, 'fixtures');
  await fs.cp(demoDataDir, overrideDemoDataDir, { recursive: true });
  t.after(async () => {
    await fs.rm(overrideDemoDataRoot, { recursive: true, force: true });
  });

  const blueskyFixturePath = path.join(overrideDemoDataDir, 'bluesky.json');
  const blueskyFixture = JSON.parse(await fs.readFile(blueskyFixturePath, 'utf8'));
  const mutualProfile = blueskyFixture.followersResponse.followers[0];
  blueskyFixture.followsResponse.follows.push({
    ...mutualProfile,
    viewer: {
      followedBy: mutualProfile.viewer.followedBy,
      following: 'at://did:plc:contactbridge-demo/app.bsky.graph.follow/alice-mutual-follow'
    }
  });
  await fs.writeFile(blueskyFixturePath, JSON.stringify(blueskyFixture, null, 2));

  const server = await startServer({ demoDataDir: overrideDemoDataDir });
  t.after(() => stopServer(server));

  const sourceAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'bluesky',
    accountIdentifier: 'bluesky-demo-account',
    displayName: 'bluesky demo',
    authStatus: 'pending'
  });

  await postSync<{ success: boolean }>(server.baseUrl, '/api/sync/bluesky', {
    sourceAccountId: sourceAccount.id,
    identifier: 'demo.bsky.social',
    password: 'demo-app-password'
  });

  const sqlite = new Database(server.dbPath);
  t.after(() => sqlite.close());

  const relationships = sqlite.prepare(`
    SELECT relation_type AS relationType
    FROM relationship_edges
    WHERE source_account_id = ?
      AND social_profile_id = (
        SELECT id FROM social_profiles WHERE source_type = 'bluesky' AND source_profile_id = ?
      )
    ORDER BY relation_type
  `).all(sourceAccount.id, mutualProfile.did) as Array<{ relationType: string }>;

  assert.deepEqual(relationships.map((relationship) => relationship.relationType), ['followed_by', 'follows']);

  const candidates = await getJson<Array<{
    canonicalName: string;
    profiles: Array<{ sourceType: string; relations: string[] }>;
    relationshipSummary: {
      relationTypes: string[];
      profilesWithRelationships: number;
      mutualProfileCount: number;
      followsCount: number;
      followedByCount: number;
    };
  }>>(server.baseUrl, '/api/candidates');

  const mutualCandidate = candidates.find((candidate) => candidate.canonicalName === mutualProfile.displayName);
  assert.ok(mutualCandidate);
  assert.equal(mutualCandidate.relationshipSummary.mutualProfileCount, 1);
  assert.equal(mutualCandidate.relationshipSummary.profilesWithRelationships, 1);
  assert.equal(mutualCandidate.relationshipSummary.followsCount, 1);
  assert.equal(mutualCandidate.relationshipSummary.followedByCount, 1);
  assert.deepEqual(mutualCandidate.relationshipSummary.relationTypes, ['followed_by', 'follows']);
  assert.deepEqual(mutualCandidate.profiles[0]?.relations, ['followed_by', 'follows']);
});

test('manual captures stay reviewable until approved and preserve notes', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const captureResult = await postJson<{ id: string; status: string }>(server.baseUrl, '/api/capture/manual', {
    source: 'linkedin',
    profileUrl: 'https://www.linkedin.com/in/jane-demo',
    displayName: 'Jane Demo',
    handle: 'jane-demo',
    headline: 'Product designer'
  });

  assert.equal(captureResult.status, 'pending');

  let candidates = await getJson<Array<{
    id: string;
    canonicalName: string;
    status: string;
    notes: string | null;
    profiles: Array<{ profileUrl: string | null; sourceType: string; handle: string | null }>;
  }>>(server.baseUrl, '/api/candidates');

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.status, 'pending');
  assert.equal(candidates[0]?.profiles[0]?.profileUrl, 'https://www.linkedin.com/in/jane-demo');

  await patchJson<{ success: boolean }>(server.baseUrl, `/api/candidates/${captureResult.id}`, {
    status: 'approved',
    notes: 'Met at FOSDEM'
  });

  const updatedCandidates = await getJson<Array<{
    id: string;
    status: string;
    notes: string | null;
  }>>(server.baseUrl, '/api/candidates');

  assert.equal(updatedCandidates.length, 1);
  assert.equal(updatedCandidates[0]?.id, captureResult.id);
  assert.equal(updatedCandidates[0]?.status, 'approved');
  assert.equal(updatedCandidates[0]?.notes, 'Met at FOSDEM');

  const dashboard = await getJson<{ totalCandidates: number; approvedContacts: number; indexedProfiles: number; failedSyncJobs: number }>(
    server.baseUrl,
    '/api/dashboard'
  );

  assert.deepEqual(dashboard, {
    totalCandidates: 0,
    approvedContacts: 1,
    indexedProfiles: 1,
    failedSyncJobs: 0
  });
});

test('manual capture reuses the same candidate for the same normalized profile', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const firstCapture = await postJson<{ id: string; status: string }>(server.baseUrl, '/api/capture/manual', {
    source: 'x',
    profileUrl: 'https://x.com/Jane-Demo',
    displayName: 'Jane Demo',
    handle: 'Jane-Demo',
    headline: 'Product designer'
  });

  const secondCapture = await postJson<{ id: string; status: string }>(server.baseUrl, '/api/capture/manual', {
    source: 'x',
    profileUrl: 'https://x.com/jane-demo',
    displayName: 'Jane D.',
    headline: 'Design lead'
  });

  assert.equal(secondCapture.id, firstCapture.id);
  assert.equal(secondCapture.status, 'pending');

  const candidates = await getJson<Array<{
    id: string;
    profiles: Array<{ handle: string | null; displayName: string | null; bio: string | null }>;
  }>>(server.baseUrl, '/api/candidates');

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.id, firstCapture.id);
  assert.equal(candidates[0]?.profiles.length, 1);
  assert.equal(candidates[0]?.profiles[0]?.handle, 'jane-demo');
  assert.equal(candidates[0]?.profiles[0]?.displayName, 'Jane D.');
  assert.equal(candidates[0]?.profiles[0]?.bio, 'Design lead');
});

test('manual capture supports xing profile URLs', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const firstCapture = await postJson<{ id: string; status: string }>(server.baseUrl, '/api/capture/manual', {
    source: 'xing',
    profileUrl: 'https://www.xing.com/profile/Jane_Demo',
    displayName: 'Jane Demo',
    headline: 'Product designer'
  });

  const secondCapture = await postJson<{ id: string; status: string }>(server.baseUrl, '/api/capture/manual', {
    source: 'xing',
    profileUrl: 'https://www.xing.com/profile/jane_demo',
    displayName: 'Jane D.',
    headline: 'Design lead'
  });

  assert.equal(secondCapture.id, firstCapture.id);
  assert.equal(secondCapture.status, 'pending');

  const candidates = await getJson<Array<{
    id: string;
    profiles: Array<{ sourceType: string; profileUrl: string | null; displayName: string | null; bio: string | null }>;
  }>>(server.baseUrl, '/api/candidates');

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.id, firstCapture.id);
  assert.equal(candidates[0]?.profiles.length, 1);
  assert.equal(candidates[0]?.profiles[0]?.sourceType, 'xing');
  assert.equal(candidates[0]?.profiles[0]?.profileUrl, 'https://www.xing.com/profile/jane_demo');
  assert.equal(candidates[0]?.profiles[0]?.displayName, 'Jane D.');
  assert.equal(candidates[0]?.profiles[0]?.bio, 'Design lead');
});

test('merging candidates preserves notes and combined profiles', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const primaryCapture = await postJson<{ id: string }>(server.baseUrl, '/api/capture/manual', {
    source: 'x',
    profileUrl: 'https://x.com/alice-demo',
    displayName: 'Alice Demo',
    handle: 'alice-demo',
    headline: 'Founder'
  });
  const secondaryCapture = await postJson<{ id: string }>(server.baseUrl, '/api/capture/manual', {
    source: 'bluesky',
    profileUrl: 'https://bsky.app/profile/alice-demo-bsky',
    displayName: 'Alice D.',
    handle: 'alice-demo-bsky',
    headline: 'Builder'
  });

  await patchJson(server.baseUrl, `/api/candidates/${primaryCapture.id}`, { notes: 'Met in person' });
  await patchJson(server.baseUrl, `/api/candidates/${secondaryCapture.id}`, { notes: 'Follow up next week' });

  await postJson<{ success: boolean }>(server.baseUrl, '/api/candidates/merge', {
    primaryCandidateId: primaryCapture.id,
    secondaryCandidateIds: [secondaryCapture.id]
  });

  const candidates = await getJson<Array<{
    id: string;
    canonicalName: string;
    notes: string | null;
    profiles: Array<{ sourceType: string }>;
  }>>(server.baseUrl, '/api/candidates');

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.id, primaryCapture.id);
  assert.equal(candidates[0]?.canonicalName, 'Alice Demo');
  assert.equal(candidates[0]?.notes, 'Met in person\n\nFollow up next week');
  assert.deepEqual(candidates[0]?.profiles.map((profile) => profile.sourceType).sort(), ['bluesky', 'x']);
});

test('re-syncing a source removes stale relationships and orphaned contacts', async (t) => {
  const overrideDemoDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'contactbridge-demo-'));
  const overrideDemoDataDir = path.join(overrideDemoDataRoot, 'fixtures');
  await fs.cp(demoDataDir, overrideDemoDataDir, { recursive: true });
  t.after(async () => {
    await fs.rm(overrideDemoDataRoot, { recursive: true, force: true });
  });

  const server = await startServer({ demoDataDir: overrideDemoDataDir });
  t.after(() => stopServer(server));

  const sourceAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'github',
    accountIdentifier: 'github-demo-account',
    displayName: 'github demo',
    authStatus: 'pending'
  });

  await postSync(server.baseUrl, '/api/sync/github', {
    sourceAccountId: sourceAccount.id,
    token: 'demo-token'
  });

  await fs.writeFile(
    path.join(overrideDemoDataDir, 'github.json'),
    JSON.stringify({
      followersResponse: [
        {
          login: 'ivan-demo',
          id: 101,
          avatar_url: 'https://avatars.githubusercontent.com/u/101?v=4',
          url: 'https://api.github.com/users/ivan-demo'
        }
      ],
      followingResponse: []
    }, null, 2)
  );

  const secondSync = await postSync<{ success: boolean; count: number; insertedCount: number; updatedCount: number }>(
    server.baseUrl,
    '/api/sync/github',
    {
      sourceAccountId: sourceAccount.id,
      token: 'demo-token'
    }
  );

  assert.equal(secondSync.success, true);
  assert.equal(secondSync.count, 1);

  const candidates = await getJson<Array<{ canonicalName: string }>>(server.baseUrl, '/api/candidates');
  assert.deepEqual(candidates.map((candidate) => candidate.canonicalName), ['ivan-demo']);

  const dashboard = await getJson<{ totalCandidates: number; approvedContacts: number; indexedProfiles: number; failedSyncJobs: number }>(
    server.baseUrl,
    '/api/dashboard'
  );
  assert.deepEqual(dashboard, {
    totalCandidates: 1,
    approvedContacts: 0,
    indexedProfiles: 1,
    failedSyncJobs: 0
  });
});

test('disconnecting a source account removes imported contacts and profiles', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const sourceAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'github',
    accountIdentifier: 'github-demo-account',
    displayName: 'github demo',
    authStatus: 'pending'
  });

  await postSync<{ success: boolean }>(server.baseUrl, '/api/sync/github', {
    sourceAccountId: sourceAccount.id,
    token: 'demo-token'
  });

  await deleteJson<{ success: boolean }>(server.baseUrl, `/api/source-accounts/${sourceAccount.id}`);

  const accounts = await getJson<Array<{ id: string }>>(server.baseUrl, '/api/source-accounts');
  assert.equal(accounts.length, 0);

  const candidates = await getJson<Array<{ id: string }>>(server.baseUrl, '/api/candidates');
  assert.equal(candidates.length, 0);

  const dashboard = await getJson<{ totalCandidates: number; approvedContacts: number; indexedProfiles: number; failedSyncJobs: number }>(
    server.baseUrl,
    '/api/dashboard'
  );
  assert.deepEqual(dashboard, {
    totalCandidates: 0,
    approvedContacts: 0,
    indexedProfiles: 0,
    failedSyncJobs: 0
  });

  const jobs = await getJson<Array<{ id: string }>>(server.baseUrl, '/api/dashboard/sync-jobs');
  assert.equal(jobs.length, 0);
});

test('x sync can reuse stored OAuth credentials without exposing auth data', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const sourceAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'x',
    accountIdentifier: 'X OAuth',
    displayName: 'X (Twitter)',
    authStatus: 'pending'
  });

  const sqlite = new Database(server.dbPath);
  t.after(() => sqlite.close());
  sqlite.prepare('UPDATE source_accounts SET auth_data = ? WHERE id = ?').run(
    JSON.stringify({ accessToken: 'stored-demo-token', refreshToken: 'stored-refresh-token' }),
    sourceAccount.id
  );

  const syncResult = await postSync<{ success: boolean; count: number }>(server.baseUrl, '/api/sync/x', {
    sourceAccountId: sourceAccount.id
  });

  assert.equal(syncResult.success, true);
  assert.equal(syncResult.count, 2);

  const accounts = await getJson<Array<Record<string, unknown>>>(server.baseUrl, '/api/source-accounts');
  const account = accounts.find((entry) => entry.id === sourceAccount.id);
  assert.ok(account);
  assert.equal('authData' in account, false);
});

test('google sync can reuse stored OAuth credentials', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const sourceAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'google',
    accountIdentifier: 'Google Contacts',
    displayName: 'Google',
    authStatus: 'pending'
  });

  const sqlite = new Database(server.dbPath);
  t.after(() => sqlite.close());
  sqlite.prepare('UPDATE source_accounts SET auth_data = ? WHERE id = ?').run(
    JSON.stringify({
      tokens: {
        access_token: 'stored-google-token',
        refresh_token: 'stored-google-refresh-token'
      },
      clientId: 'demo-google-client',
      clientSecret: 'demo-google-secret'
    }),
    sourceAccount.id
  );

  const syncResult = await postSync<{ success: boolean; count: number }>(server.baseUrl, '/api/sync/google', {
    sourceAccountId: sourceAccount.id
  });

  assert.equal(syncResult.success, true);
  assert.equal(syncResult.count, 2);
});

test('erases all stored demo data', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const sourceAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'github',
    accountIdentifier: 'github-demo-account',
    displayName: 'github demo',
    authStatus: 'pending'
  });

  await postSync<{ success: boolean }>(server.baseUrl, '/api/sync/github', {
    sourceAccountId: sourceAccount.id,
    token: 'demo-token'
  });

  const eraseResult = await deleteJson<{ success: boolean }>(server.baseUrl, '/api/database');
  assert.equal(eraseResult.success, true);

  const accounts = await getJson<Array<{ id: string }>>(server.baseUrl, '/api/source-accounts');
  assert.equal(accounts.length, 0);

  const candidates = await getJson<Array<{ id: string }>>(server.baseUrl, '/api/candidates');
  assert.equal(candidates.length, 0);

  const dashboard = await getJson<{ totalCandidates: number; approvedContacts: number; indexedProfiles: number; failedSyncJobs: number }>(
    server.baseUrl,
    '/api/dashboard'
  );
  assert.deepEqual(dashboard, {
    totalCandidates: 0,
    approvedContacts: 0,
    indexedProfiles: 0,
    failedSyncJobs: 0
  });

  const jobs = await getJson<Array<{ id: string }>>(server.baseUrl, '/api/dashboard/sync-jobs');
  assert.equal(jobs.length, 0);
});

test('runtime mode defaults follow NODE_ENV and health exposes appMode only', async (t) => {
  const testModeServer = await startServer({ envOverrides: { APP_MODE: undefined }, nodeEnv: 'test' });
  t.after(() => stopServer(testModeServer));
  const testHealth = await getJson<Record<string, unknown>>(testModeServer.baseUrl, '/api/health');
  assert.deepEqual(Object.keys(testHealth).sort(), ['appMode', 'status']);
  assert.equal(testHealth.appMode, 'test');

  const localModeServer = await startServer({ envOverrides: { APP_MODE: undefined }, nodeEnv: 'development' });
  t.after(() => stopServer(localModeServer));
  const localHealth = await getJson<Record<string, unknown>>(localModeServer.baseUrl, '/api/health');
  assert.equal(localHealth.appMode, 'local');

  const hostedModeServer = await startServer({
    envOverrides: {
      APP_MODE: undefined,
      CONTACTBRIDGE_CORS_ORIGINS: 'https://ui.example.test',
      CONTACTBRIDGE_SECRET_KEY: 'hosted-test-secret'
    },
    healthCheckOrigin: 'https://ui.example.test',
    nodeEnv: 'production'
  });
  t.after(() => stopServer(hostedModeServer));
  const hostedHealthResponse = await fetch(`${hostedModeServer.baseUrl}/api/health`, {
    headers: { Origin: 'https://ui.example.test' }
  });
  assert.equal(hostedHealthResponse.ok, true);
  const hostedHealth = await hostedHealthResponse.json() as Record<string, unknown>;
  assert.equal(hostedHealth.appMode, 'hosted');
});

test('invalid APP_MODE fails startup', async () => {
  const failure = await startServerExpectFailure({ appMode: 'broken-mode' });
  assert.notEqual(failure.exitCode, 0);
  assert.match(failure.output, /Invalid APP_MODE/);
});

test('hosted startup fails without CONTACTBRIDGE_SECRET_KEY', async () => {
  const failure = await startServerExpectFailure({
    appMode: 'hosted',
    nodeEnv: 'production',
    envOverrides: {
      CONTACTBRIDGE_SECRET_KEY: '',
      CONTACTBRIDGE_CORS_ORIGINS: 'https://ui.example.test'
    }
  });
  assert.notEqual(failure.exitCode, 0);
  assert.match(failure.output, /CONTACTBRIDGE_SECRET_KEY is required at startup/);
});

test('database erase route requires explicit confirmation and stays blocked in hosted mode', async (t) => {
  const localServer = await startServer();
  t.after(() => stopServer(localServer));

  const missingHeaderResponse = await fetch(`${localServer.baseUrl}/api/database`, { method: 'DELETE' });
  assert.equal(missingHeaderResponse.status, 400);

  const allowedResponse = await fetch(`${localServer.baseUrl}/api/database`, {
    method: 'DELETE',
    headers: { 'X-ContactBridge-Confirm-Reset': 'erase-local-data' }
  });
  assert.equal(allowedResponse.status, 200);

  const hostedServer = await startServer({
    appMode: 'hosted',
    nodeEnv: 'production',
    envOverrides: {
      CONTACTBRIDGE_CORS_ORIGINS: 'https://ui.example.test',
      CONTACTBRIDGE_SECRET_KEY: 'hosted-test-secret'
    },
    healthCheckOrigin: 'https://ui.example.test'
  });
  t.after(() => stopServer(hostedServer));

  const hostedDeleteResponse = await fetch(`${hostedServer.baseUrl}/api/database`, {
    method: 'DELETE',
    headers: {
      Origin: 'https://ui.example.test',
      'X-ContactBridge-Confirm-Reset': 'erase-local-data'
    }
  });
  assert.equal(hostedDeleteResponse.status, 403);
});

test('database backup works in test and local mode, and restore reloads backed-up data', async (t) => {
  const testServer = await startServer();
  t.after(() => stopServer(testServer));

  const sourceAccount = await postJson<{ id: string }>(testServer.baseUrl, '/api/source-accounts', {
    sourceType: 'github',
    accountIdentifier: 'demo-backup-account',
    displayName: 'Demo Backup Account',
    authStatus: 'connected'
  });

  const candidate = await postJson<{ id: string }>(testServer.baseUrl, '/api/capture/manual', {
    source: 'linkedin',
    profileUrl: 'https://www.linkedin.com/in/backup-person',
    displayName: 'Backup Person',
    handle: 'backup-person'
  });
  await patchJson(testServer.baseUrl, `/api/candidates/${candidate.id}`, { status: 'approved' });

  const backupResponse = await fetch(`${testServer.baseUrl}/api/database/backup`);
  assert.equal(backupResponse.ok, true);
  const backup = await backupResponse.json() as {
    format: string;
    tables: Record<string, Array<Record<string, unknown>>>;
  };
  assert.equal(backup.format, 'contactbridge-backup-v1');
  assert.equal(backup.tables.source_accounts.length, 1);
  assert.equal(backup.tables.contact_candidates.length, 1);

  const localServer = await startServer({ appMode: 'local', nodeEnv: 'development' });
  t.after(() => stopServer(localServer));

  const restoreResponse = await fetch(`${localServer.baseUrl}/api/database/restore`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ContactBridge-Confirm-Restore': 'restore-local-data'
    },
    body: JSON.stringify(backup)
  });
  assert.equal(restoreResponse.ok, true);

  const localBackupResponse = await fetch(`${localServer.baseUrl}/api/database/backup`);
  assert.equal(localBackupResponse.ok, true);

  const restoredDashboard = await getJson<{ approvedContacts: number; indexedProfiles: number }>(localServer.baseUrl, '/api/dashboard');
  assert.equal(restoredDashboard.approvedContacts, 1);
  assert.equal(restoredDashboard.indexedProfiles, 1);

  const restoredSourceAccounts = await getJson<Array<{ id: string }>>(localServer.baseUrl, '/api/source-accounts');
  assert.deepEqual(restoredSourceAccounts.map((account) => account.id), [sourceAccount.id]);
});

test('database backup stays blocked in hosted mode', async (t) => {
  const hostedServer = await startServer({
    appMode: 'hosted',
    nodeEnv: 'production',
    envOverrides: {
      CONTACTBRIDGE_CORS_ORIGINS: 'https://ui.example.test',
      CONTACTBRIDGE_SECRET_KEY: 'hosted-test-secret'
    },
    healthCheckOrigin: 'https://ui.example.test'
  });
  t.after(() => stopServer(hostedServer));

  const response = await fetch(`${hostedServer.baseUrl}/api/database/backup`, {
    headers: { Origin: 'https://ui.example.test' }
  });
  assert.equal(response.status, 403);
});

test('database restore requires explicit confirmation header', async (t) => {
  const localServer = await startServer({ appMode: 'local', nodeEnv: 'development' });
  t.after(() => stopServer(localServer));

  const response = await fetch(`${localServer.baseUrl}/api/database/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      format: 'contactbridge-backup-v1',
      tables: {
        app_settings: [],
        source_accounts: [],
        source_account_secrets: [],
        social_profiles: [],
        contact_candidates: [],
        contact_candidate_profiles: [],
        candidate_match_evidence: [],
        sync_jobs: [],
        relationship_edges: []
      }
    })
  });
  assert.equal(response.status, 400);
});

test('database restore stays blocked in hosted mode', async (t) => {
  const hostedServer = await startServer({
    appMode: 'hosted',
    nodeEnv: 'production',
    envOverrides: {
      CONTACTBRIDGE_CORS_ORIGINS: 'https://ui.example.test',
      CONTACTBRIDGE_SECRET_KEY: 'hosted-test-secret'
    },
    healthCheckOrigin: 'https://ui.example.test'
  });
  t.after(() => stopServer(hostedServer));

  const response = await fetch(`${hostedServer.baseUrl}/api/database/restore`, {
    method: 'POST',
    headers: {
      Origin: 'https://ui.example.test',
      'Content-Type': 'application/json',
      'X-ContactBridge-Confirm-Restore': 'restore-local-data'
    },
    body: JSON.stringify({
      format: 'contactbridge-backup-v1',
      tables: {
        app_settings: [],
        source_accounts: [],
        source_account_secrets: [],
        social_profiles: [],
        contact_candidates: [],
        contact_candidate_profiles: [],
        candidate_match_evidence: [],
        sync_jobs: [],
        relationship_edges: []
      }
    })
  });
  assert.equal(response.status, 403);
});

test('cors enforces hosted allowlist, rejects hosted no-origin, and allows loopback in local mode', async (t) => {
  const hostedServer = await startServer({
    appMode: 'hosted',
    nodeEnv: 'production',
    envOverrides: {
      CONTACTBRIDGE_CORS_ORIGINS: 'https://allowed.example.test',
      CONTACTBRIDGE_SECRET_KEY: 'hosted-test-secret'
    },
    healthCheckOrigin: 'https://allowed.example.test'
  });
  t.after(() => stopServer(hostedServer));

  const allowedHostedResponse = await fetch(`${hostedServer.baseUrl}/api/health`, {
    headers: { Origin: 'https://allowed.example.test' }
  });
  assert.equal(allowedHostedResponse.ok, true);

  const rejectedHostedResponse = await fetch(`${hostedServer.baseUrl}/api/health`, {
    headers: { Origin: 'https://rejected.example.test' }
  });
  assert.equal(rejectedHostedResponse.ok, false);
  assert.ok(rejectedHostedResponse.status >= 400);

  const noOriginHostedResponse = await fetch(`${hostedServer.baseUrl}/api/health`);
  assert.equal(noOriginHostedResponse.ok, false);
  assert.ok(noOriginHostedResponse.status >= 400);

  const localServer = await startServer({ appMode: 'local', nodeEnv: 'development' });
  t.after(() => stopServer(localServer));
  const loopbackLocalResponse = await fetch(`${localServer.baseUrl}/api/health`, {
    headers: { Origin: 'http://localhost:5173' }
  });
  assert.equal(loopbackLocalResponse.ok, true);
});

test('x sync migrates legacy auth_data into encrypted secrets and reuses encrypted credentials', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const sourceAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'x',
    accountIdentifier: 'X OAuth',
    displayName: 'X (Twitter)',
    authStatus: 'pending'
  });

  const sqlite = new Database(server.dbPath);
  t.after(() => sqlite.close());
  sqlite.prepare('UPDATE source_accounts SET auth_data = ? WHERE id = ?').run(
    JSON.stringify({ accessToken: 'stored-demo-token', refreshToken: 'stored-refresh-token' }),
    sourceAccount.id
  );

  const firstSync = await postSync<{ success: boolean; count: number }>(server.baseUrl, '/api/sync/x', {
    sourceAccountId: sourceAccount.id
  });
  assert.equal(firstSync.success, true);
  assert.equal(firstSync.count, 2);

  const secretRow = sqlite.prepare(`
    SELECT encrypted_payload AS encryptedPayload
    FROM source_account_secrets
    WHERE source_account_id = ?
  `).get(sourceAccount.id) as { encryptedPayload: string } | undefined;
  assert.ok(secretRow);
  assert.ok(secretRow.encryptedPayload.length > 20);
  assert.equal(secretRow.encryptedPayload.includes('stored-demo-token'), false);

  const authDataRow = sqlite.prepare(`
    SELECT auth_data AS authData
    FROM source_accounts
    WHERE id = ?
  `).get(sourceAccount.id) as { authData: string | null } | undefined;
  assert.equal(authDataRow?.authData, null);

  const secondSync = await postSync<{ success: boolean; count: number }>(server.baseUrl, '/api/sync/x', {
    sourceAccountId: sourceAccount.id
  });
  assert.equal(secondSync.success, true);
  assert.equal(secondSync.count, 2);
});

test('disconnect removes stored encrypted source account secrets', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const sourceAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'x',
    accountIdentifier: 'X OAuth',
    displayName: 'X (Twitter)',
    authStatus: 'pending'
  });

  const sqlite = new Database(server.dbPath);
  t.after(() => sqlite.close());
  sqlite.prepare('UPDATE source_accounts SET auth_data = ? WHERE id = ?').run(
    JSON.stringify({ accessToken: 'stored-demo-token' }),
    sourceAccount.id
  );

  await postSync(server.baseUrl, '/api/sync/x', { sourceAccountId: sourceAccount.id });

  const beforeDeleteSecrets = sqlite.prepare(`
    SELECT COUNT(*) AS count FROM source_account_secrets WHERE source_account_id = ?
  `).get(sourceAccount.id) as { count: number };
  assert.equal(beforeDeleteSecrets.count, 1);

  await deleteJson(server.baseUrl, `/api/source-accounts/${sourceAccount.id}`);

  const afterDeleteSecrets = sqlite.prepare(`
    SELECT COUNT(*) AS count FROM source_account_secrets WHERE source_account_id = ?
  `).get(sourceAccount.id) as { count: number };
  assert.equal(afterDeleteSecrets.count, 0);
});

test('same-source same handle but different source profile id creates review evidence only', async (t) => {
  const overrideDemoDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'contactbridge-demo-'));
  const overrideDemoDataDir = path.join(overrideDemoDataRoot, 'fixtures');
  await fs.cp(demoDataDir, overrideDemoDataDir, { recursive: true });
  t.after(async () => {
    await fs.rm(overrideDemoDataRoot, { recursive: true, force: true });
  });

  const githubFixturePath = path.join(overrideDemoDataDir, 'github.json');
  await fs.writeFile(githubFixturePath, JSON.stringify({
    followersResponse: [{ id: 111, login: 'shared-handle', avatar_url: '', url: 'https://api.github.com/users/shared-handle' }],
    followingResponse: []
  }, null, 2));

  const server = await startServer({ demoDataDir: overrideDemoDataDir });
  t.after(() => stopServer(server));

  const firstAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'github',
    accountIdentifier: 'github-demo-account-1',
    displayName: 'github demo 1',
    authStatus: 'pending'
  });
  await postSync(server.baseUrl, '/api/sync/github', { sourceAccountId: firstAccount.id, token: 'demo-token' });

  await fs.writeFile(githubFixturePath, JSON.stringify({
    followersResponse: [{ id: 222, login: 'shared-handle', avatar_url: '', url: 'https://api.github.com/users/shared-handle' }],
    followingResponse: []
  }, null, 2));

  const secondAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'github',
    accountIdentifier: 'github-demo-account-2',
    displayName: 'github demo 2',
    authStatus: 'pending'
  });
  await postSync(server.baseUrl, '/api/sync/github', { sourceAccountId: secondAccount.id, token: 'demo-token' });

  const candidates = await getJson<Array<{ id: string }>>(server.baseUrl, '/api/candidates');
  assert.equal(candidates.length, 2);

  const sqlite = new Database(server.dbPath);
  t.after(() => sqlite.close());
  const evidenceRows = sqlite.prepare(`
    SELECT evidence_type AS evidenceType
    FROM candidate_match_evidence
  `).all() as Array<{ evidenceType: string }>;
  assert.ok(evidenceRows.some((row) => row.evidenceType === 'same_source_handle_profile_id_mismatch_review'));

  const dedupeCounts = sqlite.prepare(`
    SELECT
      COUNT(*) AS totalCount,
      COUNT(DISTINCT contact_candidate_id || ':' || social_profile_id) AS distinctCount
    FROM contact_candidate_profiles
  `).get() as { distinctCount: number; totalCount: number };
  assert.equal(dedupeCounts.totalCount, dedupeCounts.distinctCount);
});

test('cross-source same handle creates review evidence only', async (t) => {
  const overrideDemoDataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'contactbridge-demo-'));
  const overrideDemoDataDir = path.join(overrideDemoDataRoot, 'fixtures');
  await fs.cp(demoDataDir, overrideDemoDataDir, { recursive: true });
  t.after(async () => {
    await fs.rm(overrideDemoDataRoot, { recursive: true, force: true });
  });

  await fs.writeFile(path.join(overrideDemoDataDir, 'github.json'), JSON.stringify({
    followersResponse: [{ id: 333, login: 'cross-handle', avatar_url: '', url: 'https://api.github.com/users/cross-handle' }],
    followingResponse: []
  }, null, 2));
  await fs.writeFile(path.join(overrideDemoDataDir, 'x.json'), JSON.stringify({
    followersResponse: { data: [{ id: 'x-444', username: 'cross-handle', name: 'Cross Handle', description: '', profile_image_url: '' }] },
    followingResponse: { data: [] }
  }, null, 2));

  const server = await startServer({ demoDataDir: overrideDemoDataDir });
  t.after(() => stopServer(server));

  const githubAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'github',
    accountIdentifier: 'github-demo-account',
    displayName: 'github demo',
    authStatus: 'pending'
  });
  await postSync(server.baseUrl, '/api/sync/github', { sourceAccountId: githubAccount.id, token: 'demo-token' });

  const xAccount = await postJson<{ id: string }>(server.baseUrl, '/api/source-accounts', {
    sourceType: 'x',
    accountIdentifier: 'x-demo-account',
    displayName: 'x demo',
    authStatus: 'pending'
  });
  await postSync(server.baseUrl, '/api/sync/x', { sourceAccountId: xAccount.id, accessToken: 'demo-token' });

  const candidates = await getJson<Array<{ id: string }>>(server.baseUrl, '/api/candidates');
  assert.equal(candidates.length, 2);

  const sqlite = new Database(server.dbPath);
  t.after(() => sqlite.close());
  const evidenceRows = sqlite.prepare(`
    SELECT evidence_type AS evidenceType
    FROM candidate_match_evidence
  `).all() as Array<{ evidenceType: string }>;
  assert.ok(evidenceRows.some((row) => row.evidenceType === 'cross_source_handle_review'));
});

test('display-name-only matching remains weak review evidence only', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  await postJson(server.baseUrl, '/api/capture/manual', {
    source: 'linkedin',
    profileUrl: 'https://www.linkedin.com/in/same-name-one',
    displayName: 'Same Name',
    handle: 'same-name-one'
  });
  await postJson(server.baseUrl, '/api/capture/manual', {
    source: 'x',
    profileUrl: 'https://x.com/different-handle-two',
    displayName: 'Same Name',
    handle: 'different-handle-two'
  });

  const candidates = await getJson<Array<{ id: string }>>(server.baseUrl, '/api/candidates');
  assert.equal(candidates.length, 2);

  const sqlite = new Database(server.dbPath);
  t.after(() => sqlite.close());
  const evidenceRows = sqlite.prepare(`
    SELECT evidence_type AS evidenceType, score
    FROM candidate_match_evidence
  `).all() as Array<{ evidenceType: string; score: number }>;
  const displayNameEvidence = evidenceRows.find((row) => row.evidenceType === 'display_name_only_review');
  assert.ok(displayNameEvidence);
  assert.equal(displayNameEvidence.score, 20);
});

test('backend exports include only approved candidates and escape CSV and VCF values safely', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const pendingCandidate = await postJson<{ id: string }>(server.baseUrl, '/api/capture/manual', {
    source: 'linkedin',
    profileUrl: 'https://www.linkedin.com/in/pending-person',
    displayName: 'Pending Person',
    handle: 'pending-person'
  });
  assert.ok(pendingCandidate.id);

  const approvedCandidate = await postJson<{ id: string }>(server.baseUrl, '/api/capture/manual', {
    source: 'x',
    profileUrl: 'https://x.com/alice;demo',
    displayName: 'Alice "Ace", Demo\nLine',
    handle: 'alice-demo'
  });
  await patchJson(server.baseUrl, `/api/candidates/${approvedCandidate.id}`, {
    status: 'approved',
    notes: 'Line one,\nLine two; with "quotes"'
  });

  const exportJson = JSON.parse(await getText(server.baseUrl, '/api/exports/contacts.json')) as Array<{ id: string }>;
  assert.deepEqual(exportJson.map((candidate) => candidate.id), [approvedCandidate.id]);

  const csvExport = await getText(server.baseUrl, '/api/exports/contacts.csv');
  assert.equal(csvExport.includes('Pending Person'), false);
  assert.match(csvExport, /"Alice ""Ace"", Demo\nLine"/);
  assert.match(csvExport, /"Line one,\nLine two; with ""quotes"""/);

  const vcfExport = await getText(server.baseUrl, '/api/exports/contacts.vcf');
  assert.equal(vcfExport.includes('Pending Person'), false);
  assert.match(vcfExport, /FN:Alice "Ace"\\, Demo\\nLine/);
  assert.match(vcfExport, /NOTE:Line one\\,\\nLine two\\; with "quotes"/);
  assert.match(vcfExport, /URL:https:\/\/x\.com\/alice\\;demo/);
});

test('extension health endpoint returns stable capabilities without secrets', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const extensionHealth = await getJson<Record<string, unknown>>(server.baseUrl, '/api/extension/health');
  assert.equal(extensionHealth.appName, 'ContactBridge');
  assert.equal(extensionHealth.appMode, 'test');
  assert.ok(Array.isArray(extensionHealth.capabilities));
  assert.ok((extensionHealth.capabilities as string[]).includes('capture.manual.v1'));
  assert.equal('CONTACTBRIDGE_SECRET_KEY' in extensionHealth, false);
});

test('startup creates required runtime indexes and unique constraints', async (t) => {
  const server = await startServer();
  t.after(() => stopServer(server));

  const sqlite = new Database(server.dbPath);
  t.after(() => sqlite.close());
  const indexes = sqlite.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'index'
  `).all() as Array<{ name: string }>;
  const indexNames = new Set(indexes.map((entry) => entry.name));

  assert.ok(indexNames.has('idx_social_profiles_source_identity'));
  assert.ok(indexNames.has('idx_contact_candidate_profiles_unique_pair'));
  assert.ok(indexNames.has('idx_contact_candidates_status'));
  assert.ok(indexNames.has('idx_social_profiles_handle'));
  assert.ok(indexNames.has('idx_relationship_edges_source_account_id'));
  assert.ok(indexNames.has('idx_relationship_edges_social_profile_id'));
  assert.ok(indexNames.has('idx_candidate_match_evidence_candidate_id'));
  assert.ok(indexNames.has('idx_candidate_match_evidence_profile_id'));
});
