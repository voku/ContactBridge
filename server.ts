import express from "express";
import fs from "fs/promises";
import * as crypto from "crypto";
import net from "net";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { v4 as uuidv4 } from "uuid";
import * as schema from "./src/lib/db/schema.js";
import { and, eq, desc } from "drizzle-orm";
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
    auth_data TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS source_account_secrets (
    source_account_id TEXT PRIMARY KEY,
    encrypted_payload TEXT NOT NULL,
    encryption_version INTEGER NOT NULL,
    created_at INTEGER,
    updated_at INTEGER,
    FOREIGN KEY (source_account_id) REFERENCES source_accounts(id)
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

  CREATE TABLE IF NOT EXISTS candidate_match_evidence (
    id TEXT PRIMARY KEY,
    candidate_id TEXT,
    profile_id TEXT,
    evidence_type TEXT NOT NULL,
    evidence_value TEXT,
    score INTEGER NOT NULL,
    created_at INTEGER,
    FOREIGN KEY (candidate_id) REFERENCES contact_candidates(id),
    FOREIGN KEY (profile_id) REFERENCES social_profiles(id)
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

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER
  );
`);

try {
  sqlite.exec("ALTER TABLE contact_candidates ADD COLUMN notes TEXT;");
} catch (e) {
  // column might already exist
}

try {
  sqlite.exec("ALTER TABLE source_accounts ADD COLUMN auth_data TEXT;");
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

const LINKEDIN_CONNECTIONS_PROJECTION = '(elements*(to,to~(id,firstName,lastName,headline,profilePicture,publicIdentifier)))';

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
    // Unique local IPv6 addresses live in the fc00::/7 range, which includes both fc00::/8 and fd00::/8.
    const isUniqueLocalIpv6 = /^(fc|fd)[0-9a-f]{2}:/i.test(hostname);
    // Matches the fe80::/10 IPv6 link-local range (fe80:: through febf::).
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

const MANUAL_CAPTURE_SOURCES = new Set(['bluesky', 'linkedin', 'x', 'xing']);
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const VALID_APP_MODES = new Set(['local', 'hosted', 'test']);
const DEFAULT_APP_MODE = process.env.NODE_ENV === 'test' ? 'test' : 'local';
const requestedAppMode = (process.env.APP_MODE || DEFAULT_APP_MODE).toLowerCase();
const APP_MODE = VALID_APP_MODES.has(requestedAppMode) ? requestedAppMode : DEFAULT_APP_MODE;
const isLocalMode = APP_MODE === 'local' || APP_MODE === 'test';
const SECRET_ENCRYPTION_VERSION = 1;

const parseOriginList = (value: string | undefined) => (value || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const parseConfiguredOrigin = (value: string | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
};

const isLoopbackOrigin = (origin: string) => {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};

const getCorsAllowedOrigins = () => {
  const origins = new Set(parseOriginList(process.env.CONTACTBRIDGE_CORS_ORIGINS));
  const appOrigin = parseConfiguredOrigin(process.env.APP_URL);
  const frontendOrigin = parseConfiguredOrigin(process.env.VITE_API_BASE_URL);

  if (appOrigin) origins.add(appOrigin);
  if (frontendOrigin) origins.add(frontendOrigin);
  return origins;
};

const getSecretKeyMaterial = () => {
  const configured = process.env.CONTACTBRIDGE_SECRET_KEY?.trim();
  if (configured) return configured;
  if (!isLocalMode) {
    throw new Error('CONTACTBRIDGE_SECRET_KEY is required to store or read encrypted source account secrets in hosted mode.');
  }

  const existingSecret = db.select().from(schema.appSettings)
    .where(eq(schema.appSettings.key, 'local_secret'))
    .get();
  if (existingSecret?.value) {
    return existingSecret.value;
  }

  const now = new Date();
  const generatedSecret = crypto.randomBytes(32).toString('base64');
  db.insert(schema.appSettings).values({
    key: 'local_secret',
    value: generatedSecret,
    createdAt: now,
    updatedAt: now
  }).run();
  return generatedSecret;
};

const getSecretEncryptionKey = () => crypto.createHash('sha256').update(getSecretKeyMaterial()).digest();


const trimMaybeString = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const normalizeProfileHandle = (value: unknown) => trimMaybeString(value).replace(/^@+/, '').toLowerCase();

type SourceAccountAuthData = {
  accessToken?: string;
  refreshToken?: string;
  tokens?: Record<string, unknown>;
  clientId?: string;
  clientSecret?: string;
};

type OAuthStateEntry = {
  clientId: string;
  clientSecret: string;
  popupOrigin: string | null;
  sourceAccountId: string | null;
  createdAt: number;
};

type XOauthStateEntry = OAuthStateEntry & {
  codeVerifier: string;
  state: string;
};

const normalizePopupOrigin = (value: unknown) => {
  const origin = trimMaybeString(value);
  if (!origin) {
    return null;
  }

  try {
    const popupUrl = new URL(origin);
    if (popupUrl.protocol !== 'http:' && popupUrl.protocol !== 'https:') {
      return null;
    }

    popupUrl.pathname = '';
    popupUrl.search = '';
    popupUrl.hash = '';
    return popupUrl.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
};

const getAppOrigin = (req: express.Request) => {
  const configuredUrl = trimMaybeString(process.env.APP_URL);
  if (configuredUrl) {
    return new URL(configuredUrl).origin;
  }

  return `${req.protocol}://${req.get('host')}`;
};

const getOauthRedirectUri = (req: express.Request, provider: 'google' | 'x') => {
  return `${getAppOrigin(req)}/auth/${provider}/callback`;
};

