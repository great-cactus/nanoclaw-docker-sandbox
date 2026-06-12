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
/**
 * Memory allocated to each agent container. Apple Container (and Docker)
 * default an unconstrained VM to ~1GB, which is far too small for builds,
 * test suites, or any large-scale dev work — the guest OOM-kills node/tsc
 * mid-task and the spawn dies with no useful output.
 *
 * This is a dedicated NanoClaw host (24GB RAM / 12 CPU). Do NOT hand almost
 * all RAM to the VM: Apple Container reserves the full --memory amount up front
 * for the guest, and macOS + the orchestrator + the apiserver daemon + the
 * always-on bridge-sentinel container + virtualization overhead need real
 * headroom. Allocating 18GB on this box drove the host to ~13% free with heavy
 * swapping, so VMs booted half-dead and every spawn died at the 120s
 * "no output" timeout (and the few that survived took minutes to respond).
 * 8GB leaves ~16GB for the host and still dwarfs the ~1GB default that was
 * OOM-killing builds. NOTE: this is a PER-container limit and groups can run
 * containers concurrently — keep it well under host RAM so two heavy agents at
 * once don't oversubscribe. Accepts the runtime's size syntax (e.g. "8g",
 * "2048m"); empty string leaves the limit unset.
 */
export const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY ?? '8g';
/**
 * CPUs allocated to each agent container. Dedicated host has 12 cores; 8 keeps
 * the agent fast while leaving cores for the host, orchestrator, and a second
 * concurrent group. Empty string leaves the runtime's own default in place.
 */
export const CONTAINER_CPUS = process.env.CONTAINER_CPUS ?? '8';
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
/**
 * Maximum time we wait for the guest agent-runner to emit ANY output (its
 * "[agent-runner]" log lines, on stdout or stderr) before declaring the VM
 * wedged and killing it. Apple Container intermittently boots a half-dead VM
 * that prints the host-side progress bars and then goes silent forever — the
 * guest node process never starts. A healthy VM emits its first "[agent-runner]"
 * line within ~3-5s (well before the model produces any result), so this short
 * window catches wedged VMs ~6x faster than CONTAINER_STARTUP_TIMEOUT without
 * risking a false kill of a healthy-but-slow first turn (which may take 30s+ to
 * produce its first result marker).
 */
export const FIRST_OUTPUT_TIMEOUT = parseInt(
  process.env.FIRST_OUTPUT_TIMEOUT || '20000',
  10,
); // 20s default
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
