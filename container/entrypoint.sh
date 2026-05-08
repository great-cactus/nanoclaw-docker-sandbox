#!/bin/bash
set -e

# Shadow .env so the agent cannot read host secrets (requires root)
# Apple Container VirtioFS does not support file bind mounts; ignore failure.
if [ "$(id -u)" = "0" ] && [ -f /workspace/project/.env ]; then
  mount --bind /dev/null /workspace/project/.env 2>/dev/null || true
fi

# Compile agent-runner
rm -rf /tmp/dist
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Input is written to a file by the host (avoids stdin pipe issue with Apple Container)
INPUT_FILE=/workspace/ipc/input/prompt.json
if [ ! -f "$INPUT_FILE" ]; then
  echo "ERROR: Input file not found: $INPUT_FILE" >&2
  exit 1
fi

# Main-group setup that must run as root before privileges are dropped.
if [ "$(id -u)" = "0" ] && [ -n "$RUN_UID" ]; then
  # Host UIDs (e.g. 501 on macOS) are not in the image's /etc/passwd.
  # SSH and other getpwuid() consumers fail without an entry, so add one.
  if ! getent passwd "$RUN_UID" >/dev/null 2>&1; then
    echo "agent:x:$RUN_UID:$RUN_GID::/home/node:/bin/bash" >> /etc/passwd
  fi

  # Copy SSH keys from the group folder into a private ~/.ssh.
  # Bind-mounted keys often have group/world-read perms which SSH rejects.
  if [ -f /workspace/group/id_ed25519 ]; then
    mkdir -p /home/node/.ssh
    cp /workspace/group/id_ed25519 /home/node/.ssh/id_ed25519
    if [ -f /workspace/group/id_ed25519.pub ]; then
      cp /workspace/group/id_ed25519.pub /home/node/.ssh/id_ed25519.pub
    fi
    chmod 700 /home/node/.ssh
    chmod 600 /home/node/.ssh/id_ed25519
    chown -R "$RUN_UID:$RUN_GID" /home/node/.ssh
  fi

  chown "$RUN_UID:$RUN_GID" /tmp/dist
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups -- node /tmp/dist/index.js < "$INPUT_FILE"
fi

exec node /tmp/dist/index.js < "$INPUT_FILE"
