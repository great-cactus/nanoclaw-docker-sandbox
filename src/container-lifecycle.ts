/**
 * Container lifecycle state machine.
 *
 * Tracks a container's liveness through explicit phases and owns every
 * timeout decision. The runner feeds it events (output seen, result parsed,
 * process exited) and executes its verdicts (kill, wind down idle).
 *
 *   SPAWNING ──guest output──▶ BOOTING ──result──▶ RESPONDING ──▶ CLOSED
 *
 * Phase deadlines (each maps to one legacy watchdog):
 * - SPAWNING: fixed `firstOutputMs` from spawn. A healthy VM emits its first
 *   "[agent-runner]" line within seconds; a half-dead VM that boots but never
 *   starts the guest agent-runner shows only host-side progress bars, so
 *   host-side output does NOT extend this deadline.
 * - BOOTING: inactivity net of `startupSilenceMs`, re-armed by ANY output
 *   (SDK debug logs on stderr count — a healthy agent is never silent for
 *   long while working toward its first result; the agent-runner heartbeat
 *   covers long quiet tool calls). Catches wedged VMs without false-killing
 *   a long first turn.
 * - All phases: a stall deadline of `hardTimeoutMs`, reset by result markers
 *   AND by real agent activity (SDK message traffic — NOT the keepalive
 *   heartbeat). A container with neither results nor activity for
 *   `hardTimeoutMs` dies.
 * - All phases: an absolute lifetime cap of `maxLifetimeMs` from spawn that
 *   nothing resets — bounds runaway agents that stay "active" forever.
 * - RESPONDING: additionally an idle deadline of `idleMs` after the last
 *   result or activity; firing it requests a graceful wind-down (close
 *   sentinel), not a kill. The hard deadline is stretched to at least
 *   `idleMs + graceMs` so the graceful close always gets a chance to run
 *   before the hard kill.
 */

export type LifecyclePhase = 'spawning' | 'booting' | 'responding' | 'closed';

export type KillReason =
  | 'first-output-timeout' // no guest output at all — wedged VM
  | 'startup-silence' // went silent before first result
  | 'hard-timeout' // no result and no activity for hardTimeoutMs
  | 'max-lifetime'; // absolute lifetime cap — runaway backstop

export interface LifecycleOptions {
  firstOutputMs: number;
  startupSilenceMs: number;
  hardTimeoutMs: number;
  idleMs: number;
  /** Minimum headroom of the hard deadline over the idle deadline. */
  graceMs?: number;
  /** Absolute lifetime cap; defaults to 3× the effective hardTimeoutMs. */
  maxLifetimeMs?: number;
  onKill: (reason: KillReason) => void;
  onIdle: () => void;
}

const DEFAULT_GRACE_MS = 30_000;

export class ContainerLifecycle {
  private phase: LifecyclePhase = 'spawning';
  private readonly opts: Required<Omit<LifecycleOptions, 'onKill' | 'onIdle'>>;
  private readonly onKill: (reason: KillReason) => void;
  private readonly onIdle: () => void;

  /** Absolute epoch-ms deadlines; null = not armed. */
  private hardDeadline: number;
  private phaseDeadline: number | null;
  private idleDeadline: number | null = null;
  /** Never reset — bounds the container's total lifetime. */
  private readonly lifetimeDeadline: number;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private killedFor: KillReason | null = null;
  private sawResult = false;

  constructor(options: LifecycleOptions) {
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    // Hard deadline must clear the idle wind-down (idle + grace) so the
    // graceful close sentinel fires before the hard kill.
    const hardTimeoutMs = Math.max(
      options.hardTimeoutMs,
      options.idleMs + graceMs,
    );
    this.opts = {
      firstOutputMs: options.firstOutputMs,
      startupSilenceMs: options.startupSilenceMs,
      hardTimeoutMs,
      idleMs: options.idleMs,
      graceMs,
      maxLifetimeMs: options.maxLifetimeMs ?? hardTimeoutMs * 3,
    };
    this.onKill = options.onKill;
    this.onIdle = options.onIdle;

    const now = Date.now();
    this.hardDeadline = now + this.opts.hardTimeoutMs;
    this.phaseDeadline = now + this.opts.firstOutputMs;
    this.lifetimeDeadline = now + this.opts.maxLifetimeMs;
    this.schedule();
  }

