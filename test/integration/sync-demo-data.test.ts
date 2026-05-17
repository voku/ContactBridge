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

const waitForHealth = async (baseUrl: string) => {
  for (let attempt = 0; attempt < MAX_HEALTH_CHECK_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {}
    await delay(HEALTH_CHECK_INTERVAL_MS);
  }

  throw new Error(`Server did not become healthy: ${baseUrl}`);
};

const startServer = async (options: { demoDataDir?: string } = {}): Promise<ServerHandle> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'contactbridge-it-'));
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbPath = path.join(tempDir, 'test.sqlite');
  const serverProcess = spawn(
    process.execPath,
    ['--import', 'tsx', path.join(repoRoot, 'server.ts')],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        CONTACTBRIDGE_DB_PATH: dbPath,
        CONTACTBRIDGE_DEMO_DATA_DIR: options.demoDataDir || demoDataDir,
        CONTACTBRIDGE_DISABLE_FRONTEND: '1',
        NODE_ENV: 'test',
        PORT: String(port)
      },
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
    await waitForHealth(baseUrl);
  } catch (error) {
    serverProcess.kill('SIGTERM');
    throw new Error([(error as Error).message, stderr].filter(Boolean).join('\n'));
  }

  return { baseUrl, process: serverProcess, tempDir, dbPath };
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

const deleteJson = async <T>(baseUrl: string, pathname: string): Promise<T> => {
  const response = await fetch(`${baseUrl}${pathname}`, { method: 'DELETE' });
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