const serializeForInlineScript = (value: unknown) => {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
};

const mergeCandidateNotes = (notes: Array<string | null | undefined>) => {
  const mergedNotes = Array.from(new Set(
    notes
      .map((note) => trimMaybeString(note))
      .filter(Boolean)
  ));

  return mergedNotes.length > 0 ? mergedNotes.join('\n\n') : null;
};

type SyncedRelationProfile = {
  sourceProfileId: string;
  handle: string;
  displayName: string;
  avatarUrl?: string | null;
  bio?: string | null;
  rawJson: string;
  relations: string[];
};

const appendUniqueRelation = (relations: readonly string[] = [], relation: string) => (
  Array.from(new Set([...relations, relation]))
);

type CandidateProfileWithRelations = typeof schema.socialProfiles.$inferSelect & {
  relations: string[];
};

type CandidateRelationshipSummary = {
  relationTypes: string[];
  profilesWithRelationships: number;
  mutualProfileCount: number;
  followsCount: number;
  followedByCount: number;
  connectionCount: number;
  contactCount: number;
};

const RELATION_PRIORITY: Record<string, number> = {
  followed_by: 0,
  follows: 1,
  connection: 2,
  contact: 3,
};

const getProfileRelations = (socialProfileId: string) => (
  db.select({ relationType: schema.relationshipEdges.relationType })
    .from(schema.relationshipEdges)
    .where(eq(schema.relationshipEdges.socialProfileId, socialProfileId))
    .all()
    .map((entry) => entry.relationType)
    .filter((relationType): relationType is string => Boolean(relationType))
    .sort((left, right) => (RELATION_PRIORITY[left] ?? 99) - (RELATION_PRIORITY[right] ?? 99) || left.localeCompare(right))
);

const summarizeCandidateRelationships = (profiles: CandidateProfileWithRelations[]): CandidateRelationshipSummary => {
  const relationTypes = new Set<string>();
  let profilesWithRelationships = 0;
  let mutualProfileCount = 0;
  let followsCount = 0;
  let followedByCount = 0;
  let connectionCount = 0;
  let contactCount = 0;

  for (const profile of profiles) {
    if (profile.relations.length > 0) {
      profilesWithRelationships += 1;
    }

    const relationSet = new Set(profile.relations);
    for (const relation of relationSet) {
      relationTypes.add(relation);
    }

    if (relationSet.has('follows')) {
      followsCount += 1;
    }
    if (relationSet.has('followed_by')) {
      followedByCount += 1;
    }
    if (relationSet.has('connection')) {
      connectionCount += 1;
    }
    if (relationSet.has('contact')) {
      contactCount += 1;
    }
    if (relationSet.has('follows') && relationSet.has('followed_by')) {
      mutualProfileCount += 1;
    }
  }

  return {
    relationTypes: Array.from(relationTypes).sort((left, right) => (RELATION_PRIORITY[left] ?? 99) - (RELATION_PRIORITY[right] ?? 99) || left.localeCompare(right)),
    profilesWithRelationships,
    mutualProfileCount,
    followsCount,
    followedByCount,
    connectionCount,
    contactCount,
  };
};

const parseSourceAccountAuthData = (authData: string | null | undefined): SourceAccountAuthData | null => {
  if (!authData) {
    return null;
  }

  try {
    const parsed = JSON.parse(authData);
    return parsed && typeof parsed === 'object' ? parsed as SourceAccountAuthData : null;
  } catch {
    return null;
  }
};

const encryptSecretPayload = (payload: SourceAccountAuthData) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getSecretEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  });
};

const decryptSecretPayload = (encryptedPayload: string): SourceAccountAuthData | null => {
  try {
    const payload = JSON.parse(encryptedPayload);
    if (!payload || payload.alg !== 'aes-256-gcm') {
      return null;
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      getSecretEncryptionKey(),
      Buffer.from(payload.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, 'base64')),
      decipher.final()
    ]).toString('utf8');

    const parsed = JSON.parse(decrypted);
    return parsed && typeof parsed === 'object' ? parsed as SourceAccountAuthData : null;
  } catch {
    return null;
  }
};

const getSourceAccount = (id: string) => db.select().from(schema.sourceAccounts)
  .where(eq(schema.sourceAccounts.id, id))
  .get();

const getStoredSourceAccountAuth = (sourceAccountId: string) => {
  const account = getSourceAccount(sourceAccountId);
  if (!account) {
    throw new Error('Source account not found');
  }

  const secret = db.select().from(schema.sourceAccountSecrets)
    .where(eq(schema.sourceAccountSecrets.sourceAccountId, sourceAccountId))
    .get();
  const encryptedAuthData = secret ? decryptSecretPayload(secret.encryptedPayload) : null;
  const legacyAuthData = encryptedAuthData ? null : parseSourceAccountAuthData(account.authData);

  return { account, authData: encryptedAuthData || legacyAuthData };
};

const storeSourceAccountAuth = (sourceAccountId: string, authData: SourceAccountAuthData) => {
  const now = new Date();
  const encryptedPayload = encryptSecretPayload(authData);
  const existingSecret = db.select().from(schema.sourceAccountSecrets)
    .where(eq(schema.sourceAccountSecrets.sourceAccountId, sourceAccountId))
    .get();

  if (existingSecret) {
    db.update(schema.sourceAccountSecrets)
      .set({
        encryptedPayload,
        encryptionVersion: SECRET_ENCRYPTION_VERSION,
        updatedAt: now
      })
      .where(eq(schema.sourceAccountSecrets.sourceAccountId, sourceAccountId))
      .run();
  } else {
    db.insert(schema.sourceAccountSecrets)
      .values({
        sourceAccountId,
        encryptedPayload,
        encryptionVersion: SECRET_ENCRYPTION_VERSION,
        createdAt: now,
        updatedAt: now
      })
      .run();
  }

  db.update(schema.sourceAccounts)
    .set({
      authData: null,
      updatedAt: now
    })
    .where(eq(schema.sourceAccounts.id, sourceAccountId))
    .run();
};

