/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync, spawn } from 'child_process';
import os from 'os';

import { logger } from './logger.js';

const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Name of the long-running container we keep alive solely so Apple Container's
 * bridge100 interface stays up. Without at least one running container, the
 * bridge tears down and the credential proxy cannot bind to 192.168.64.1.
 */
export const BRIDGE_SENTINEL_NAME = 'nanoclaw-bridge-sentinel';
const BRIDGE_READY_TIMEOUT_MS = 30_000;
const BRIDGE_POLL_INTERVAL_MS = 200;

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/**
 * Returns the spawn command and args for `container run`.
 * Apple Container's CLI crashes with SIGTRAP when spawned from Node.js without
 * a controlling terminal (stdout is a pipe). We wrap with `script -q /dev/null`
 * to allocate a PTY so the CLI behaves as if it has a terminal.
 */
export function containerRunSpawn(runArgs: string[]): {
  cmd: string;
  args: string[];
} {
  return {
    cmd: 'script',
    args: ['-q', '/dev/null', CONTAINER_RUNTIME_BIN, ...runArgs],
  };
}

/**
 * IP address containers use to reach the host machine.
 * Apple Container VMs use a bridge network (192.168.64.x); the host is at the gateway.
 * Detected from the bridge0 interface, falling back to 192.168.64.1.
 */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

function detectHostGateway(): string {
  // Apple Container on macOS: containers reach the host via the bridge network gateway
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'] || ifaces['bridge0'];
  if (bridge) {
    const ipv4 = bridge.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  // Fallback: Apple Container's default gateway
  return '192.168.64.1';
}

/**
 * Address the credential proxy binds to.
 * Apple Container's bridge100 interface only exists while containers are running,
 * but the proxy must start before any container. Override via CREDENTIAL_PROXY_HOST
 * in .env if the default gateway differs.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || '192.168.64.1';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // Apple Container resolves host networking through the bridge gateway directly.
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/**
 * Stop a container by name. Validates name to avoid shell injection.
 *
 * Apple Container's `container stop` can hang indefinitely against VMs
 * that are in a half-dead daemon state. We spawn it non-blocking and
 * rely on a hard kill timer so a stuck `container stop` never freezes
 * the orchestrator's Node event loop (which would stall every channel).
 */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  const child = spawn(CONTAINER_RUNTIME_BIN, ['stop', name], {
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (err) => {
    logger.warn({ name, err }, 'container stop spawn error');
  });
  const killTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }, COMMAND_TIMEOUT_MS);
  killTimer.unref();
  child.unref();
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, {
      stdio: 'pipe',
      timeout: COMMAND_TIMEOUT_MS,
    });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      console.error(
        '║  1. Ensure Apple Container is installed                        ║',
      );
      console.error(
        '║  2. Run: container system start                                ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }
}

function isBridgeUp(): boolean {
  const ifaces = os.networkInterfaces();
  const bridge = ifaces['bridge100'];
  if (!bridge) return false;
  return bridge.some((a) => a.family === 'IPv4');
}

async function waitForBridge(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isBridgeUp()) return true;
    await new Promise((r) => setTimeout(r, BRIDGE_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Spawn a long-running sleep container so Apple Container's bridge100
 * interface stays up. The credential proxy must bind to 192.168.64.1, but
 * that address only exists while at least one container runs. Without this
 * sentinel, a clean restart fails with EADDRNOTAVAIL the moment all real
 * containers exit. The sentinel is detached, named, and `cleanupOrphans`
 * skips it so it survives orchestrator restarts.
 */
export async function ensureBridgeSentinel(image: string): Promise<void> {
  if (isBridgeUp()) {
    logger.debug('bridge100 already up — skipping sentinel');
    return;
  }
  logger.info({ name: BRIDGE_SENTINEL_NAME }, 'Spawning bridge sentinel');
  const child = spawn(
    'script',
    [
      '-q',
      '/dev/null',
      CONTAINER_RUNTIME_BIN,
      'run',
      '--rm',
      '--detach',
      '--name',
      BRIDGE_SENTINEL_NAME,
      '--memory',
      '256m',
      '--entrypoint',
      '/bin/sleep',
      image,
      'infinity',
    ],
    { stdio: 'ignore', detached: true },
  );
  child.on('error', (err) => {
    logger.error({ err }, 'Failed to spawn bridge sentinel');
  });
  child.unref();
  const ready = await waitForBridge(BRIDGE_READY_TIMEOUT_MS);
  if (!ready) {
    throw new Error(
      `bridge100 did not come up within ${BRIDGE_READY_TIMEOUT_MS}ms — sentinel may have failed to start`,
    );
  }
  logger.info('bridge100 is up');
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: COMMAND_TIMEOUT_MS,
    });
    const containers: { status: string; configuration: { id: string } }[] =
      JSON.parse(output || '[]');
    const orphans = containers
      .filter(
        (c) =>
          c.status === 'running' &&
          c.configuration.id.startsWith('nanoclaw-') &&
          c.configuration.id !== BRIDGE_SENTINEL_NAME,
      )
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
