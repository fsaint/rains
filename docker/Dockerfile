FROM ghcr.io/openclaw/openclaw:2026.3.13-1

# Switch to root to install browser dependencies
USER root

# Install Chromium via Playwright into the node user's cache
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
    chown -R node:node /home/node/.cache

# Install openclaw-mcp-bridge plugin into OpenClaw's plugin directory
RUN mkdir -p /home/node/.openclaw/plugins/openclaw-mcp-bridge && \
    cd /home/node/.openclaw/plugins/openclaw-mcp-bridge && \
    npm init -y > /dev/null 2>&1 && \
    npm install openclaw-mcp-bridge@0.2.0 && \
    chown -R node:node /home/node/.openclaw

# Fix missing plugin runtime module (packaging gap in main image)
RUN mkdir -p /app/dist/plugins/runtime
COPY plugin-runtime-shim.mjs /app/dist/plugins/runtime/index.js

# Copy entrypoint, auth helper, and workspace templates
COPY entrypoint.sh /entrypoint.sh
COPY write-codex-auth.js /write-codex-auth.js
COPY workspace/ /workspace-template/
RUN chmod +x /entrypoint.sh && chown -R node:node /workspace-template

# Switch back to non-root user
USER node

ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

EXPOSE 18789

ENTRYPOINT ["/entrypoint.sh"]