  get currentPhase(): LifecyclePhase {
    return this.phase;
  }

  /** True once at least one result marker was seen. */
  get hadResult(): boolean {
    return this.sawResult;
  }

  /** Set when a deadline fired; null if the container was never killed. */
  get killReason(): KillReason | null {
    return this.killedFor;
  }

  /**
   * Any stdout/stderr chunk from the container process. `isGuest` marks
   * output proving the guest agent-runner is alive (its log lines), as
   * opposed to host-side runtime noise like image-pull progress bars.
   * `isActivity` marks real agent traffic (SDK messages, tool logs) as
   * opposed to the keepalive heartbeat — activity proves progress, so it
   * stretches the stall and idle deadlines; the heartbeat only proves the
   * process is alive.
   */
  onOutput(isGuest: boolean, isActivity: boolean = isGuest): void {
    if (this.phase === 'closed') return;

    if (isActivity) {
      const now = Date.now();
      this.hardDeadline = now + this.opts.hardTimeoutMs;
      // A busy agent is not idle: keep the graceful wind-down at bay while
      // real traffic flows. Once idle has already fired, the close sentinel
      // is out — don't re-arm.
      if (this.idleDeadline !== null) {
        this.idleDeadline = now + this.opts.idleMs;
      }
    }

    if (this.phase === 'spawning' && isGuest) {
      this.phase = 'booting';
      this.phaseDeadline = Date.now() + this.opts.startupSilenceMs;
      this.schedule();
      return;
    }

    if (this.phase === 'booting') {
      // Inactivity net: any output proves liveness before the first result.
      this.phaseDeadline = Date.now() + this.opts.startupSilenceMs;
      this.schedule();
    }
  }

  /** A parsed result marker — the only event that resets the hard deadline. */
  onResult(): void {
    if (this.phase === 'closed') return;
    this.sawResult = true;
    this.phase = 'responding';
    this.phaseDeadline = null;
    const now = Date.now();
    this.hardDeadline = now + this.opts.hardTimeoutMs;
    this.idleDeadline = now + this.opts.idleMs;
    this.schedule();
  }

  /** Process exited (or spawn failed) — stop all timers. */
  dispose(): void {
    this.phase = 'closed';
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.phase === 'closed') return;

    const deadlines = [
      this.hardDeadline,
      this.phaseDeadline,
      this.idleDeadline,
      this.lifetimeDeadline,
    ].filter((d): d is number => d !== null);
    const next = Math.min(...deadlines);

    this.timer = setTimeout(() => this.fire(), Math.max(0, next - Date.now()));
    this.timer.unref?.();
  }

  private fire(): void {
    if (this.phase === 'closed') return;
    const now = Date.now();

    if (now >= this.lifetimeDeadline) {
      this.kill('max-lifetime');
      return;
    }

    if (now >= this.hardDeadline) {
      this.kill('hard-timeout');
      return;
    }

    if (this.phaseDeadline !== null && now >= this.phaseDeadline) {
      this.kill(
        this.phase === 'spawning' ? 'first-output-timeout' : 'startup-silence',
      );
      return;
    }

    if (this.idleDeadline !== null && now >= this.idleDeadline) {
      // Graceful wind-down, not a kill: request once, re-armed by the next
      // result. The container stays alive until it exits on its own or the
      // hard deadline reaps it.
      this.idleDeadline = null;
      this.schedule();
      this.onIdle();
      return;
    }

    // Timer fired early (clock drift / clamped delay) — just re-arm.
    this.schedule();
  }

  private kill(reason: KillReason): void {
    this.killedFor = reason;
    this.dispose();
    this.onKill(reason);
  }
}
