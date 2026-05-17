import express from "express";
import fs from "fs/promises";
import net from "net";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { v4 as uuidv4 } from "uuid";
import * as schema from "./src/lib/db/schema.js";
import { eq, desc } from "drizzle-orm";
import { TwitterApi } from "twitter-api-v2";

dotenv.config({ path: '.env.local', override: true });
dotenv.config();

const sqlite = new Database(process.env.CONTACTBRIDGE_DB_PATH || 'sqlite.db');

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS source_accounts (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    account_identifier TEXT,
    display_name TEXT,
    auth_status TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS social_profiles (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_profile_id TEXT,
    handle TEXT,
    display_name TEXT,
    profile_url TEXT,
    avatar_url TEXT,
    bio TEXT,
    raw_public_payload_json TEXT,
    first_seen_at INTEGER,
    last_seen_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS relationship_edges (
    id TEXT PRIMARY KEY,
    source_account_id TEXT,
    social_profile_id TEXT,
    relation_type TEXT,
    observed_at INTEGER,
    sync_job_id TEXT
  );

  CREATE TABLE IF NOT EXISTS contact_candidates (
    id TEXT PRIMARY KEY,
    canonical_name TEXT,
    confidence_score INTEGER,
    status TEXT,
    notes TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS contact_candidate_profiles (
    contact_candidate_id TEXT,
    social_profile_id TEXT
  );

  CREATE TABLE IF NOT EXISTS sync_jobs (
    id TEXT PRIMARY KEY,
    source_account_id TEXT,
    status TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    error_code TEXT,
    error_message_safe TEXT
  );
`);

try {
  sqlite.exec("ALTER TABLE contact_candidates ADD COLUMN notes TEXT;");
} catch (e) {
  // column might already exist
}

export const db = drizzle(sqlite, { schema });

const loadDemoFixture = async <T>(integration: string): Promise<T | null> => {
  const demoDataDir = process.env.CONTACTBRIDGE_DEMO_DATA_DIR;
  if (!demoDataDir) {
    return null;
  }

  try {
    const filePath = path.join(demoDataDir, `${integration}.json`);
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
};

const createRateLimiter = (windowMs: number, maxRequests: number) => {
  const requestLog = new Map<string, { count: number, resetAt: number }>();

  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    const clientKey = req.ip || req.socket.remoteAddress || 'unknown';
    const currentEntry = requestLog.get(clientKey);

    if (!currentEntry || currentEntry.resetAt <= now) {
      requestLog.set(clientKey, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (currentEntry.count >= maxRequests) {
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return;
    }

    currentEntry.count += 1;
    next();
  };
};

const normalizeMastodonInstanceUrl = (instance: string) => {
  const candidate = instance.startsWith('http://') || instance.startsWith('https://')
    ? instance
    : `https://${instance}`;
  const instanceUrl = new URL(candidate);

  if (instanceUrl.protocol !== 'https:') {
    throw new Error('Mastodon instance URL must use HTTPS');
  }

  const hostname = instanceUrl.hostname.toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error('Mastodon instance URL must use a public hostname');
  }

  if (net.isIP(hostname)) {
    // fc00::/7 and fd00::/8 unique local IPv6 address ranges.
    const isUniqueLocalIpv6 = /^(fc|fd)[0-9a-f]{2}:/i.test(hostname);
    // fe80::/10 link-local IPv6 address range.
    const isLinkLocalIpv6 = /^fe[89ab][0-9a-f]:/i.test(hostname);

    if (
      hostname === '::1' ||
      hostname === '::' ||
      isUniqueLocalIpv6 ||
      isLinkLocalIpv6 ||
      /^10\./.test(hostname) ||
      /^127\./.test(hostname) ||
      /^169\.254\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
    ) {
      throw new Error('Mastodon instance URL must not target a private or loopback address');
    }
  }

  instanceUrl.pathname = '';
  instanceUrl.search = '';
  instanceUrl.hash = '';

  return instanceUrl.toString().replace(/\/$/, '');
};

function assignProfileToCandidate(profileIdToUse: string, displayName: string, handle: string, now: Date) {
  const existingCandidateProfile = db.select().from(schema.contactCandidateProfiles)
    .where(eq(schema.contactCandidateProfiles.socialProfileId, profileIdToUse))
    .get();

  if (!existingCandidateProfile) {
    let matchedCandidateId = null;
    
    if (handle) {
      const handles = db.select().from(schema.socialProfiles)
        .where(eq(schema.socialProfiles.handle, handle)).all();
      
      for (const p of handles) {
        if (p.id === profileIdToUse) continue;
        const cp = db.select().from(schema.contactCandidateProfiles)
          .where(eq(schema.contactCandidateProfiles.socialProfileId, p.id)).get();
        if (cp) {
          matchedCandidateId = cp.contactCandidateId;
          break;
        }
      }
    }

    if (!matchedCandidateId && displayName) {
      const cd = db.select().from(schema.contactCandidates)
        .where(eq(schema.contactCandidates.canonicalName, displayName)).get();
      if (cd) {
        matchedCandidateId = cd.id;
      }
    }

    if (matchedCandidateId) {
      db.insert(schema.contactCandidateProfiles).values({
        contactCandidateId: matchedCandidateId,
        socialProfileId: profileIdToUse
      }).run();
    } else {
      const candidateId = uuidv4();
      db.insert(schema.contactCandidates).values({
        id: candidateId,
        canonicalName: displayName || handle || 'Unknown',
        confidenceScore: 50,
        status: 'pending',
        createdAt: now,
        updatedAt: now
      }).run();

      db.insert(schema.contactCandidateProfiles).values({
        contactCandidateId: candidateId,
        socialProfileId: profileIdToUse
      }).run();
    }
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const syncRateLimiter = createRateLimiter(60_000, 10);

  app.use(cors());
  app.use(express.json());

  // --- API ROUTES ---
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Source Accounts
  app.get("/api/source-accounts", (req, res) => {
    const accounts = db.select().from(schema.sourceAccounts).all();
    res.json(accounts);
  });

  app.post("/api/source-accounts", (req, res) => {
    const { sourceType, accountIdentifier, displayName, authStatus } = req.body;
    const now = new Date();
    const id = uuidv4();
    db.insert(schema.sourceAccounts).values({
      id,
      sourceType,
      accountIdentifier,
      displayName,
      authStatus,
      createdAt: now,
      updatedAt: now,
    }).run();
    
    res.json({ id });
  });

  app.delete("/api/source-accounts/:id", (req, res) => {
    const { id } = req.params;
    try {
      db.delete(schema.syncJobs).where(eq(schema.syncJobs.sourceAccountId, id)).run();
      db.delete(schema.relationshipEdges).where(eq(schema.relationshipEdges.sourceAccountId, id)).run();
      db.delete(schema.sourceAccounts).where(eq(schema.sourceAccounts.id, id)).run();
      res.json({ success: true });
    } catch (e: any) {
      console.error("Failed to delete source account:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // Candidates
  app.get("/api/candidates", (req, res) => {
    const candidates = db.select().from(schema.contactCandidates).all();
    
    // For each candidate get their associated profiles
    const candidatesWithProfiles = candidates.map(c => {
      const candidateProfiles = db.select().from(schema.contactCandidateProfiles)
        .where(eq(schema.contactCandidateProfiles.contactCandidateId, c.id))
        .all();
      
      const profiles = candidateProfiles.map(cp => {
        return db.select().from(schema.socialProfiles)
          .where(eq(schema.socialProfiles.id, cp.socialProfileId as string))
          .get();
      }).filter(Boolean);

      return {
        ...c,
        profiles,
      };
    });

    res.json(candidatesWithProfiles);
  });

  app.post("/api/candidates/merge", (req, res) => {
    try {
      const { primaryCandidateId, secondaryCandidateIds } = req.body;
      if (!primaryCandidateId || !Array.isArray(secondaryCandidateIds)) {
        return res.status(400).json({ error: "Invalid payload" });
      }

      db.transaction(() => {
        for (const id of secondaryCandidateIds) {
          if (id === primaryCandidateId) continue;
          db.update(schema.contactCandidateProfiles)
            .set({ contactCandidateId: primaryCandidateId })
            .where(eq(schema.contactCandidateProfiles.contactCandidateId, id))
            .run();

          db.delete(schema.contactCandidates)
            .where(eq(schema.contactCandidates.id, id))
            .run();
        }
      });
      res.json({ success: true });
    } catch (e: any) {
      console.error("Merge error:", e);
      res.status(500).json({ error: e.message });
    }
  });
  
  app.get("/api/dashboard", (req, res) => {
    const totalCandidates = db.select().from(schema.contactCandidates).all().length;
    const approvedContacts = db.select().from(schema.contactCandidates).where(eq(schema.contactCandidates.status, 'approved')).all().length;
    const totalProfiles = db.select().from(schema.socialProfiles).all().length;
    const failedSyncJobs = db.select().from(schema.syncJobs).where(eq(schema.syncJobs.status, 'failed')).all().length;
    res.json({ totalCandidates, approvedContacts, changedProfiles: totalProfiles, failedSyncJobs });
  });

  app.get("/api/dashboard/sync-jobs", (req, res) => {
    const jobs = db.select({
      id: schema.syncJobs.id,
      sourceType: schema.sourceAccounts.sourceType,
      displayName: schema.sourceAccounts.displayName,
      status: schema.syncJobs.status,
      startedAt: schema.syncJobs.startedAt,
      finishedAt: schema.syncJobs.finishedAt,
      errorMessage: schema.syncJobs.errorMessageSafe
    })
    .from(schema.syncJobs)
    .leftJoin(schema.sourceAccounts, eq(schema.syncJobs.sourceAccountId, schema.sourceAccounts.id))
    .orderBy(desc(schema.syncJobs.startedAt))
    .limit(20)
    .all();

    res.json(jobs);
  });

  app.patch("/api/candidates/:id", (req, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    const updateData: any = { updatedAt: new Date() };
    if (status !== undefined) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;

    db.update(schema.contactCandidates)
      .set(updateData)
      .where(eq(schema.contactCandidates.id, id))
      .run();
    res.json({ success: true });
  });

  const createStream = (res: any) => {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    return {
      progress: (message: string) => {
        res.write(JSON.stringify({ type: 'progress', message }) + '\n');
      },
      success: (data: any) => {
        res.write(JSON.stringify({ type: 'success', ...data }) + '\n');
        res.end();
      },
      error: (err: any) => {
        res.write(JSON.stringify({ type: 'error', error: err.message || err }) + '\n');
        res.end();
      }
    };
  };

  // AT-Protocol implementation (Bluesky sync job)
  app.post("/api/sync/bluesky", syncRateLimiter, async (req, res) => {
    const { sourceAccountId, identifier, password } = req.body;
    const syncJobId = uuidv4();
    const now = new Date();
    const stream = createStream(res);
    
    try {
      stream.progress('Initializing sync job...');
      db.insert(schema.syncJobs).values({
        id: syncJobId,
        sourceAccountId,
        status: 'running',
        startedAt: now,
      }).run();

      const demoData = await loadDemoFixture<{ session?: { did?: string }, followers?: any[], follows?: any[] }>('bluesky');
      let followersResponse;
      let followsResponse;

      if (demoData) {
        stream.progress('Loading demo data...');
        followersResponse = { data: { followers: demoData.followers || [] } };
        followsResponse = { data: { follows: demoData.follows || [] } };
      } else {
        stream.progress('Connecting to API...');
        const { BskyAgent } = await import('@atproto/api');
        const agent = new BskyAgent({ service: 'https://bsky.social' });
        await agent.login({ identifier, password });

        stream.progress('Fetching followers...');
        followersResponse = await agent.getFollowers({ actor: agent.session!.did });
        
        stream.progress('Fetching follows...');
        followsResponse = await agent.getFollows({ actor: agent.session!.did });
      }
      
      const allProfilesMap = new Map();

      // Normalize
      const processProfile = (p: any, relation: string) => {
        allProfilesMap.set(p.did, {
          sourceProfileId: p.did,
          handle: p.handle,
          displayName: p.displayName || p.handle,
          avatarUrl: p.avatar,
          bio: p.description,
          rawJson: JSON.stringify(p),
          relation,
        });
      };

      stream.progress('Processing profiles...');
      followersResponse.data.followers.forEach(p => processProfile(p, 'followed_by'));
      followsResponse.data.follows.forEach(p => processProfile(p, 'follows'));
      // Note: for ones that are mutually following, 'follows' might overwrite 'followed_by', which is fine for MVP

      let insertedCount = 0;
      let updatedCount = 0;

      stream.progress('Merging duplicates in database...');
      for (const [did, data] of allProfilesMap.entries()) {
        const socialProfileId = uuidv4();
        
        let existingProfile = db.select().from(schema.socialProfiles)
          .where(eq(schema.socialProfiles.sourceProfileId, did))
          .get();

        let profileIdToUse = existingProfile?.id;

        if (!existingProfile) {
          db.insert(schema.socialProfiles).values({
            id: socialProfileId,
            sourceType: 'bluesky',
            sourceProfileId: did,
            handle: data.handle,
            displayName: data.displayName,
            avatarUrl: data.avatarUrl,
            bio: data.bio,
            rawPublicPayloadJson: data.rawJson,
            firstSeenAt: now,
            lastSeenAt: now,
          }).run();
          profileIdToUse = socialProfileId;
          insertedCount++;
        } else {
          // Update last seen 
           db.update(schema.socialProfiles).set({
            handle: data.handle,
            displayName: data.displayName,
            avatarUrl: data.avatarUrl,
            bio: data.bio,
            lastSeenAt: now
           }).where(eq(schema.socialProfiles.id, existingProfile.id)).run();
           updatedCount++;
        }

        db.insert(schema.relationshipEdges).values({
          id: uuidv4(),
          sourceAccountId,
          socialProfileId: profileIdToUse,
          relationType: data.relation,
          observedAt: now,
          syncJobId
        }).run();

        // Create contact candidate if it doesn't have one
        assignProfileToCandidate(profileIdToUse as string, data.displayName, data.handle, now);
      }

      db.update(schema.syncJobs).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.syncJobs.id, syncJobId)).run();
      db.update(schema.sourceAccounts).set({ authStatus: 'connected', updatedAt: new Date() }).where(eq(schema.sourceAccounts.id, sourceAccountId)).run();

      stream.success({ success: true, count: allProfilesMap.size, insertedCount, updatedCount });

    } catch (e: any) {
      console.error(e);
      db.update(schema.syncJobs).set({ 
        status: 'failed', 
        finishedAt: new Date(),
        errorCode: 'SYNC_ERROR',
        errorMessageSafe: e.message || 'Unknown error occurred during sync'
      }).where(eq(schema.syncJobs.id, syncJobId)).run();
      stream.error(e.message);
    }
  });

  app.post("/api/sync/mastodon", syncRateLimiter, async (req, res) => {
    const { sourceAccountId, instance, token } = req.body;
    const syncJobId = uuidv4();
    const now = new Date();
    const stream = createStream(res);
    
    try {
      stream.progress('Initializing sync job...');
      db.insert(schema.syncJobs).values({
        id: syncJobId,
        sourceAccountId,
        status: 'running',
        startedAt: now,
      }).run();

      const demoData = await loadDemoFixture<{ selfAccount?: { id: string }, followers?: any[], following?: any[] }>('mastodon');
      let followers: any[] = [];
      let following: any[] = [];

      if (demoData) {
        stream.progress('Loading demo data...');
        followers = demoData.followers || [];
        following = demoData.following || [];
      } else {
        const instanceUrl = normalizeMastodonInstanceUrl(instance);
        
        let verifyRes;
        try {
          stream.progress('Connecting to API...');
          verifyRes = await fetch(`${instanceUrl}/api/v1/accounts/verify_credentials`, {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });
        } catch (err: any) {
          throw new Error(`Could not connect to instance. Please check the URL. (${err.message})`);
        }

        if (!verifyRes.ok) {
          if (verifyRes.status === 401) {
            throw new Error('Invalid access token');
          } else if (verifyRes.status === 404) {
            throw new Error('Instance not found or API endpoint missing');
          } else {
            throw new Error(`Failed to verify credentials: ${verifyRes.status} ${verifyRes.statusText}`);
          }
        }
        const selfAccount = await verifyRes.json();
        const mastodonId = selfAccount.id;

        stream.progress('Fetching followers...');
        const followersRes = await fetch(`${instanceUrl}/api/v1/accounts/${mastodonId}/followers?limit=80`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        
        stream.progress('Fetching following...');
        const followingRes = await fetch(`${instanceUrl}/api/v1/accounts/${mastodonId}/following?limit=80`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });

        followers = followersRes.ok ? await followersRes.json() : [];
        following = followingRes.ok ? await followingRes.json() : [];
      }
      
      const allProfilesMap = new Map();

      const processProfile = (p: any, relation: string) => {
        allProfilesMap.set(p.acct, {
          sourceProfileId: p.id,
          handle: p.acct,
          displayName: p.display_name || p.username,
          avatarUrl: p.avatar,
          bio: p.note ? p.note.replace(/<[^>]*>?/gm, '') : '', // strip HTML
          rawJson: JSON.stringify(p),
          relation,
        });
      };

      stream.progress('Processing profiles...');
      if (Array.isArray(followers)) followers.forEach(p => processProfile(p, 'followed_by'));
      if (Array.isArray(following)) following.forEach(p => processProfile(p, 'follows'));

      let insertedCount = 0;
      let updatedCount = 0;

      stream.progress('Merging duplicates in database...');
      for (const [handle, data] of allProfilesMap.entries()) {
        const socialProfileId = uuidv4();
        
        let existingProfile = db.select().from(schema.socialProfiles)
          .where(eq(schema.socialProfiles.sourceProfileId, data.sourceProfileId))
          .get();

        let profileIdToUse = existingProfile?.id;

        if (!existingProfile) {
          db.insert(schema.socialProfiles).values({
            id: socialProfileId,
            sourceType: 'mastodon',
            sourceProfileId: data.sourceProfileId,
            handle: data.handle,
            displayName: data.displayName,
            avatarUrl: data.avatarUrl,
            bio: data.bio,
            rawPublicPayloadJson: data.rawJson,
            firstSeenAt: now,
            lastSeenAt: now,
          }).run();
          profileIdToUse = socialProfileId;
          insertedCount++;
        } else {
           db.update(schema.socialProfiles).set({
            handle: data.handle,
            displayName: data.displayName,
            avatarUrl: data.avatarUrl,
            bio: data.bio,
            lastSeenAt: now
           }).where(eq(schema.socialProfiles.id, existingProfile.id)).run();
           updatedCount++;
        }

        db.insert(schema.relationshipEdges).values({
          id: uuidv4(),
          sourceAccountId,
          socialProfileId: profileIdToUse,
          relationType: data.relation,
          observedAt: now,
          syncJobId
        }).run();

        assignProfileToCandidate(profileIdToUse as string, data.displayName, data.handle, now);
      }

      db.update(schema.syncJobs).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.syncJobs.id, syncJobId)).run();
      db.update(schema.sourceAccounts).set({ authStatus: 'connected', updatedAt: new Date() }).where(eq(schema.sourceAccounts.id, sourceAccountId)).run();

      stream.success({ success: true, count: allProfilesMap.size, insertedCount, updatedCount });

    } catch (e: any) {
      console.error(e);
      db.update(schema.syncJobs).set({ 
        status: 'failed', 
        finishedAt: new Date(),
        errorCode: 'SYNC_ERROR',
        errorMessageSafe: e.message || 'Unknown error occurred during sync'
      }).where(eq(schema.syncJobs.id, syncJobId)).run();
      stream.error(e.message);
    }
  });


  const oauthStore = new Map<string, { codeVerifier: string, state: string, clientId: string, clientSecret: string }>();

  app.post('/api/auth/x/url', syncRateLimiter, (req, res) => {
    try {
      const { clientId, clientSecret } = req.body;
      if (!clientId || !clientSecret) {
        throw new Error('Client ID or Client Secret is missing.');
      }

      const client = new TwitterApi({ clientId, clientSecret });
      const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/auth/x/callback`;
      
      const { url, codeVerifier, state } = client.generateOAuth2AuthLink(redirectUri, { scope: ['tweet.read', 'users.read', 'follows.read', 'offline.access'] });
      
      oauthStore.set(state, { codeVerifier, state, clientId, clientSecret });
      res.json({ url });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get(['/auth/x/callback', '/auth/x/callback/'], async (req, res) => {
    const { state, code } = req.query;
    const store = oauthStore.get(state as string);

    if (!store || !state || !code) {
      return res.status(400).send('Invalid state or code');
    }

    try {
      const client = new TwitterApi({ clientId: store.clientId, clientSecret: store.clientSecret });
      const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/auth/x/callback`;
      
      const { client: loggedClient, accessToken, refreshToken } = await client.loginWithOAuth2({
        code: code as string,
        codeVerifier: store.codeVerifier,
        redirectUri
      });

      oauthStore.delete(state as string);

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS_X', accessToken: "${accessToken}" }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful. This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (e: any) {
      res.status(500).send(`X OAuth error: ${e.message}`);
    }
  });

  const googleOauthStore = new Map<string, { clientId: string, clientSecret: string }>();

  app.post('/api/auth/google/url', syncRateLimiter, async (req, res) => {
    try {
      const { clientId, clientSecret } = req.body;
      if (!clientId || !clientSecret) {
        throw new Error('Client ID or Client Secret is missing.');
      }
      const { OAuth2Client } = await import('google-auth-library');
      const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`;
      const client = new OAuth2Client(clientId, clientSecret, redirectUri);
      const state = uuidv4();
      
      const url = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/contacts.readonly'],
        state
      });
      
      googleOauthStore.set(state, { clientId, clientSecret });
      res.json({ url });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get(['/auth/google/callback', '/auth/google/callback/'], async (req, res) => {
    const { state, code } = req.query;
    const store = googleOauthStore.get(state as string);

    if (!store || !state || !code) {
      return res.status(400).send('Invalid state or code');
    }

    try {
      const { OAuth2Client } = await import('google-auth-library');
      const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/auth/google/callback`;
      const client = new OAuth2Client(store.clientId, store.clientSecret, redirectUri);
      const { tokens } = await client.getToken(code as string);
      googleOauthStore.delete(state as string);

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS_GOOGLE', tokens: ${JSON.stringify(tokens)} }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <p>Authentication successful. This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (e: any) {
      res.status(500).send(`Google OAuth error: ${e.message}`);
    }
  });

  app.post("/api/sync/x", syncRateLimiter, async (req, res) => {
    const { sourceAccountId, accessToken } = req.body;
    const syncJobId = uuidv4();
    const now = new Date();
    const stream = createStream(res);
    
    try {
      stream.progress('Initializing sync job...');
      db.insert(schema.syncJobs).values({
        id: syncJobId,
        sourceAccountId,
        status: 'running',
        startedAt: now,
      }).run();

      let followers: any[] = [];
      let follows: any[] = [];
      const demoData = await loadDemoFixture<{ followers?: any[], follows?: any[] }>('x');

      if (demoData) {
        stream.progress('Loading demo data...');
        followers = demoData.followers || [];
        follows = demoData.follows || [];
      } else {
        stream.progress('Connecting to API...');
        const client = new TwitterApi(accessToken);

        const userRes = await client.v2.me();
        if (!userRes.data) {
          throw new Error(`Could not fetch authenticated X user.`);
        }
        
        const xUserId = userRes.data.id;
        
        try {
          stream.progress('Fetching followers...');
          const followersPaginator = await client.v2.followers(xUserId, { max_results: 100, "user.fields": ["description", "profile_image_url", "name", "username"] });
          followers = followersPaginator.data || [];
        } catch (e: any) {
          console.error("Error fetching followers from X:", e);
        }

        try {
          stream.progress('Fetching follows...');
          const followsPaginator = await client.v2.following(xUserId, { max_results: 100, "user.fields": ["description", "profile_image_url", "name", "username"] });
          follows = followsPaginator.data || [];
        } catch (e: any) {
          console.error("Error fetching follows from X:", e);
        }
      }

      const allProfilesMap = new Map();

      const processProfile = (p: any, relation: string) => {
        allProfilesMap.set(p.id, {
          sourceProfileId: p.id,
          handle: p.username,
          displayName: p.name || p.username,
          avatarUrl: p.profile_image_url,
          bio: p.description,
          rawJson: JSON.stringify(p),
          relation,
        });
      };

      stream.progress('Processing profiles...');
      followers.forEach(p => processProfile(p, 'followed_by'));
      follows.forEach(p => processProfile(p, 'follows'));

      let insertedCount = 0;
      let updatedCount = 0;

      stream.progress('Merging duplicates in database...');
      for (const [did, data] of allProfilesMap.entries()) {
        const socialProfileId = uuidv4();
        
        let existingProfile = db.select().from(schema.socialProfiles)
          .where(eq(schema.socialProfiles.sourceProfileId, did))
          .get();

        let profileIdToUse = existingProfile?.id;

        if (!existingProfile) {
          db.insert(schema.socialProfiles).values({
            id: socialProfileId,
            sourceType: 'x',
            sourceProfileId: did,
            handle: data.handle,
            displayName: data.displayName,
            avatarUrl: data.avatarUrl,
            bio: data.bio,
            rawPublicPayloadJson: data.rawJson,
            firstSeenAt: now,
            lastSeenAt: now,
          }).run();
          profileIdToUse = socialProfileId;
          insertedCount++;
        } else {
           db.update(schema.socialProfiles).set({
            handle: data.handle,
            displayName: data.displayName,
            avatarUrl: data.avatarUrl,
            bio: data.bio,
            lastSeenAt: now
           }).where(eq(schema.socialProfiles.id, existingProfile.id)).run();
           updatedCount++;
        }

        db.insert(schema.relationshipEdges).values({
          id: uuidv4(),
          sourceAccountId,
          socialProfileId: profileIdToUse,
          relationType: data.relation,
          observedAt: now,
          syncJobId
        }).run();

        assignProfileToCandidate(profileIdToUse as string, data.displayName, data.handle, now);
      }
      
      db.update(schema.syncJobs).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.syncJobs.id, syncJobId)).run();
      db.update(schema.sourceAccounts).set({ authStatus: 'connected', updatedAt: new Date() }).where(eq(schema.sourceAccounts.id, sourceAccountId)).run();

      stream.success({ success: true, count: allProfilesMap.size, insertedCount, updatedCount });
    } catch (e: any) {
      console.error(e);
      db.update(schema.syncJobs).set({ 
        status: 'failed', 
        finishedAt: new Date(),
        errorCode: 'SYNC_ERROR',
        errorMessageSafe: e.message || 'Unknown error occurred during sync'
      }).where(eq(schema.syncJobs.id, syncJobId)).run();
      stream.error(e.message);
    }
  });

  app.post("/api/sync/linkedin", syncRateLimiter, async (req, res) => {
    const { sourceAccountId, handle, token } = req.body;
    const syncJobId = uuidv4();
    const now = new Date();
    const stream = createStream(res);
    
    try {
      stream.progress('Initializing sync job...');
      db.insert(schema.syncJobs).values({
        id: syncJobId,
        sourceAccountId,
        status: 'running',
        startedAt: now,
      }).run();

      let elements: any[] = [];
      const demoData = await loadDemoFixture<{ elements?: any[] }>('linkedin');

      if (demoData) {
        stream.progress('Loading demo data...');
        elements = demoData.elements || [];
      } else {
        stream.progress('Connecting to API...');
        const connectionsRes = await fetch(`https://api.linkedin.com/v2/connections?q=viewer&start=0&count=100`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'X-Restli-Protocol-Version': '2.0.0'
          }
        });

        if (!connectionsRes.ok) {
          let errorDetails = '';
          try {
            const errJson = await connectionsRes.json();
            errorDetails = JSON.stringify(errJson);
          } catch (e) {}

          if (connectionsRes.status === 401 || connectionsRes.status === 403) {
            throw new Error(`Permission Denied / Unauthorized: The LinkedIn API requires approved partner access for full connection scraping. Verify your token has r_liteprofile and r_network scopes. (${connectionsRes.status}) ${errorDetails}`);
          } else if (connectionsRes.status === 429) {
            throw new Error(`Rate Limit Exceeded: LinkedIn API rate limits reached. Please wait before trying again. (${connectionsRes.status})`);
          } else {
            throw new Error(`Failed to fetch LinkedIn connections: ${connectionsRes.status} ${connectionsRes.statusText} ${errorDetails}`);
          }
        }

        stream.progress('Processing profiles...');
        const connectionsData = await connectionsRes.json();
        elements = connectionsData.elements || [];
      }

      let insertedCount = 0;
      let updatedCount = 0;

      stream.progress('Merging duplicates in database...');
      for (const p of elements) {
        // Map LinkedIn entity fields
        const sourceProfileId = p.to || p.entityUrn?.replace('urn:li:fs_miniProfile:', '') || p.id || uuidv4();
        const firstName = p.firstName?.localized?.en_US || p.firstName || '';
        const lastName = p.lastName?.localized?.en_US || p.lastName || '';
        const displayName = `${firstName} ${lastName}`.trim() || 'LinkedIn User';
        const avatarUrl = p.profilePicture?.displayImage || '';
        const profileHandle = p.publicIdentifier || sourceProfileId;
        const bio = p.headline || '';

        let existingProfile = db.select().from(schema.socialProfiles)
          .where(eq(schema.socialProfiles.sourceProfileId, sourceProfileId))
          .get();

        let profileIdToUse = existingProfile?.id;

        if (!existingProfile) {
          const socialProfileId = uuidv4();
          db.insert(schema.socialProfiles).values({
            id: socialProfileId,
            sourceType: 'linkedin',
            sourceProfileId: sourceProfileId,
            handle: profileHandle,
            displayName: displayName,
            avatarUrl: avatarUrl,
            bio: bio,
            rawPublicPayloadJson: JSON.stringify(p),
            firstSeenAt: now,
            lastSeenAt: now,
          }).run();
          profileIdToUse = socialProfileId;
          insertedCount++;
        } else {
           db.update(schema.socialProfiles).set({
            handle: profileHandle,
            displayName: displayName,
            avatarUrl: avatarUrl,
            bio: bio,
            lastSeenAt: now
           }).where(eq(schema.socialProfiles.id, existingProfile.id)).run();
           updatedCount++;
        }

        db.insert(schema.relationshipEdges).values({
          id: uuidv4(),
          sourceAccountId,
          socialProfileId: profileIdToUse as string,
          relationType: 'connection',
          observedAt: now,
          syncJobId
        }).run();

        assignProfileToCandidate(profileIdToUse as string, displayName, profileHandle, now);
      }
      
      db.update(schema.syncJobs).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.syncJobs.id, syncJobId)).run();
      db.update(schema.sourceAccounts).set({ authStatus: 'connected', updatedAt: new Date() }).where(eq(schema.sourceAccounts.id, sourceAccountId)).run();

      stream.success({ success: true, count: elements.length, insertedCount, updatedCount });
    } catch (e: any) {
      console.error(e);
      db.update(schema.syncJobs).set({ 
        status: 'failed', 
        finishedAt: new Date(),
        errorCode: 'SYNC_ERROR',
        errorMessageSafe: e.message || 'Unknown error occurred during sync'
      }).where(eq(schema.syncJobs.id, syncJobId)).run();
      stream.error(e.message);
    }
  });

  app.post("/api/sync/github", syncRateLimiter, async (req, res) => {
    const { sourceAccountId, token } = req.body;
    const syncJobId = uuidv4();
    const now = new Date();
    const stream = createStream(res);
    
    try {
      stream.progress('Initializing sync job...');
      db.insert(schema.syncJobs).values({
        id: syncJobId,
        sourceAccountId,
        status: 'running',
        startedAt: now,
      }).run();

      const fetchAllGitHubPages = async (url: string) => {
        let results: any[] = [];
        let currentUrl = url;
        
        while (currentUrl) {
          const res = await fetch(currentUrl, {
            headers: {
              'Authorization': `token ${token}`,
              'Accept': 'application/vnd.github.v3+json'
            }
          });
          
          if (!res.ok) {
            console.error(`GitHub API error: ${res.status} ${res.statusText}`);
            break;
          }
          
          const data = await res.json();
          if (Array.isArray(data)) {
            results = results.concat(data);
          }
          
          const linkHeader = res.headers.get('Link');
          if (linkHeader) {
            const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
            currentUrl = nextMatch ? nextMatch[1] : '';
          } else {
            currentUrl = '';
          }
        }
        return results;
      };

      const demoData = await loadDemoFixture<{ followers?: any[], following?: any[] }>('github');
      let followers: any[] = [];
      let following: any[] = [];

      if (demoData) {
        stream.progress('Loading demo data...');
        followers = demoData.followers || [];
        following = demoData.following || [];
      } else {
        stream.progress('Connecting to API...');
        const verifyRes = await fetch("https://api.github.com/user", {
          headers: {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        });

        if (!verifyRes.ok) {
          if (verifyRes.status === 401) {
            throw new Error('Invalid access token');
          } else {
            throw new Error(`Failed to verify GitHub credentials: ${verifyRes.status} ${verifyRes.statusText}`);
          }
        }

        stream.progress('Fetching followers...');
        followers = await fetchAllGitHubPages(`https://api.github.com/user/followers?per_page=100`);
        
        stream.progress('Fetching following...');
        following = await fetchAllGitHubPages(`https://api.github.com/user/following?per_page=100`);
      }
      
      const allProfilesMap = new Map();

      const processProfile = (p: any, relation: string) => {
        const existing = allProfilesMap.get(p.login);
        allProfilesMap.set(p.login, {
          sourceProfileId: p.id.toString(),
          handle: p.login,
          displayName: p.login || p.name || p.url, // login is fallback
          avatarUrl: p.avatar_url,
          bio: '',
          rawJson: JSON.stringify(p),
          relations: existing ? [...existing.relations, relation] : [relation],
        });
      };

      stream.progress('Processing profiles...');
      if (Array.isArray(followers)) followers.forEach(p => processProfile(p, 'followed_by'));
      if (Array.isArray(following)) following.forEach(p => processProfile(p, 'follows'));

      let insertedCount = 0;
      let updatedCount = 0;
      
      stream.progress('Merging duplicates in database...');
      for (const [handle, data] of allProfilesMap.entries()) {
        const socialProfileId = uuidv4();
        
        let existingProfile = db.select().from(schema.socialProfiles)
          .where(eq(schema.socialProfiles.sourceProfileId, data.sourceProfileId))
          .get();

        let profileIdToUse = existingProfile?.id;

        if (!existingProfile) {
          db.insert(schema.socialProfiles).values({
            id: socialProfileId,
            sourceType: 'github',
            sourceProfileId: data.sourceProfileId,
            handle: data.handle,
            displayName: data.displayName,
            avatarUrl: data.avatarUrl,
            bio: data.bio,
            rawPublicPayloadJson: data.rawJson,
            firstSeenAt: now,
            lastSeenAt: now,
          }).run();
          profileIdToUse = socialProfileId;
          insertedCount++;
        } else {
           db.update(schema.socialProfiles).set({
            handle: data.handle,
            displayName: data.displayName,
            avatarUrl: data.avatarUrl,
            bio: data.bio,
            lastSeenAt: now
           }).where(eq(schema.socialProfiles.id, existingProfile.id)).run();
           updatedCount++;
        }

        for (const relation of data.relations) {
          db.insert(schema.relationshipEdges).values({
            id: uuidv4(),
            sourceAccountId,
            socialProfileId: profileIdToUse,
            relationType: relation,
            observedAt: now,
            syncJobId
          }).run();
        }

        assignProfileToCandidate(profileIdToUse as string, data.displayName, data.handle, now);
      }

      db.update(schema.syncJobs).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.syncJobs.id, syncJobId)).run();
      db.update(schema.sourceAccounts).set({ authStatus: 'connected', updatedAt: new Date() }).where(eq(schema.sourceAccounts.id, sourceAccountId)).run();

      stream.success({ success: true, count: allProfilesMap.size, insertedCount, updatedCount });

    } catch (e: any) {
      console.error(e);
      db.update(schema.syncJobs).set({ 
        status: 'failed', 
        finishedAt: new Date(),
        errorCode: 'SYNC_ERROR',
        errorMessageSafe: e.message || 'Unknown error occurred during sync'
      }).where(eq(schema.syncJobs.id, syncJobId)).run();
      stream.error(e.message);
    }
  });

  app.post("/api/sync/google", syncRateLimiter, async (req, res) => {
    const { sourceAccountId, tokens, clientId, clientSecret, token } = req.body;
    const syncJobId = uuidv4();
    const now = new Date();
    const stream = createStream(res);
    
    try {
      stream.progress('Initializing sync job...');
      db.insert(schema.syncJobs).values({
        id: syncJobId,
        sourceAccountId,
        status: 'running',
        startedAt: now,
      }).run();

      let allConnections: any[] = [];
      const demoData = await loadDemoFixture<{ connections?: any[] }>('google');

      if (demoData) {
        stream.progress('Loading demo data...');
        allConnections = demoData.connections || [];
      } else {
        const { OAuth2Client } = await import('google-auth-library');
        let authClient: any;
        if (clientId && clientSecret && tokens) {
          authClient = new OAuth2Client(clientId, clientSecret);
          authClient.setCredentials(tokens);
        } else {
          authClient = new OAuth2Client();
          authClient.setCredentials({ access_token: token });
        }

        stream.progress('Connecting to Google People API...');
        const fields = 'names,emailAddresses,photos,biographies,urls,organizations';
        let nextPageToken = '';

        do {
          const url = `https://people.googleapis.com/v1/people/me/connections?pageSize=1000&personFields=${fields}${nextPageToken ? `&pageToken=${nextPageToken}` : ''}`;
          
          const contactsRes = await authClient.request({ url });
          const data = contactsRes.data;

          if (data.connections) {
            allConnections = allConnections.concat(data.connections);
          }
          nextPageToken = data.nextPageToken || '';
          
          stream.progress(`Fetched ${allConnections.length} contacts...`);
        } while (nextPageToken);
      }

      let insertedCount = 0;
      let updatedCount = 0;

      stream.progress('Processing profiles into database...');
      for (const p of allConnections) {
        const sourceProfileId = p.resourceName;
        const displayName = p.names && p.names.length > 0 ? p.names[0].displayName : (p.emailAddresses && p.emailAddresses.length > 0 ? p.emailAddresses[0].value : 'Unknown');
        const handle = p.emailAddresses && p.emailAddresses.length > 0 ? p.emailAddresses[0].value : sourceProfileId;
        const avatarUrl = p.photos && p.photos.length > 0 && !p.photos[0].default ? p.photos[0].url : null;
        let bio = p.biographies && p.biographies.length > 0 ? p.biographies[0].value : null;
        if (!bio && p.organizations && p.organizations.length > 0) {
           const title = p.organizations[0].title || '';
           const name = p.organizations[0].name || '';
           bio = [title, name].filter(Boolean).join(' at ');
        }
        
        let profileUrl = null;
        if (p.urls && p.urls.length > 0) {
            profileUrl = p.urls[0].value;
        }

        const socialProfileId = uuidv4();
        
        const existingProfile = db.select().from(schema.socialProfiles)
          .where(eq(schema.socialProfiles.sourceProfileId, sourceProfileId))
          .get();

        let profileIdToUse = existingProfile?.id;

        if (!existingProfile) {
          db.insert(schema.socialProfiles).values({
            id: socialProfileId,
            sourceType: 'google',
            sourceProfileId,
            handle,
            displayName,
            profileUrl,
            avatarUrl,
            bio,
            rawPublicPayloadJson: JSON.stringify(p),
            firstSeenAt: now,
            lastSeenAt: now,
          }).run();
          profileIdToUse = socialProfileId;
          insertedCount++;
        } else {
           db.update(schema.socialProfiles).set({
            handle,
            displayName,
            profileUrl,
            avatarUrl,
            bio,
            lastSeenAt: now
           }).where(eq(schema.socialProfiles.id, existingProfile.id)).run();
           updatedCount++;
        }

        db.insert(schema.relationshipEdges).values({
          id: uuidv4(),
          sourceAccountId,
          socialProfileId: profileIdToUse as string,
          relationType: 'contact',
          observedAt: now,
          syncJobId
        }).run();

        assignProfileToCandidate(profileIdToUse as string, displayName, handle, now);
      }

      db.update(schema.syncJobs).set({ status: 'completed', finishedAt: new Date() }).where(eq(schema.syncJobs.id, syncJobId)).run();
      db.update(schema.sourceAccounts).set({ authStatus: 'connected', updatedAt: new Date() }).where(eq(schema.sourceAccounts.id, sourceAccountId)).run();

      stream.success({ success: true, count: allConnections.length, insertedCount, updatedCount });

    } catch (e: any) {
      console.error(e);
      db.update(schema.syncJobs).set({ 
        status: 'failed', 
        finishedAt: new Date(),
        errorCode: 'SYNC_ERROR',
        errorMessageSafe: e.message || 'Unknown error occurred during sync'
      }).where(eq(schema.syncJobs.id, syncJobId)).run();
      stream.error(e.message);
    }
  });

  // Add route for manual capture from extension
  app.post("/api/capture/manual", (req, res) => {
    const { source, profileUrl, displayName, headline, handle, capturedAt } = req.body;
    
    // Save as social profile and create candidate
    const id = uuidv4();
    const now = new Date();
    
    db.insert(schema.socialProfiles).values({
      id,
      sourceType: source,
      sourceProfileId: handle, 
      handle,
      displayName,
      profileUrl,
      bio: headline,
      rawPublicPayloadJson: JSON.stringify(req.body),
      firstSeenAt: now,
      lastSeenAt: now,
    }).run();

    const candidateId = uuidv4();
    db.insert(schema.contactCandidates).values({
      id: candidateId,
      canonicalName: displayName,
      confidenceScore: 100, // manual capture is high confidence
      status: 'approved', // maybe default to pending, but ok
      createdAt: now,
      updatedAt: now
    }).run();

    db.insert(schema.contactCandidateProfiles).values({
      contactCandidateId: candidateId,
      socialProfileId: id
    }).run();

    res.json({ success: true, id: candidateId });
  });

  // --- END API ROUTES ---


  // Vite middleware for development
  if (process.env.CONTACTBRIDGE_DISABLE_FRONTEND !== '1' && process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (process.env.CONTACTBRIDGE_DISABLE_FRONTEND !== '1') {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
