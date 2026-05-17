import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const sourceAccounts = sqliteTable('source_accounts', {
  id: text('id').primaryKey(),
  sourceType: text('source_type').notNull(),
  accountIdentifier: text('account_identifier'),
  displayName: text('display_name'),
  authStatus: text('auth_status'),
  authData: text('auth_data'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
});

export const sourceAccountSecrets = sqliteTable('source_account_secrets', {
  sourceAccountId: text('source_account_id').primaryKey().references(() => sourceAccounts.id),
  encryptedPayload: text('encrypted_payload').notNull(),
  encryptionVersion: integer('encryption_version').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
});

export const socialProfiles = sqliteTable('social_profiles', {
  id: text('id').primaryKey(),
  sourceType: text('source_type').notNull(),
  sourceProfileId: text('source_profile_id'),
  handle: text('handle'),
  displayName: text('display_name'),
  profileUrl: text('profile_url'),
  avatarUrl: text('avatar_url'),
  bio: text('bio'),
  rawPublicPayloadJson: text('raw_public_payload_json'),
  firstSeenAt: integer('first_seen_at', { mode: 'timestamp' }),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' })
});

export const relationshipEdges = sqliteTable('relationship_edges', {
  id: text('id').primaryKey(),
  sourceAccountId: text('source_account_id').references(() => sourceAccounts.id),
  socialProfileId: text('social_profile_id').references(() => socialProfiles.id),
  relationType: text('relation_type'),
  observedAt: integer('observed_at', { mode: 'timestamp' }),
  syncJobId: text('sync_job_id')
});

export const contactCandidates = sqliteTable('contact_candidates', {
  id: text('id').primaryKey(),
  canonicalName: text('canonical_name'),
  confidenceScore: integer('confidence_score'),
  status: text('status'),
  notes: text('notes'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
});

export const contactCandidateProfiles = sqliteTable('contact_candidate_profiles', {
  contactCandidateId: text('contact_candidate_id').references(() => contactCandidates.id),
  socialProfileId: text('social_profile_id').references(() => socialProfiles.id)
});

export const candidateMatchEvidence = sqliteTable('candidate_match_evidence', {
  id: text('id').primaryKey(),
  candidateId: text('candidate_id').references(() => contactCandidates.id),
  profileId: text('profile_id').references(() => socialProfiles.id),
  evidenceType: text('evidence_type').notNull(),
  evidenceValue: text('evidence_value'),
  score: integer('score').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
});

export const syncJobs = sqliteTable('sync_jobs', {
  id: text('id').primaryKey(),
  sourceAccountId: text('source_account_id').references(() => sourceAccounts.id),
  status: text('status'),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
  errorCode: text('error_code'),
  errorMessageSafe: text('error_message_safe')
});

export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
});
