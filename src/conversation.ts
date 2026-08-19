/**
 * Conversation identity helpers.
 *
 * A "conversation" is the unit of session/queue isolation. For normal chats it
 * is the chat JID itself; for Telegram forum topics it is `chatJid#threadId`,
 * so each topic gets its own agent session and container while sharing the
 * group's folder (memory) with every other topic in the same chat.
 */

const CONV_DELIMITER = '#';
const IPC_TOPIC_SUFFIX = /--t\d+$/;

export function makeConvKey(chatJid: string, threadId?: string | null): string {
  return threadId ? `${chatJid}${CONV_DELIMITER}${threadId}` : chatJid;
}

export function splitConvKey(convKey: string): {
  chatJid: string;
  threadId?: string;
} {
  const idx = convKey.indexOf(CONV_DELIMITER);
  if (idx === -1) return { chatJid: convKey };
  return {
    chatJid: convKey.slice(0, idx),
    threadId: convKey.slice(idx + 1) || undefined,
  };
}

/**
 * Per-conversation IPC namespace directory name. Topic conversations get
 * their own directory so concurrent containers of the same group don't
 * consume each other's input files or close sentinels. The suffix keeps the
 * name valid under GROUP_FOLDER_PATTERN.
 */
export function convIpcFolder(groupFolder: string, threadId?: string): string {
  return threadId ? `${groupFolder}--t${threadId}` : groupFolder;
}

/**
 * Per-conversation session-store key (sessions table / in-memory map).
 * Deliberately the same naming scheme as the IPC namespace.
 */
export function convSessionKey(groupFolder: string, threadId?: string): string {
  return convIpcFolder(groupFolder, threadId);
}

/**
 * Map an IPC directory name back to the group folder that owns it, so topic
 * namespaces inherit the group's identity for authorization.
 */
export function ipcFolderToGroupFolder(ipcFolder: string): string {
  return ipcFolder.replace(IPC_TOPIC_SUFFIX, '');
}
