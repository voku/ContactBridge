import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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

const startServer = async (): Promise<ServerHandle> => {
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
        CONTACTBRIDGE_DEMO_DATA_DIR: demoDataDir,
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

  return { baseUrl, process: serverProcess, tempDir };
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

    const dashboard = await getJson<{ totalCandidates: number; changedProfiles: number; failedSyncJobs: number }>(server.baseUrl, '/api/dashboard');
    assert.equal(dashboard.totalCandidates, syncCase.expectedNames.length);
    assert.equal(dashboard.changedProfiles, syncCase.expectedNames.length);
    assert.equal(dashboard.failedSyncJobs, 0);

    const jobs = await getJson<Array<{ status: string; sourceType: string }>>(server.baseUrl, '/api/dashboard/sync-jobs');
    assert.ok(jobs.length > 0);
    assert.equal(jobs[0]?.status, 'completed');
    assert.equal(jobs[0]?.sourceType, syncCase.sourceType);
  });
}
