import { describe, it, expect } from 'vitest';

import {
  convIpcFolder,
  convSessionKey,
  ipcFolderToGroupFolder,
  makeConvKey,
  splitConvKey,
} from './conversation.js';

describe('makeConvKey / splitConvKey', () => {
  it('returns the bare JID when there is no thread', () => {
    expect(makeConvKey('tg:-100123')).toBe('tg:-100123');
    expect(makeConvKey('tg:-100123', null)).toBe('tg:-100123');
    expect(makeConvKey('tg:-100123', undefined)).toBe('tg:-100123');
  });

  it('appends the thread id for topic conversations', () => {
    expect(makeConvKey('tg:-100123', '5')).toBe('tg:-100123#5');
  });

  it('round-trips through splitConvKey', () => {
    expect(splitConvKey(makeConvKey('tg:-100123', '5'))).toEqual({
      chatJid: 'tg:-100123',
      threadId: '5',
    });
    expect(splitConvKey('tg:-100123')).toEqual({ chatJid: 'tg:-100123' });
  });

  it('handles WhatsApp-style JIDs unchanged', () => {
    expect(splitConvKey('12345@g.us')).toEqual({ chatJid: '12345@g.us' });
  });
});

describe('convIpcFolder / convSessionKey', () => {
  it('uses the group folder for non-topic conversations', () => {
    expect(convIpcFolder('telegram_agents')).toBe('telegram_agents');
    expect(convSessionKey('telegram_agents')).toBe('telegram_agents');
  });

  it('namespaces topic conversations', () => {
    expect(convIpcFolder('telegram_agents', '5')).toBe('telegram_agents--t5');
    expect(convSessionKey('telegram_agents', '5')).toBe('telegram_agents--t5');
  });
});

describe('ipcFolderToGroupFolder', () => {
  it('strips the topic suffix', () => {
    expect(ipcFolderToGroupFolder('telegram_agents--t5')).toBe(
      'telegram_agents',
    );
  });

  it('leaves plain folders untouched', () => {
    expect(ipcFolderToGroupFolder('telegram_agents')).toBe('telegram_agents');
    // "--t" without digits is not a topic suffix
    expect(ipcFolderToGroupFolder('my--test')).toBe('my--test');
  });
});
