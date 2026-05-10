import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fns so tests can configure them
const mockExecSync = vi.fn();
const mockSpawn = vi.fn(() => ({
  on: vi.fn(),
  unref: vi.fn(),
  kill: vi.fn(),
}));
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...(args as [])),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns --mount flag with type=bind and readonly', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual([
      '--mount',
      'type=bind,source=/host/path,target=/container/path,readonly',
    ]);
  });
});

describe('stopContainer', () => {
  it('spawns container stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockSpawn).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', 'nanoclaw-test-123'],
      expect.objectContaining({ stdio: 'ignore', detached: true }),
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} system status`,
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('auto-starts when system status fails', () => {
    // First call (system status) fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
    // Second call (system start) succeeds
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} system start`,
      { stdio: 'pipe', timeout: 30000 },
    );
    expect(logger.info).toHaveBeenCalledWith('Container runtime started');
  });

  it('throws when both status and start fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('failed');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers from JSON output', () => {
    // Apple Container ls returns JSON
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-group1-111' } },
      { status: 'stopped', configuration: { id: 'nanoclaw-group2-222' } },
      { status: 'running', configuration: { id: 'nanoclaw-group3-333' } },
      { status: 'running', configuration: { id: 'other-container' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    // Second execSync call is the ps scan for ghost processes — return empty
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    // ls + ps = 2 execSync calls; the stop calls go through spawn
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      CONTAINER_RUNTIME_BIN,
      ['stop', 'nanoclaw-group1-111'],
      expect.objectContaining({ stdio: 'ignore', detached: true }),
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      CONTAINER_RUNTIME_BIN,
      ['stop', 'nanoclaw-group3-333'],
      expect.objectContaining({ stdio: 'ignore', detached: true }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group3-333'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('[]');
    mockExecSync.mockReturnValueOnce(''); // ps scan: no processes
    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ls fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-a-1' } },
      { status: 'running', configuration: { id: 'nanoclaw-b-2' } },
    ]);
    mockExecSync.mockReturnValueOnce(lsOutput);
    mockExecSync.mockReturnValueOnce(''); // ps scan
    // First spawn throws synchronously to simulate spawn-time failure
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });

  it('kills ghost runtime processes whose uuid the apiserver no longer tracks', () => {
    const lsOutput = JSON.stringify([
      { status: 'running', configuration: { id: 'nanoclaw-known-1' } },
    ]);
    // ps -ax output: known container, ghost, bridge sentinel, unrelated process
    const psOutput = [
      '  100 /usr/local/libexec/container/plugins/container-runtime-linux/bin/container-runtime-linux start --root /x --uuid nanoclaw-known-1',
      '  200 /usr/local/libexec/container/plugins/container-runtime-linux/bin/container-runtime-linux start --root /y --uuid nanoclaw-ghost-2',
      '  300 /usr/local/libexec/container/plugins/container-runtime-linux/bin/container-runtime-linux start --root /z --uuid nanoclaw-bridge-sentinel',
      '  400 /usr/bin/some-other-process --uuid nanoclaw-unrelated',
      '  500 /usr/local/libexec/container/plugins/container-runtime-linux/bin/container-runtime-linux start --root /w --uuid other-prefix-xyz',
    ].join('\n');
    mockExecSync.mockReturnValueOnce(lsOutput);
    mockExecSync.mockReturnValueOnce(psOutput);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    cleanupOrphans();

    // Only the ghost (PID 200) should be signalled — known/sentinel/non-runtime are skipped
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(200, 'SIGTERM');
    expect(logger.warn).toHaveBeenCalledWith(
      { count: 1, ghosts: ['nanoclaw-ghost-2'] },
      'Killed ghost container-runtime-linux processes (apiserver no longer tracks them)',
    );
    killSpy.mockRestore();
  });

  it('treats apiserver-known containers in any state as not-ghost', () => {
    // Stopped container with a still-alive runtime process is the apiserver's
    // problem to reap, not ours — we must not kill it.
    const lsOutput = JSON.stringify([
      { status: 'stopped', configuration: { id: 'nanoclaw-stopping-9' } },
    ]);
    const psOutput =
      '  900 /usr/local/libexec/container/plugins/container-runtime-linux/bin/container-runtime-linux start --root /x --uuid nanoclaw-stopping-9';
    mockExecSync.mockReturnValueOnce(lsOutput);
    mockExecSync.mockReturnValueOnce(psOutput);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    cleanupOrphans();

    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});