const pruneExpiredOauthStates = <T extends { createdAt: number }>(store: Map<string, T>) => {
  const cutoff = Date.now() - OAUTH_STATE_TTL_MS;
  for (const [state, entry] of store.entries()) {
    if (entry.createdAt < cutoff) {
      store.delete(state);
    }
  }
};

const getOauthStateEntry = <T extends { createdAt: number }>(store: Map<string, T>, state: string) => {
  pruneExpiredOauthStates(store);
  const entry = store.get(state);
  if (!entry) {
    return null;
  }

  if (entry.createdAt < Date.now() - OAUTH_STATE_TTL_MS) {
    store.delete(state);
    return null;
  }

  return entry;
};

const normalizeManualCaptureSourceProfileId = (source: string, handle: string, profileUrl: string | null) => {
  const normalizedHandle = normalizeProfileHandle(handle);
  if (normalizedHandle) {
    return normalizedHandle;
  }

  if (!profileUrl) {
    return '';
  }

  const parsedProfileUrl = new URL(profileUrl);
  const pathSegments = parsedProfileUrl.pathname.split('/').filter(Boolean);
  if (source === 'linkedin' && pathSegments[0] === 'in' && pathSegments[1]) {
    return pathSegments[1].toLowerCase();
  }

  if (source === 'bluesky' && pathSegments[0] === 'profile' && pathSegments[1]) {
    return pathSegments[1].toLowerCase();
  }

  if (source === 'x' && pathSegments[0]) {
    return pathSegments[0].toLowerCase();
  }

  if (source === 'xing' && pathSegments[0] === 'profile' && pathSegments[1]) {
    return decodeURIComponent(pathSegments[1]).toLowerCase();
  }

  return profileUrl.toLowerCase();
};

const cleanupOrphanedProfiles = (socialProfileIds: Iterable<string>) => {
  for (const socialProfileId of new Set(Array.from(socialProfileIds).filter(Boolean))) {
    const remainingRelationship = db.select({ id: schema.relationshipEdges.id })
      .from(schema.relationshipEdges)
      .where(eq(schema.relationshipEdges.socialProfileId, socialProfileId))
      .get();

    if (remainingRelationship) {
      continue;
    }

    const affectedCandidateIds = db.select({ contactCandidateId: schema.contactCandidateProfiles.contactCandidateId })
      .from(schema.contactCandidateProfiles)
      .where(eq(schema.contactCandidateProfiles.socialProfileId, socialProfileId))
      .all()
      .map((entry) => entry.contactCandidateId)
      .filter((candidateId): candidateId is string => Boolean(candidateId));

    db.delete(schema.candidateMatchEvidence)
      .where(eq(schema.candidateMatchEvidence.profileId, socialProfileId))
      .run();
    db.delete(schema.contactCandidateProfiles)
      .where(eq(schema.contactCandidateProfiles.socialProfileId, socialProfileId))
      .run();
    db.delete(schema.socialProfiles)
      .where(eq(schema.socialProfiles.id, socialProfileId))
      .run();

    for (const candidateId of affectedCandidateIds) {
      const remainingProfile = db.select({ socialProfileId: schema.contactCandidateProfiles.socialProfileId })
        .from(schema.contactCandidateProfiles)
        .where(eq(schema.contactCandidateProfiles.contactCandidateId, candidateId))
        .get();

      if (!remainingProfile) {
        db.delete(schema.contactCandidates)
          .where(eq(schema.contactCandidates.id, candidateId))
          .run();
      }
    }
  }
};

const clearSourceRelationships = (sourceAccountId: string) => {
  const relatedProfileIds = db.select({ socialProfileId: schema.relationshipEdges.socialProfileId })
    .from(schema.relationshipEdges)
    .where(eq(schema.relationshipEdges.sourceAccountId, sourceAccountId))
    .all()
    .map((edge) => edge.socialProfileId)
    .filter((profileId): profileId is string => Boolean(profileId));

  db.delete(schema.relationshipEdges)
    .where(eq(schema.relationshipEdges.sourceAccountId, sourceAccountId))
    .run();

  return relatedProfileIds;
};

const getLinkedInLocalizedText = (value: any) => {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value.localized && typeof value.localized === 'object') {
    const preferredLocaleKey = value.preferredLocale?.language && value.preferredLocale?.country
      ? `${value.preferredLocale.language}_${value.preferredLocale.country}`
      : null;

    if (preferredLocaleKey && typeof value.localized[preferredLocaleKey] === 'string') {
      return value.localized[preferredLocaleKey];
    }

    const firstLocalizedValue = Object.values(value.localized).find((entry) => typeof entry === 'string');
    if (typeof firstLocalizedValue === 'string') {
      return firstLocalizedValue;
    }
  }

  return '';
};

const getLinkedInProfilePictureUrl = (profilePicture: any) => {
  if (!profilePicture) {
    return '';
  }

  if (typeof profilePicture.displayImage === 'string' && /^https?:\/\//.test(profilePicture.displayImage)) {
    return profilePicture.displayImage;
  }

  const displayImageElements = profilePicture['displayImage~']?.elements;
  if (!Array.isArray(displayImageElements)) {
    return '';
  }

  for (const element of [...displayImageElements].reverse()) {
    const identifier = element?.identifiers?.find((entry: any) => typeof entry?.identifier === 'string');
    if (identifier?.identifier) {
      return identifier.identifier;
    }
  }

  return '';
};

