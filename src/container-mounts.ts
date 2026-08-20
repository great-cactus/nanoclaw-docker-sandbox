/**
 * Container mount and argument construction for NanoClaw.
 * Pure data-building: no process spawning or lifecycle concerns.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_CPUS,
  CONTAINER_IMAGE,
  CONTAINER_MEMORY,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  TIMEZONE,
} from './config.js';
import {
  CONTAINER_HOST_GATEWAY,
  hostGatewayArgs,
  readonlyMountArgs,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { validateAdditionalMounts } from './mount-security.js';
import { RegisteredGroup } from './types.js';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export function buildVolumeMounts(
  group: RegisteredGroup,
  isMain: boolean,
  ipcFolder: string = group.folder,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);

  // NanoClaw application logs (read-only for all groups)
  const logsDir = path.join(projectRoot, 'logs');
  if (fs.existsSync(logsDir)) {
    mounts.push({
      hostPath: logsDir,
      containerPath: '/workspace/logs',
      readonly: true,
    });
  }

  if (isMain) {
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // .env shadowing is handled inside the container entrypoint via mount --bind
    // (Apple Container only supports directory mounts, not file mounts like /dev/null)

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            // Enable agent swarms (subagent orchestration)
            // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            // Load CLAUDE.md from additional mounted directories
            // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            // Enable Claude's memory feature (persists user preferences between sessions)
            // https://code.claude.com/docs/en/memory#manage-auto-memory
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
            // Default 32000 aborts long single responses (big derivations,
            // large file writes) with an API error mid-task
            CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Sync subagent definitions from container/agents/ into each group's
  // .claude/agents/ (e.g. the Haiku "scribe" for cheap mechanical work)
  const agentsSrc = path.join(process.cwd(), 'container', 'agents');
  const agentsDst = path.join(groupSessionsDir, 'agents');
  if (fs.existsSync(agentsSrc)) {
    fs.mkdirSync(agentsDst, { recursive: true });
    for (const agentFile of fs.readdirSync(agentsSrc)) {
      if (!agentFile.endsWith('.md')) continue;
      fs.copyFileSync(
        path.join(agentsSrc, agentFile),
        path.join(agentsDst, agentFile),
      );
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Gmail credentials directory (for Gmail MCP inside the container)
  const homeDir = os.homedir();
  const gmailDir = path.join(homeDir, '.gmail-mcp');
  if (fs.existsSync(gmailDir)) {
    mounts.push({
      hostPath: gmailDir,
      containerPath: '/home/node/.gmail-mcp',
      readonly: false, // MCP may need to refresh OAuth tokens
    });
  }

  // Per-conversation IPC namespace: each group — and each forum topic within
  // a group — gets its own IPC directory. This prevents cross-group privilege
  // escalation via IPC, and keeps concurrent topic containers of the same
  // group from consuming each other's input files and close sentinels.
  const groupIpcDir = resolveGroupIpcPath(ipcFolder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Copy agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    'agent-runner-src',
  );
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index.ts');
    const cachedIndex = path.join(groupAgentRunnerDir, 'index.ts');
    const needsCopy =
      !fs.existsSync(groupAgentRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      (fs.existsSync(srcIndex) &&
        fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs);
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

export function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
): string[] {
  const args: string[] = ['run', '--rm', '--name', containerName];

  // Resource limits. Without these the runtime defaults the VM to ~1GB, which
  // OOM-kills builds/test suites mid-task; CONTAINER_MEMORY/CONTAINER_CPUS make
  // them tunable per host. Empty strings leave the runtime default in place.
  if (CONTAINER_MEMORY) {
    args.push('--memory', CONTAINER_MEMORY);
  }
  if (CONTAINER_CPUS) {
    args.push('--cpus', CONTAINER_CPUS);
  }

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Forward proxy and CA settings so containers can reach external services
  const caCertEnvVars = [
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'REQUESTS_CA_BUNDLE',
  ];
  for (const envVar of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    ...caCertEnvVars,
  ]) {
    if (process.env[envVar]) {
      if (caCertEnvVars.includes(envVar)) {
        args.push('-e', `${envVar}=/workspace/ca-cert/proxy-ca.crt`);
      } else if (envVar === 'NO_PROXY' || envVar === 'no_proxy') {
        // Add the host gateway to NO_PROXY so the credential proxy
        // (ANTHROPIC_BASE_URL) isn't routed through the HTTPS proxy
        const val = process.env[envVar];
        const extra = val
          ? `${val},${CONTAINER_HOST_GATEWAY}`
          : CONTAINER_HOST_GATEWAY;
        args.push('-e', `${envVar}=${extra}`);
      } else {
        args.push('-e', `${envVar}=${process.env[envVar]}`);
      }
    }
  }

  // Mount CA certificate into container if NODE_EXTRA_CA_CERTS is set.
  // Docker may reject mounts from restricted host paths, so we copy the cert
  // into the project's data directory and mount from there.
  const hostCaCert =
    process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE;
  if (hostCaCert && fs.existsSync(hostCaCert)) {
    const caCertDir = path.join(DATA_DIR, 'ca-cert');
    const caCertDst = path.join(caCertDir, 'proxy-ca.crt');
    fs.mkdirSync(caCertDir, { recursive: true });
    fs.copyFileSync(hostCaCert, caCertDst);
    mounts.push({
      hostPath: caCertDir,
      containerPath: '/workspace/ca-cert',
      readonly: true,
    });
  }

  // Route API traffic through the credential proxy (containers never see real secrets)
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // Mirror the host's auth method with a placeholder value.
  // API key mode: SDK sends x-api-key, proxy replaces with real key.
  // OAuth mode:   SDK exchanges placeholder token for temp API key,
  //               proxy injects real OAuth token on that exchange request.
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // Runtime-specific args for host gateway resolution
  args.push(...hostGatewayArgs());

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    if (isMain) {
      // Main containers start as root so the entrypoint can mount --bind
      // to shadow .env. Privileges are dropped via setpriv in entrypoint.sh.
      args.push('-e', `RUN_UID=${hostUid}`);
      args.push('-e', `RUN_GID=${hostGid}`);
    } else {
      args.push('--user', `${hostUid}:${hostGid}`);
    }
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}
