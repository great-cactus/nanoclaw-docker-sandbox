import './ws-proxy-patch.js'; // Must be first — patches ws before discord.js captures it
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  SESSION_TRANSCRIPT_MAX_BYTES,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureBridgeSentinel,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  clearSession,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  convIpcFolder,
  convSessionKey,
  makeConvKey,
  splitConvKey,
} from './conversation.js';
import { GroupQueue, ProcessOutcome } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;
// Per-JID count of agent-initiated IPC sends. Agents reply via IPC (not the
// result marker), so this is how processGroupMessages tells that a run already
// delivered output to the user and must not roll back / retry (which would
// re-run the task and duplicate messages).
const ipcSendCounts: Record<string, number> = {};

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a conversation (a chat, or one forum
 * topic within a chat). Called by the GroupQueue when it's this
 * conversation's turn. Reports facts (delivered/failed) back to the queue,
 * which owns the retry policy.
 */
async function processGroupMessages(convKey: string): Promise<ProcessOutcome> {
  const { chatJid, threadId } = splitConvKey(convKey);
  // Re-read from DB each time so container_config changes (e.g. mount path fixes)
  // take effect without requiring a sentinel restart.
  const group = getRegisteredGroup(chatJid) ?? registeredGroups[chatJid];
  if (!group) return { kind: 'ok' };

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return { kind: 'ok' };
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[convKey] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
    undefined,
    threadId ?? null,
  );

  if (missedMessages.length === 0) return { kind: 'ok' };

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return { kind: 'ok' };
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[convKey] || '';
  // Baseline of IPC deliveries; if it grows during the run, the agent replied
  // via IPC and we must not roll back / retry (would duplicate the work).
  const ipcCountBefore = ipcSendCounts[convKey] ?? 0;
  lastAgentTimestamp[convKey] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      threadId,
    },
    'Processing messages',
  );

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(
    group,
    prompt,
    convKey,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          await channel.sendMessage(chatJid, text, threadId);
          outputSentToUser = true;
        }
      }

      if (result.status === 'success') {
        queue.notifyIdle(convKey);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    {
      idleMs: IDLE_TIMEOUT,
      onIdle: () => queue.closeStdin(convKey),
    },
  );

  await channel.setTyping?.(chatJid, false);

  if (output === 'error' || hadError) {
    // Report facts to the queue; it decides whether to retry. "Delivered"
    // covers both the result marker and agent-initiated IPC sends during
    // this run — either way the user already got a response.
    const ipcSentDuringRun = (ipcSendCounts[convKey] ?? 0) > ipcCountBefore;
    return {
      kind: 'failed',
      delivered: outputSentToUser || ipcSentDuringRun,
      rollback: () => {
        lastAgentTimestamp[convKey] = previousCursor;
        saveState();
        logger.warn(
          { group: group.name },
          'Agent error, rolled back message cursor for retry',
        );
      },
    };
  }

  return { kind: 'ok' };
}

/**
 * Resolve the host path of a group's Claude Code session transcript (JSONL).
 * Mirrors the per-group .claude mount in container-runner.ts; inside the
 * container cwd is /workspace/group, which Claude Code slugifies to the
 * project dir "-workspace-group".
 */
function sessionTranscriptPath(groupFolder: string, sessionId: string): string {
  return path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
    'projects',
    '-workspace-group',
    `${sessionId}.jsonl`,
  );
}

/**
 * Guard against the resume-hang failure mode: if the stored session's
 * transcript has grown past SESSION_TRANSCRIPT_MAX_BYTES, archive it and clear
 * the session mapping so the next spawn starts a fresh, lightweight session.
 * Done in-process (memory map + DB) so it takes effect without a restart. The
 * group's durable memory lives in its CLAUDE.md and is untouched.
 */
