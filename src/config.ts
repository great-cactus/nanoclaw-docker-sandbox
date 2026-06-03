import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
/**
 * Maximum time a freshly-spawned container may run without producing any
 * streaming output before we declare it stuck and kill it. Apple Container
 * occasionally drops a VM into a half-dead state where the wrapper hangs
 * indefinitely; without this watchdog the queue would block on it for the
 * full CONTAINER_TIMEOUT (30 min default).
 */
export const CONTAINER_STARTUP_TIMEOUT = parseInt(
  process.env.CONTAINER_STARTUP_TIMEOUT || '120000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
/**
 * Maximum on-disk size of a group's Claude Code session transcript (JSONL)
 * before we rotate it. The orchestrator resumes the stored session on every
 * spawn, and Claude Code reads the whole transcript to do so — auto-compaction
 * bounds the model context but NOT this file, which grows unbounded. Past a few
 * MB the resume can exceed CONTAINER_STARTUP_TIMEOUT, so every spawn hangs and
 * is killed with "No output before startup timeout". Rotation archives the
 * bloated transcript and starts a fresh session (durable memory in the group's
 * CLAUDE.md is unaffected). 8MB leaves comfortable headroom under the 120s
 * startup budget while preserving long conversational continuity.
 */
export const SESSION_TRANSCRIPT_MAX_BYTES = parseInt(
  process.env.SESSION_TRANSCRIPT_MAX_BYTES || '8388608',
  10,
); // 8MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
/**
 * Minimum gap between consecutive container spawns. Apple Container's runtime
 * hangs in the "Starting container" phase if many VM creates fire concurrently
 * (typical when several overdue cron tasks all dispatch at startup); the queue
 * staggers spawns by this much. 0 disables staggering.
 */
export const CONTAINER_SPAWN_STAGGER_MS = Math.max(
  0,
  parseInt(process.env.CONTAINER_SPAWN_STAGGER_MS || '5000', 10) || 0,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