const serializeCandidateEvidenceValue = (value: Record<string, string>) => JSON.stringify(value);

const addCandidateMatchEvidence = (
  candidateId: string,
  profileId: string,
  evidenceType: string,
  evidenceValue: string | null,
  score: number,
  now: Date
) => {
  db.insert(schema.candidateMatchEvidence).values({
    id: uuidv4(),
    candidateId,
    profileId,
    evidenceType,
    evidenceValue,
    score,
    createdAt: now
  }).run();
};

function assignProfileToCandidate(profileIdToUse: string, displayName: string, handle: string, now: Date) {
  const normalizedHandle = normalizeProfileHandle(handle);
  const existingCandidateProfile = db.select().from(schema.contactCandidateProfiles)
    .where(eq(schema.contactCandidateProfiles.socialProfileId, profileIdToUse))
    .get();

  if (existingCandidateProfile) {
    return;
  }

  const currentProfile = db.select().from(schema.socialProfiles)
    .where(eq(schema.socialProfiles.id, profileIdToUse))
    .get();
  let matchedCandidateId: string | null = null;
  const reviewEvidence: Array<{ evidenceType: string; evidenceValue: string; score: number }> = [];

  if (currentProfile?.sourceType && normalizedHandle) {
    const sameSourceHandleProfiles = db.select().from(schema.socialProfiles)
      .where(and(
        eq(schema.socialProfiles.sourceType, currentProfile.sourceType),
        eq(schema.socialProfiles.handle, normalizedHandle)
      )).all();

    for (const profile of sameSourceHandleProfiles) {
      if (profile.id === profileIdToUse) continue;
      const candidateProfile = db.select().from(schema.contactCandidateProfiles)
        .where(eq(schema.contactCandidateProfiles.socialProfileId, profile.id))
        .get();
      if (candidateProfile?.contactCandidateId) {
        matchedCandidateId = candidateProfile.contactCandidateId;
        addCandidateMatchEvidence(matchedCandidateId, profileIdToUse, 'same_source_handle', normalizedHandle, 90, now);
        break;
      }
    }
  }

  if (!matchedCandidateId && normalizedHandle) {
    const crossSourceHandleProfiles = db.select().from(schema.socialProfiles)
      .where(eq(schema.socialProfiles.handle, normalizedHandle)).all();
    for (const profile of crossSourceHandleProfiles) {
      if (profile.id === profileIdToUse || profile.sourceType === currentProfile?.sourceType) continue;
      const candidateProfile = db.select().from(schema.contactCandidateProfiles)
        .where(eq(schema.contactCandidateProfiles.socialProfileId, profile.id))
        .get();
      if (candidateProfile?.contactCandidateId) {
        reviewEvidence.push({
          evidenceType: 'cross_source_handle_review',
          evidenceValue: serializeCandidateEvidenceValue({ candidateId: candidateProfile.contactCandidateId, handle: normalizedHandle }),
          score: 75
        });
        break;
      }
    }
  }

  if (!matchedCandidateId && displayName) {
    const sameNameCandidate = db.select().from(schema.contactCandidates)
      .where(eq(schema.contactCandidates.canonicalName, displayName)).get();
    if (sameNameCandidate?.id) {
      reviewEvidence.push({
        evidenceType: 'display_name_only_review',
        evidenceValue: serializeCandidateEvidenceValue({ displayName }),
        score: 20
      });
    }
  }

  if (matchedCandidateId) {
    db.insert(schema.contactCandidateProfiles).values({
      contactCandidateId: matchedCandidateId,
      socialProfileId: profileIdToUse
    }).run();
    return;
  }

  const candidateId = uuidv4();
  db.insert(schema.contactCandidates).values({
    id: candidateId,
    canonicalName: displayName || normalizedHandle || 'Unknown',
    confidenceScore: 50,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  }).run();

  db.insert(schema.contactCandidateProfiles).values({
    contactCandidateId: candidateId,
    socialProfileId: profileIdToUse
  }).run();

  for (const evidence of reviewEvidence) {
    addCandidateMatchEvidence(candidateId, profileIdToUse, evidence.evidenceType, evidence.evidenceValue, evidence.score, now);
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT || 3000);
  const syncRateLimiter = createRateLimiter(60_000, 10);
  const corsAllowedOrigins = getCorsAllowedOrigins();

  app.use(cors({
    origin: (origin, callback) => {
      if ((!origin && isLocalMode) || (origin && (corsAllowedOrigins.has(origin) || (isLocalMode && isLoopbackOrigin(origin))))) {
        callback(null, true);
        return;
      }

      callback(new Error('CORS origin is not allowed by ContactBridge configuration.'));
    }
  }));
  app.use(express.json({ limit: '100kb' }));

  // --- API ROUTES ---
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", appMode: APP_MODE });
  });

  app.delete("/api/database", (req, res) => {
    if (!isLocalMode) {
      return res.status(403).json({ error: "Database reset is only available in local or test mode." });
    }

    if (req.get("x-contactbridge-confirm-reset") !== "erase-local-data") {
      return res.status(400).json({ error: "Database reset requires an explicit confirmation header." });
    }

    try {
      sqlite.transaction(() => {
        db.delete(schema.candidateMatchEvidence).run();
        db.delete(schema.contactCandidateProfiles).run();
        db.delete(schema.relationshipEdges).run();
        db.delete(schema.syncJobs).run();
        db.delete(schema.contactCandidates).run();
        db.delete(schema.socialProfiles).run();
        db.delete(schema.sourceAccountSecrets).run();
        db.delete(schema.sourceAccounts).run();
      })();

      res.json({ success: true });
    } catch (e: unknown) {
      const errorMessage = e instanceof Error ? e.message : "Failed to erase database";
      console.error("Failed to erase database:", e);
      res.status(500).json({ error: errorMessage });
    }
  });

  // Source Accounts
  app.get("/api/source-accounts", (req, res) => {
    const accounts = db.select({
      id: schema.sourceAccounts.id,
      sourceType: schema.sourceAccounts.sourceType,
      accountIdentifier: schema.sourceAccounts.accountIdentifier,
      displayName: schema.sourceAccounts.displayName,
      authStatus: schema.sourceAccounts.authStatus,
      createdAt: schema.sourceAccounts.createdAt,
      updatedAt: schema.sourceAccounts.updatedAt
    }).from(schema.sourceAccounts).all();
    res.json(accounts);
  });

  app.post("/api/source-accounts", (req, res) => {
    const sourceType = trimMaybeString(req.body?.sourceType).toLowerCase();
    const accountIdentifier = trimMaybeString(req.body?.accountIdentifier);
    const displayName = trimMaybeString(req.body?.displayName);
    const authStatus = trimMaybeString(req.body?.authStatus) || 'pending';

    if (!['bluesky', 'github', 'google', 'linkedin', 'mastodon', 'x', 'xing'].includes(sourceType)) {
      return res.status(400).json({ error: 'Unsupported source type.' });
    }

    if (authStatus && !['pending', 'connected', 'failed', 'disconnected'].includes(authStatus)) {
      return res.status(400).json({ error: 'Unsupported auth status.' });
    }

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
      db.transaction(() => {
        db.delete(schema.syncJobs).where(eq(schema.syncJobs.sourceAccountId, id)).run();
        db.delete(schema.sourceAccountSecrets).where(eq(schema.sourceAccountSecrets.sourceAccountId, id)).run();
        const relatedProfileIds = clearSourceRelationships(id);
        db.delete(schema.sourceAccounts).where(eq(schema.sourceAccounts.id, id)).run();
        cleanupOrphanedProfiles(relatedProfileIds);
      });
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
        const profile = db.select().from(schema.socialProfiles)
          .where(eq(schema.socialProfiles.id, cp.socialProfileId as string))
          .get();
        if (!profile) {
          return null;
        }

        return {
          ...profile,
          relations: getProfileRelations(profile.id),
        };
      }).filter((profile): profile is CandidateProfileWithRelations => Boolean(profile));

      return {
        ...c,
        profiles,
        relationshipSummary: summarizeCandidateRelationships(profiles),
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
        const primaryCandidate = db.select().from(schema.contactCandidates)
          .where(eq(schema.contactCandidates.id, primaryCandidateId))
          .get();

        if (!primaryCandidate) {
          throw new Error('Primary candidate not found');
        }

        const secondaryCandidates = secondaryCandidateIds
          .filter((id) => typeof id === 'string' && id !== primaryCandidateId)
          .map((id) => db.select().from(schema.contactCandidates)
            .where(eq(schema.contactCandidates.id, id))
            .get())
          .filter(Boolean);

        db.update(schema.contactCandidates)
          .set({
            canonicalName: primaryCandidate.canonicalName || secondaryCandidates.find((candidate) => candidate?.canonicalName)?.canonicalName || 'Unknown',
            confidenceScore: Math.max(
              primaryCandidate.confidenceScore || 0,
              ...secondaryCandidates.map((candidate) => candidate?.confidenceScore || 0)
            ),
            notes: mergeCandidateNotes([primaryCandidate.notes, ...secondaryCandidates.map((candidate) => candidate?.notes)]),
            status: [primaryCandidate.status, ...secondaryCandidates.map((candidate) => candidate?.status)].includes('approved')
              ? 'approved'
              : primaryCandidate.status || 'pending',
            updatedAt: new Date()
          })
          .where(eq(schema.contactCandidates.id, primaryCandidateId))
          .run();

        for (const id of secondaryCandidateIds) {
          if (id === primaryCandidateId) continue;
          db.update(schema.contactCandidateProfiles)
            .set({ contactCandidateId: primaryCandidateId })
            .where(eq(schema.contactCandidateProfiles.contactCandidateId, id))
            .run();

          db.delete(schema.candidateMatchEvidence)
            .where(eq(schema.candidateMatchEvidence.candidateId, id))
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
    const pendingCandidates = db.select().from(schema.contactCandidates).where(eq(schema.contactCandidates.status, 'pending')).all().length;
    const approvedContacts = db.select().from(schema.contactCandidates).where(eq(schema.contactCandidates.status, 'approved')).all().length;
    const totalProfiles = db.select().from(schema.socialProfiles).all().length;
    const failedSyncJobs = db.select().from(schema.syncJobs).where(eq(schema.syncJobs.status, 'failed')).all().length;
    res.json({ totalCandidates: pendingCandidates, approvedContacts, indexedProfiles: totalProfiles, failedSyncJobs });
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
    const status = req.body?.status === undefined ? undefined : trimMaybeString(req.body.status);
    const notes = req.body?.notes === undefined ? undefined : trimMaybeString(req.body.notes);

    if (status !== undefined && !['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Unsupported candidate status.' });
    }
    
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

      const demoData = await loadDemoFixture<{
        followersResponse?: { followers?: any[] },
        followsResponse?: { follows?: any[] }
      }>('bluesky');
      let followers: any[] = [];
      let follows: any[] = [];

      if (demoData) {
        stream.progress('Loading demo data...');
        followers = demoData.followersResponse?.followers || [];
        follows = demoData.followsResponse?.follows || [];
      } else {
        stream.progress('Connecting to API...');
        const { BskyAgent } = await import('@atproto/api');
        const agent = new BskyAgent({ service: 'https://bsky.social' });
        await agent.login({ identifier, password });

        stream.progress('Fetching followers...');
        const followersResponse = await agent.getFollowers({ actor: agent.session!.did });
        
        stream.progress('Fetching follows...');
        const followsResponse = await agent.getFollows({ actor: agent.session!.did });
        followers = followersResponse.data.followers;
        follows = followsResponse.data.follows;
      }
      
      const allProfilesMap = new Map<string, SyncedRelationProfile>();

      // Normalize
      const processProfile = (p: any, relation: string) => {
        const existing = allProfilesMap.get(p.did);
        allProfilesMap.set(p.did, {
          sourceProfileId: p.did,
          handle: p.handle,
          displayName: p.displayName || p.handle,
          avatarUrl: p.avatar,
          bio: p.description,
          rawJson: JSON.stringify(p),
          relations: appendUniqueRelation(existing?.relations, relation),
        });
      };

      stream.progress('Processing profiles...');
      followers.forEach(p => processProfile(p, 'followed_by'));
      follows.forEach(p => processProfile(p, 'follows'));

      let insertedCount = 0;
      let updatedCount = 0;
      const staleProfileIds = clearSourceRelationships(sourceAccountId);

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

        // Create contact candidate if it doesn't have one
        assignProfileToCandidate(profileIdToUse as string, data.displayName, data.handle, now);
      }

      cleanupOrphanedProfiles(staleProfileIds);
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
      
      const allProfilesMap = new Map<string, SyncedRelationProfile>();

      const processProfile = (p: any, relation: string) => {
        const existing = allProfilesMap.get(p.acct);
        allProfilesMap.set(p.acct, {
          sourceProfileId: p.id,
          handle: p.acct,
          displayName: p.display_name || p.username,
          avatarUrl: p.avatar,
          bio: p.note ? p.note.replace(/<[^>]*>?/gm, '') : '', // strip HTML
          rawJson: JSON.stringify(p),
          relations: appendUniqueRelation(existing?.relations, relation),
        });
      };

      stream.progress('Processing profiles...');
      if (Array.isArray(followers)) followers.forEach(p => processProfile(p, 'followed_by'));
      if (Array.isArray(following)) following.forEach(p => processProfile(p, 'follows'));

      let insertedCount = 0;
      let updatedCount = 0;
      const staleProfileIds = clearSourceRelationships(sourceAccountId);

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

      cleanupOrphanedProfiles(staleProfileIds);
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


  const oauthStore = new Map<string, XOauthStateEntry>();

  app.post('/api/auth/x/url', syncRateLimiter, (req, res) => {
    try {
      const { clientId, clientSecret, popupOrigin, sourceAccountId } = req.body;
      if (!clientId || !clientSecret) {
        throw new Error('Client ID or Client Secret is missing.');
      }

      pruneExpiredOauthStates(oauthStore);
      const client = new TwitterApi({ clientId, clientSecret });
      const redirectUri = getOauthRedirectUri(req, 'x');
      
      const { url, codeVerifier, state } = client.generateOAuth2AuthLink(redirectUri, { scope: ['tweet.read', 'users.read', 'follows.read', 'offline.access'] });
      
      oauthStore.set(state, {
        codeVerifier,
        state,
        clientId,
        clientSecret,
        popupOrigin: normalizePopupOrigin(popupOrigin),
        sourceAccountId: trimMaybeString(sourceAccountId) || null,
        createdAt: Date.now()
      });
      res.json({ url });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get(['/auth/x/callback', '/auth/x/callback/'], syncRateLimiter, async (req, res) => {
    const { state, code } = req.query;
    const store = typeof state === 'string' ? getOauthStateEntry(oauthStore, state) : null;

    if (!store || !state || !code) {
      return res.status(400).send('Invalid state or code');
    }

    try {
      const client = new TwitterApi({ clientId: store.clientId, clientSecret: store.clientSecret });
      const redirectUri = getOauthRedirectUri(req, 'x');
      const postMessageOrigin = store.popupOrigin || getAppOrigin(req);
      
      const { accessToken, refreshToken } = await client.loginWithOAuth2({
        code: code as string,
        codeVerifier: store.codeVerifier,
        redirectUri
      });

      oauthStore.delete(state as string);

      if (store.sourceAccountId) {
        storeSourceAccountAuth(store.sourceAccountId, {
          accessToken,
          refreshToken: refreshToken || undefined,
          clientId: store.clientId,
          clientSecret: store.clientSecret
        });
      }

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage(
                  ${serializeForInlineScript({ type: 'OAUTH_AUTH_SUCCESS_X', sourceAccountId: store.sourceAccountId })},
                  ${serializeForInlineScript(postMessageOrigin)}
                );
                window.close();
              } else {
                window.location.href = ${serializeForInlineScript(postMessageOrigin)};
              }
            </script>
            <p>Authentication successful. This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (e: any) {
      oauthStore.delete(state as string);
      res.status(500).json({ error: e.message || 'X OAuth error' });
    }
  });

  const googleOauthStore = new Map<string, OAuthStateEntry>();

  app.post('/api/auth/google/url', syncRateLimiter, async (req, res) => {
    try {
      const { clientId, clientSecret, popupOrigin, sourceAccountId } = req.body;
      if (!clientId || !clientSecret) {
        throw new Error('Client ID or Client Secret is missing.');
      }
      pruneExpiredOauthStates(googleOauthStore);
      const { OAuth2Client } = await import('google-auth-library');
      const redirectUri = getOauthRedirectUri(req, 'google');
      const client = new OAuth2Client(clientId, clientSecret, redirectUri);
      const state = uuidv4();
      
      const url = client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/contacts.readonly'],
        state
      });
      
      googleOauthStore.set(state, {
        clientId,
        clientSecret,
        popupOrigin: normalizePopupOrigin(popupOrigin),
        sourceAccountId: trimMaybeString(sourceAccountId) || null,
        createdAt: Date.now()
      });
      res.json({ url });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get(['/auth/google/callback', '/auth/google/callback/'], syncRateLimiter, async (req, res) => {
    const { state, code } = req.query;
    const store = typeof state === 'string' ? getOauthStateEntry(googleOauthStore, state) : null;

    if (!store || !state || !code) {
      return res.status(400).send('Invalid state or code');
    }

    try {
      const { OAuth2Client } = await import('google-auth-library');
      const redirectUri = getOauthRedirectUri(req, 'google');
      const client = new OAuth2Client(store.clientId, store.clientSecret, redirectUri);
      const { tokens } = await client.getToken(code as string);
      const postMessageOrigin = store.popupOrigin || getAppOrigin(req);
      googleOauthStore.delete(state as string);

      if (store.sourceAccountId) {
        storeSourceAccountAuth(store.sourceAccountId, {
          tokens: tokens as Record<string, unknown>,
          clientId: store.clientId,
          clientSecret: store.clientSecret
        });
      }

      res.send(`
        <html>
          <body>
            <script>
              if (window.opener) {
                window.opener.postMessage(
                  ${serializeForInlineScript({ type: 'OAUTH_AUTH_SUCCESS_GOOGLE', sourceAccountId: store.sourceAccountId })},
                  ${serializeForInlineScript(postMessageOrigin)}
                );
                window.close();
              } else {
                window.location.href = ${serializeForInlineScript(postMessageOrigin)};
              }
            </script>
            <p>Authentication successful. This window should close automatically.</p>
          </body>
        </html>
      `);
    } catch (e: any) {
      googleOauthStore.delete(state as string);
      res.status(500).json({ error: e.message || 'Google OAuth error' });
    }
  });

  app.post("/api/sync/x", syncRateLimiter, async (req, res) => {
    const { sourceAccountId, accessToken: rawAccessToken } = req.body;
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
      const demoData = await loadDemoFixture<{
        followersResponse?: { data?: any[] },
        followingResponse?: { data?: any[] }
      }>('x');
      const storedAuth = rawAccessToken ? null : getStoredSourceAccountAuth(sourceAccountId).authData;
      const accessToken = trimMaybeString(rawAccessToken) || trimMaybeString(storedAuth?.accessToken);

      if (!accessToken) {
        throw new Error('An X access token is required. Please reconnect your X account.');
      }

      if (demoData) {
        stream.progress('Loading demo data...');
        followers = demoData.followersResponse?.data || [];
        follows = demoData.followingResponse?.data || [];
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

      const allProfilesMap = new Map<string, SyncedRelationProfile>();

      const processProfile = (p: any, relation: string) => {
        const existing = allProfilesMap.get(p.id);
        allProfilesMap.set(p.id, {
          sourceProfileId: p.id,
          handle: p.username,
          displayName: p.name || p.username,
          avatarUrl: p.profile_image_url,
          bio: p.description,
          rawJson: JSON.stringify(p),
          relations: appendUniqueRelation(existing?.relations, relation),
        });
      };

      stream.progress('Processing profiles...');
      followers.forEach(p => processProfile(p, 'followed_by'));
      follows.forEach(p => processProfile(p, 'follows'));

      let insertedCount = 0;
      let updatedCount = 0;
      const staleProfileIds = clearSourceRelationships(sourceAccountId);

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
      
      cleanupOrphanedProfiles(staleProfileIds);
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
        const connectionsRes = await fetch(
          `https://api.linkedin.com/v2/connections?q=viewer&start=0&count=100&projection=${encodeURIComponent(LINKEDIN_CONNECTIONS_PROJECTION)}`,
          {
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
      const staleProfileIds = clearSourceRelationships(sourceAccountId);

      stream.progress('Merging duplicates in database...');
      for (const p of elements) {
        const profile = p['to~'] || p;
        const sourceProfileId =
          profile.id ||
          (typeof p.to === 'string' ? p.to.replace(/^urn:li:person:/, '') : null) ||
          p.entityUrn?.replace('urn:li:fs_miniProfile:', '') ||
          p.id ||
          uuidv4();
        const firstName = getLinkedInLocalizedText(profile.firstName);
        const lastName = getLinkedInLocalizedText(profile.lastName);
        const displayName = `${firstName} ${lastName}`.trim() || 'LinkedIn User';
        const avatarUrl = getLinkedInProfilePictureUrl(profile.profilePicture);
        const profileHandle = profile.publicIdentifier || sourceProfileId;
        const bio = getLinkedInLocalizedText(profile.headline);

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
      
      cleanupOrphanedProfiles(staleProfileIds);
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

      const demoData = await loadDemoFixture<{
        followersResponse?: any[],
        followingResponse?: any[]
      }>('github');
      let followers: any[] = [];
      let following: any[] = [];

      if (demoData) {
        stream.progress('Loading demo data...');
        followers = demoData.followersResponse || [];
        following = demoData.followingResponse || [];
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
      const staleProfileIds = clearSourceRelationships(sourceAccountId);
      
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

      cleanupOrphanedProfiles(staleProfileIds);
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
      const demoData = await loadDemoFixture<{
        pages?: Array<{ connections?: any[] }>,
        connections?: any[]
      }>('google');
      const storedAuth = (!tokens && !clientId && !clientSecret && !token)
        ? getStoredSourceAccountAuth(sourceAccountId).authData
        : null;
      const resolvedTokens = tokens || storedAuth?.tokens;
      const resolvedClientId = trimMaybeString(clientId) || trimMaybeString(storedAuth?.clientId);
      const resolvedClientSecret = trimMaybeString(clientSecret) || trimMaybeString(storedAuth?.clientSecret);
      const resolvedToken = trimMaybeString(token) || trimMaybeString(storedAuth?.accessToken);

      if (!resolvedTokens && !resolvedToken) {
        throw new Error('A Google access token is required. Please reconnect Google Contacts.');
      }

      if (demoData) {
        stream.progress('Loading demo data...');
        allConnections = demoData.pages
          ? demoData.pages.flatMap((page) => page.connections || [])
          : demoData.connections || [];
      } else {
        const { OAuth2Client } = await import('google-auth-library');
        let authClient: any;
        if (resolvedClientId && resolvedClientSecret && resolvedTokens) {
          authClient = new OAuth2Client(resolvedClientId, resolvedClientSecret);
          authClient.setCredentials(resolvedTokens);
        } else {
          authClient = new OAuth2Client();
          authClient.setCredentials({ access_token: resolvedToken });
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
      const staleProfileIds = clearSourceRelationships(sourceAccountId);

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

      cleanupOrphanedProfiles(staleProfileIds);
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
    const source = trimMaybeString(req.body?.source).toLowerCase();
    const displayName = trimMaybeString(req.body?.displayName);
    const headline = trimMaybeString(req.body?.headline);
    const handle = normalizeProfileHandle(req.body?.handle);
    const profileUrl = trimMaybeString(req.body?.profileUrl);

    if (!MANUAL_CAPTURE_SOURCES.has(source)) {
      return res.status(400).json({ error: 'Unsupported manual capture source.' });
    }

    if (!displayName && !handle) {
      return res.status(400).json({ error: 'A display name or handle is required.' });
    }

    let normalizedProfileUrl: string | null = null;
    if (profileUrl) {
      try {
        const parsedProfileUrl = new URL(profileUrl);
        if (parsedProfileUrl.protocol !== 'https:' && parsedProfileUrl.protocol !== 'http:') {
          throw new Error('Unsupported protocol');
        }

        const profileHostname = parsedProfileUrl.hostname.toLowerCase();
        const sourceHostIsValid = (source === 'linkedin' && /(^|\.)linkedin\.com$/.test(profileHostname))
          || (source === 'x' && (/(^|\.)x\.com$/.test(profileHostname) || /(^|\.)twitter\.com$/.test(profileHostname)))
          || (source === 'xing' && /(^|\.)xing\.com$/.test(profileHostname))
          || (source === 'bluesky' && profileHostname === 'bsky.app');
        if (!sourceHostIsValid) {
          return res.status(400).json({ error: 'Profile URL host does not match the selected source.' });
        }

        normalizedProfileUrl = parsedProfileUrl.toString();
      } catch {
        return res.status(400).json({ error: 'Profile URL must be a valid absolute URL.' });
      }
    }

    const sourceProfileId = normalizeManualCaptureSourceProfileId(source, handle, normalizedProfileUrl);
    if (!sourceProfileId) {
      return res.status(400).json({ error: 'A handle or profile URL is required.' });
    }

    const now = new Date();

    try {
      const captureResult = db.transaction(() => {
        const existingProfile = db.select().from(schema.socialProfiles)
          .where(and(
            eq(schema.socialProfiles.sourceType, source),
            eq(schema.socialProfiles.sourceProfileId, sourceProfileId)
          ))
          .get();

        const socialProfileId = existingProfile?.id || uuidv4();

        if (existingProfile) {
          db.update(schema.socialProfiles)
            .set({
              handle: handle || existingProfile.handle,
              displayName: displayName || existingProfile.displayName,
              profileUrl: normalizedProfileUrl || existingProfile.profileUrl,
              bio: headline || existingProfile.bio,
              rawPublicPayloadJson: JSON.stringify(req.body),
              lastSeenAt: now
            })
            .where(eq(schema.socialProfiles.id, socialProfileId))
            .run();
        } else {
          db.insert(schema.socialProfiles).values({
            id: socialProfileId,
            sourceType: source,
            sourceProfileId,
            handle: handle || null,
            displayName: displayName || handle,
            profileUrl: normalizedProfileUrl,
            bio: headline || null,
            rawPublicPayloadJson: JSON.stringify(req.body),
            firstSeenAt: now,
            lastSeenAt: now,
          }).run();
        }

        assignProfileToCandidate(socialProfileId, displayName || handle, handle, now);

        const candidateProfile = db.select().from(schema.contactCandidateProfiles)
          .where(eq(schema.contactCandidateProfiles.socialProfileId, socialProfileId))
          .get();

        if (!candidateProfile?.contactCandidateId) {
          throw new Error('Failed to assign captured profile to a candidate.');
        }

        const candidate = db.select().from(schema.contactCandidates)
          .where(eq(schema.contactCandidates.id, candidateProfile.contactCandidateId))
          .get();

        if (!candidate) {
          throw new Error('Failed to load the captured candidate.');
        }

        return {
          id: candidate.id,
          status: candidate.status || 'pending'
        };
      });

      res.json({ success: true, ...captureResult });
    } catch (e: any) {
      console.error("Failed to capture profile:", e);
      res.status(500).json({ error: e.message || 'Failed to capture profile' });
    }
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
