# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Accept proxy build args and configure npm to work through MITM proxies
ARG http_proxy
ARG https_proxy
ARG no_proxy
ARG NODE_EXTRA_CA_CERTS

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Pre-populate known_hosts for common Git hosts so first-time SSH does not prompt.
RUN mkdir -p /etc/ssh && \
    ssh-keyscan -t rsa,ecdsa,ed25519 github.com gitlab.com bitbucket.org \
        >> /etc/ssh/ssh_known_hosts 2>/dev/null || true

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Disable strict SSL during build to handle MITM proxy certs
ARG npm_config_strict_ssl=true
RUN npm config set strict-ssl ${npm_config_strict_ssl}

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Re-enable strict SSL for runtime
RUN npm config set strict-ssl true

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
# Apple Container only supports directory mounts (VirtioFS), so .env cannot be
# shadowed with a host-side /dev/null file mount. Instead the entrypoint starts
# as root, uses mount --bind to shadow .env, then drops to the host user via setpriv.
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Note: do NOT set `USER node` here. Main-group containers run as root so the
# entrypoint can `mount --bind /dev/null /workspace/project/.env` to shadow
# secrets, then drop privileges via setpriv. Non-main containers receive
# `--user $UID:$GID` from the host.

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