function rotateSessionIfBloated(
  group: RegisteredGroup,
  sessionKey: string,
): void {
  const sessionId = sessions[sessionKey];
  if (!sessionId) return;

  // The transcript lives under the group's (shared) sessions dir regardless
  // of which topic conversation owns the session.
  const transcript = sessionTranscriptPath(group.folder, sessionId);
  let size: number;
  try {
    size = fs.statSync(transcript).size;
  } catch {
    return; // No transcript yet (or unreadable) — nothing to rotate.
  }
  if (size <= SESSION_TRANSCRIPT_MAX_BYTES) return;

  try {
    const archiveDir = path.join(DATA_DIR, 'sessions', '_archived');
    fs.mkdirSync(archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(
      archiveDir,
      `${sessionKey}-${sessionId}-${stamp}.jsonl`,
    );
    fs.renameSync(transcript, dest);
    delete sessions[sessionKey];
    clearSession(sessionKey);
    logger.warn(
      {
        group: group.name,
        sizeBytes: size,
        limitBytes: SESSION_TRANSCRIPT_MAX_BYTES,
        archivedTo: dest,
      },
      'Session transcript exceeded size limit — rotated to a fresh session',
    );
  } catch (err) {
    logger.error(
      { group: group.name, err: (err as Error).message },
      'Failed to rotate bloated session transcript',
    );
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  convKey: string,
  onOutput: (output: ContainerOutput) => Promise<void>,
  options?: import('./container-runner.js').RunAgentOptions,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const { threadId } = splitConvKey(convKey);
  // Topic conversations get their own session (isolated context) and IPC
  // namespace (isolated input files), but share the group folder (memory).
  const sessionKey = convSessionKey(group.folder, threadId);
  const ipcFolder = convIpcFolder(group.folder, threadId);
  rotateSessionIfBloated(group, sessionKey);
  const sessionId = sessions[sessionKey];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    ipcFolder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    ipcFolder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = async (output: ContainerOutput) => {
    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId);
    }
    await onOutput(output);
  };

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid: convKey,
        isMain,
        assistantName: ASSISTANT_NAME,
        model: group.containerConfig?.model,
        ipcFolder,
      },
      (proc, containerName) =>
        queue.registerProcess(convKey, proc, containerName, ipcFolder),
      wrappedOnOutput,
      options,
    );

    if (output.newSessionId) {
      sessions[sessionKey] = output.newSessionId;
      setSession(sessionKey, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by conversation (chat, or forum topic within a chat)
        const messagesByConv = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const convKey = makeConvKey(msg.chat_jid, msg.thread_id);
          const existing = messagesByConv.get(convKey);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByConv.set(convKey, [msg]);
          }
        }

        for (const [convKey, convMessages] of messagesByConv) {
          const { chatJid, threadId } = splitConvKey(convKey);
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          // requiresTrigger is stored as INTEGER (0/1) in SQLite — coerce to boolean
          const needsTrigger = !isMainGroup && !!group.requiresTrigger;

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[convKey] || '',
            ASSISTANT_NAME,
            undefined,
            threadId ?? null,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : convMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // If a container is already active for this conversation, pipe the
          // message directly regardless of trigger — it's already open.
          if (queue.sendMessage(convKey, formatted)) {
            logger.debug(
              { convKey, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[convKey] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — check trigger before launching a new one
            if (needsTrigger) {
              const allowlistCfg = loadSenderAllowlist();
              const hasTrigger = convMessages.some(
                (m) =>
                  TRIGGER_PATTERN.test(m.content.trim()) &&
                  (m.is_from_me ||
                    isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
              );
              if (!hasTrigger) continue;
            }
            queue.enqueueMessageCheck(convKey);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    // Conversations of this chat may have diverging cursors (one per forum
    // topic). Fetch from the earliest cursor, then re-check each
    // conversation's bucket against its own cursor.
    const convCursors = Object.entries(lastAgentTimestamp)
      .filter(([key]) => splitConvKey(key).chatJid === chatJid)
      .map(([, ts]) => ts)
      .sort();
    const sinceTimestamp = convCursors[0] ?? '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length === 0) continue;

    const pendingConvKeys = new Set<string>();
    for (const msg of pending) {
      const convKey = makeConvKey(msg.chat_jid, msg.thread_id);
      if (msg.timestamp > (lastAgentTimestamp[convKey] || '')) {
        pendingConvKeys.add(convKey);
      }
    }
    for (const convKey of pendingConvKeys) {
      logger.info(
        { group: group.name, convKey, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(convKey);
    }
  }
}

async function ensureContainerSystemRunning(): Promise<void> {
  await ensureContainerRuntimeRunning();
  cleanupOrphans();
  await ensureBridgeSentinel(CONTAINER_IMAGE);
}

async function main(): Promise<void> {
  await ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    // Write synchronously to stderr so it lands in nanoclaw.error.log even if pino doesn't flush
    process.stderr.write(`[UNCAUGHT EXCEPTION] ${err?.stack || err}\n`);
    logger.error({ err }, 'Uncaught exception — process will exit');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[UNHANDLED REJECTION] ${reason}\n`);
    logger.error({ reason }, 'Unhandled promise rejection');
  });

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    registerGroup,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    try {
      await channel.connect();
      channels.push(channel);
    } catch (err) {
      logger.warn(
        { channel: channelName, err },
        'Channel failed to connect — skipping. Other channels will continue.',
      );
    }
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      // Agents in topic conversations reply with their conversation key
      // (chatJid#threadId) — split it so the reply lands in the topic.
      const { chatJid, threadId } = splitConvKey(jid);
      const channel = findChannel(channels, chatJid);
      if (!channel) throw new Error(`No channel for JID: ${chatJid}`);
      await channel.sendMessage(chatJid, text, threadId);
      // Record delivery so an agent that already replied via IPC isn't retried.
      ipcSendCounts[jid] = (ipcSendCounts[jid] ?? 0) + 1;
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
