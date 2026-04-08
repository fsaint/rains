FROM ghcr.io/openclaw/openclaw:2026.3.13-1

# Switch to root to install browser dependencies
USER root

# Install Xvfb (virtual framebuffer) and font packages for headless browser rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xfonts-base \
    xfonts-75dpi \
    xfonts-100dpi \
    fonts-liberation \
    fonts-noto-color-emoji \
    python3 \
    python3-pip \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install Chromium via Playwright into the node user's cache
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
    chown -R node:node /home/node/.cache

# Install openclaw-mcp-bridge plugin into OpenClaw's plugin directory
RUN mkdir -p /home/node/.openclaw/plugins/openclaw-mcp-bridge && \
    cd /home/node/.openclaw/plugins/openclaw-mcp-bridge && \
    npm init -y > /dev/null 2>&1 && \
    npm install openclaw-mcp-bridge@0.3.1 && \
    chown -R node:node /home/node/.openclaw

# Fix missing plugin runtime module (packaging gap in main image)
RUN mkdir -p /app/dist/plugins/runtime
COPY plugin-runtime-shim.mjs /app/dist/plugins/runtime/index.js

# Copy entrypoint, auth helper, and workspace templates
COPY entrypoint.sh /entrypoint.sh
COPY write-codex-auth.js /write-codex-auth.js
COPY workspace/ /workspace-template/
RUN chmod +x /entrypoint.sh && chown -R node:node /workspace-template

# Ensure Xvfb socket directory is writable by node user
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Switch back to non-root user
USER node

ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
ENV DISPLAY=:99

# Bake the git SHA (or custom tag) into the image at build time
ARG CONTAINER_VERSION=dev
ENV CONTAINER_VERSION=${CONTAINER_VERSION}

EXPOSE 18789

ENTRYPOINT ["/entrypoint.sh"]
