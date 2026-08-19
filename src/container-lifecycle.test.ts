import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { ContainerLifecycle, KillReason } from './container-lifecycle.js';

const FIRST_OUTPUT_MS = 20_000;
const STARTUP_SILENCE_MS = 120_000;
const HARD_TIMEOUT_MS = 1_800_000;
const IDLE_MS = 1_800_000;
const GRACE_MS = 30_000;

function createLifecycle(overrides: Partial<{ idleMs: number }> = {}) {
  const kills: KillReason[] = [];
  const idles: number[] = [];
  const lc = new ContainerLifecycle({
    firstOutputMs: FIRST_OUTPUT_MS,
    startupSilenceMs: STARTUP_SILENCE_MS,
    hardTimeoutMs: HARD_TIMEOUT_MS,
    idleMs: overrides.idleMs ?? IDLE_MS,
    graceMs: GRACE_MS,
    onKill: (reason) => kills.push(reason),
    onIdle: () => idles.push(Date.now()),
  });
  return { lc, kills, idles };
}

describe('ContainerLifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('kills a VM that never produces guest output at the first-output deadline', () => {
    const { lc, kills } = createLifecycle();
    vi.advanceTimersByTime(FIRST_OUTPUT_MS);
    expect(kills).toEqual(['first-output-timeout']);
    expect(lc.currentPhase).toBe('closed');
  });

  it('host-side output does not extend the first-output deadline', () => {
    const { kills } = createLifecycle();
    // Host progress bars every 5s, but the guest never comes up.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(5_000);
      // isGuest=false — image pull noise, not agent-runner output
    }
    expect(kills).toEqual(['first-output-timeout']);
  });

  it('guest output moves to booting and disarms the first-output deadline', () => {
    const { lc, kills } = createLifecycle();
    vi.advanceTimersByTime(5_000);
    lc.onOutput(true);
    expect(lc.currentPhase).toBe('booting');
    vi.advanceTimersByTime(FIRST_OUTPUT_MS);
    expect(kills).toEqual([]);
  });

  it('kills a booting container that goes silent before its first result', () => {
    const { lc, kills } = createLifecycle();
    lc.onOutput(true);
    vi.advanceTimersByTime(STARTUP_SILENCE_MS);
    expect(kills).toEqual(['startup-silence']);
  });

  it('any output re-arms the booting inactivity net (long first turn survives)', () => {
    const { lc, kills } = createLifecycle();
    lc.onOutput(true);
    // SDK debug logs every 60s for 10 minutes — never silent long enough.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(60_000);
      lc.onOutput(false);
    }
    expect(kills).toEqual([]);
    expect(lc.currentPhase).toBe('booting');
  });

  it('continuous activity without any result dies at the lifetime cap, not the hard deadline', () => {
    const { lc, kills } = createLifecycle();
    lc.onOutput(true);
    // Effective hard = max(hard, idle+grace); lifetime cap defaults to 3×.
    const effectiveHard = Math.max(HARD_TIMEOUT_MS, IDLE_MS + GRACE_MS);
    const maxLifetime = effectiveHard * 3;
    const steps = Math.ceil(maxLifetime / 60_000) + 1;
    for (let i = 0; i < steps; i++) {
      vi.advanceTimersByTime(60_000);
      lc.onOutput(true); // activity keeps stretching the hard deadline
    }
    expect(kills).toEqual(['max-lifetime']);
    expect(lc.hadResult).toBe(false);
  });

  it('heartbeat-only output does not stretch the hard deadline', () => {
    const { lc, kills } = createLifecycle();
    lc.onOutput(true); // first guest output → booting
    lc.onResult(); // → responding, hard deadline re-armed
    const steps = Math.ceil(HARD_TIMEOUT_MS / 60_000) + 1;
    for (let i = 0; i < steps; i++) {
      vi.advanceTimersByTime(60_000);
      lc.onOutput(true, false); // heartbeat: alive but no progress
    }
    expect(kills).toEqual(['hard-timeout']);
  });

  it('activity stretches the idle deadline so a busy agent is not wound down', () => {
    const { lc, idles } = createLifecycle({ idleMs: 600_000 });
    lc.onOutput(true);
    lc.onResult();
    // Active tool-looping for 3× the idle window — never idle.
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(300_000);
      lc.onOutput(true, true);
    }
    expect(idles).toHaveLength(0);
    // Real quiet (heartbeat only) → idle fires after idleMs.
    vi.advanceTimersByTime(300_000);
    lc.onOutput(true, false);
    vi.advanceTimersByTime(300_000);
    expect(idles).toHaveLength(1);
  });

  it('a result moves to responding and re-arms the hard deadline', () => {
    const { lc, kills } = createLifecycle();
    lc.onOutput(true);
    vi.advanceTimersByTime(60_000);
    lc.onResult();
    expect(lc.currentPhase).toBe('responding');
    expect(lc.hadResult).toBe(true);
    // Hard deadline now runs from the result, not from spawn.
    vi.advanceTimersByTime(HARD_TIMEOUT_MS - 60_000);
    expect(kills).toEqual([]);
  });

  it('fires onIdle once after idleMs of no results, then hard-kills later', () => {
    const { lc, kills, idles } = createLifecycle({ idleMs: 600_000 });
    lc.onOutput(true);
    lc.onResult();
    vi.advanceTimersByTime(600_000);
    expect(idles).toHaveLength(1);
    expect(kills).toEqual([]);
    // No further results: hard deadline (max(hard, idle+grace)) reaps it.
    vi.advanceTimersByTime(HARD_TIMEOUT_MS - 600_000);
    expect(kills).toEqual(['hard-timeout']);
    expect(lc.hadResult).toBe(true);
  });

  it('a new result re-arms the idle deadline', () => {
    const { lc, idles } = createLifecycle({ idleMs: 600_000 });
    lc.onOutput(true);
    lc.onResult();
    vi.advanceTimersByTime(300_000);
    lc.onResult();
    vi.advanceTimersByTime(300_000);
    expect(idles).toHaveLength(0); // idle clock restarted at second result
    vi.advanceTimersByTime(300_000);
    expect(idles).toHaveLength(1);
  });

  it('stretches the hard deadline to idleMs + graceMs so graceful close wins', () => {
    const { kills, idles, lc } = createLifecycle({ idleMs: HARD_TIMEOUT_MS });
    lc.onOutput(true);
    lc.onResult();
    // idle == configured hard timeout; effective hard = idle + grace.
    vi.advanceTimersByTime(HARD_TIMEOUT_MS);
    expect(idles).toHaveLength(1);
    expect(kills).toEqual([]);
    vi.advanceTimersByTime(GRACE_MS);
    expect(kills).toEqual(['hard-timeout']);
  });

  it('dispose stops all deadlines', () => {
    const { lc, kills, idles } = createLifecycle();
    lc.onOutput(true);
    lc.onResult();
    lc.dispose();
    vi.advanceTimersByTime(HARD_TIMEOUT_MS * 2);
    expect(kills).toEqual([]);
    expect(idles).toHaveLength(0);
    expect(lc.currentPhase).toBe('closed');
  });

  it('events after close are ignored', () => {
    const { lc, kills } = createLifecycle();
    vi.advanceTimersByTime(FIRST_OUTPUT_MS);
    expect(kills).toEqual(['first-output-timeout']);
    lc.onOutput(true);
    lc.onResult();
    expect(lc.currentPhase).toBe('closed');
    expect(lc.hadResult).toBe(false);
  });
});
