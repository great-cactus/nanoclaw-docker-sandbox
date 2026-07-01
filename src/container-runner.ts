/**
 * Container Runner for NanoClaw
 * Spawns agent execution in containers and handles IPC.
 *
 * Liveness/timeout decisions live in ContainerLifecycle (container-lifecycle.ts);
 * this module spawns the process, streams and parses its output, and executes
 * the lifecycle's verdicts (kill / graceful idle wind-down).
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_STARTUP_TIMEOUT,
  CONTAINER_TIMEOUT,
  FIRST_OUTPUT_TIMEOUT,
  IDLE_TIMEOUT,
} from './config.js';
import { ContainerLifecycle, KillReason } from './container-lifecycle.js';
import { buildContainerArgs, buildVolumeMounts } from './container-mounts.js';
import {
  containerRunSpawn,
  killRuntimeByUuid,
  stopContainer,
} from './container-runtime.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Guest liveness signature: agent-runner logs prefixed with this prove the VM
// booted and the guest process is alive (host-side runtime noise doesn't).
const GUEST_OUTPUT_SIGNATURE = '[agent-runner]';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface RunAgentOptions {
  /** Inactivity window after the last result before onIdle fires. */
  idleMs?: number;
  /** Graceful wind-down request (typically wired to queue.closeStdin). */
  onIdle?: () => void;
}

// Kill log messages. container-watchdog.sh greps these to detect stuck-spawn
// storms — keep the strings in sync with the script's patterns.
const KILL_LOG_MESSAGES: Record<KillReason, string> = {
  'first-output-timeout':
    'No guest output before first-output timeout — killing wedged VM',
  'startup-silence': 'No output for startup timeout — killing stuck container',
  'hard-timeout': 'Container timeout, stopping gracefully',
};

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput: (output: ContainerOutput) => Promise<void>,
  options: RunAgentOptions = {},
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, input.isMain);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      isMain: input.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Write input to a file in the IPC directory so the container can read it
  // without needing stdin piping (Apple Container crashes with SIGTRAP when
  // spawned from Node.js with piped stdio and -i flag).
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  const inputFile = path.join(groupIpcDir, 'input', 'prompt.json');
  fs.writeFileSync(inputFile, JSON.stringify(input));

  const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;

  return new Promise((resolve) => {
    const { cmd: spawnCmd, args: spawnArgs } = containerRunSpawn(containerArgs);
    const container = spawn(spawnCmd, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    const lifecycle = new ContainerLifecycle({
      firstOutputMs: FIRST_OUTPUT_TIMEOUT,
      startupSilenceMs: CONTAINER_STARTUP_TIMEOUT,
      hardTimeoutMs: configTimeout,
      idleMs: options.idleMs ?? IDLE_TIMEOUT,
      onKill: (reason) => {
        logger.error(
          { group: group.name, containerName, reason },
          KILL_LOG_MESSAGES[reason],
        );
        try {
          stopContainer(containerName);
        } catch (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed',
          );
        }
        // Always kill the spawned process to ensure the close event fires.
        // Apple Container's `container stop` stops the VM but does not cause
        // the `container run` client process to exit on its own.
        container.kill('SIGKILL');
        // Apple Container can leave the per-VM container-runtime-linux process
        // alive after `container stop`. If those orphans accumulate, the
        // apiserver wedges with XPC connection errors and every subsequent
        // bootstrap fails. Reap this container's runtime after a short grace
        // period so the next retry has a clean apiserver to talk to.
        const reapTimer = setTimeout(() => {
          try {
            killRuntimeByUuid(containerName);
          } catch (err) {
            logger.warn(
              { group: group.name, containerName, err },
              'Post-timeout runtime reap failed',
            );
          }
        }, 5_000);
        reapTimer.unref();
      },
      onIdle: () => {
        logger.debug(
          { group: group.name, containerName },
          'Idle timeout, requesting graceful container close',
        );
        options.onIdle?.();
      },
    });

    container.stdout.on('data', (data) => {
      const chunk = data.toString();
      lifecycle.onOutput(chunk.includes(GUEST_OUTPUT_SIGNATURE));

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      parseBuffer += chunk;
      let startIdx: number;
      while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
        const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
        if (endIdx === -1) break; // Incomplete pair, wait for more data

        const jsonStr = parseBuffer
          .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
          .trim();
        parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

        try {
          const parsed: ContainerOutput = JSON.parse(jsonStr);
          if (parsed.newSessionId) {
            newSessionId = parsed.newSessionId;
          }
          // The only event that resets the hard deadline (and arms idle).
          lifecycle.onResult();
          // Call onOutput for all markers (including null results)
          // so idle timers start even for "silent" query completions.
          outputChain = outputChain.then(() => onOutput(parsed));
        } catch (err) {
          logger.warn(
            { group: group.name, error: err },
            'Failed to parse streamed output chunk',
          );
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      // SDK debug logs stream here continuously while the agent works —
      // exactly the liveness signal the booting inactivity net needs. The
      // hard deadline is unaffected (it only resets on result markers).
      lifecycle.onOutput(chunk.includes(GUEST_OUTPUT_SIGNATURE));

      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    container.on('close', (code) => {
      const killed = lifecycle.killReason !== null;
      lifecycle.dispose();
      const duration = Date.now() - startTime;

      if (killed) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Kill Reason: ${lifecycle.killReason}`,
            `Had Result: ${lifecycle.hadResult}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (lifecycle.hadResult) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain
            .then(() => {
              resolve({
                status: 'success',
                result: null,
                newSessionId,
              });
            })
            .catch((err) => {
              logger.error(
                { group: group.name, containerName, err },
                'Output chain error after timeout — releasing queue lock',
              );
              resolve({ status: 'error', result: null, error: String(err) });
            });
          return;
        }

        logger.error(
          {
            group: group.name,
            containerName,
            duration,
            code,
            reason: lifecycle.killReason,
          },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms (${lifecycle.killReason})`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        // On error, log input metadata only — not the full prompt.
        // Full input is only included at verbose level to avoid
        // persisting user conversation content on every non-zero exit.
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Wait for the output chain to settle, then return a completion marker.
      outputChain
        .then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        })
        .catch((err) => {
          logger.error(
            { group: group.name, containerName, err },
            'Output chain error — releasing queue lock',
          );
          resolve({ status: 'error', result: null, error: String(err) });
        });
    });

    container.on('error', (err) => {
      lifecycle.dispose();
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
