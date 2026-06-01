FROM ghcr.io/openclaw/openclaw:2026.5.27

# Switch to root to install browser dependencies
USER root

# Install Xvfb (virtual framebuffer) and font packages for headless browser rendering
ARG EXTRA_FONT_PACKAGES=""
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xfonts-base \
    xfonts-75dpi \
    xfonts-100dpi \
    fonts-liberation \
    fonts-noto-color-emoji \
    dbus-x11 \
    python3 \
    python3-pip \
    nodejs \
    npm \
    gettext-base \
    && if [ -n "${EXTRA_FONT_PACKAGES}" ]; then apt-get install -y --no-install-recommends ${EXTRA_FONT_PACKAGES}; fi \
    && rm -rf /var/lib/apt/lists/*

# Install Chromium via Playwright into the node user's cache
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN node /app/node_modules/playwright-core/cli.js install --with-deps chromium && \
    chown -R node:node /home/node/.cache

# Install openclaw-mcp-bridge into openclaw's stock extensions directory so it is auto-discovered.
# Copy the plugin and its @sinclair/typebox dependency into a self-contained directory.
# The openclaw peer dep resolves via Node.js module lookup from /app/node_modules (if needed).
COPY openclaw-mcp-bridge-0.3.5.tgz /tmp/openclaw-mcp-bridge-0.3.5.tgz
RUN mkdir -p /tmp/mcp-bridge-build && \
    cd /tmp/mcp-bridge-build && \
    npm init -y > /dev/null 2>&1 && \
    npm install /tmp/openclaw-mcp-bridge-0.3.5.tgz && \
    cp -r /tmp/mcp-bridge-build/node_modules/openclaw-mcp-bridge \
        /app/dist/extensions/openclaw-mcp-bridge && \
    mkdir -p /app/dist/extensions/openclaw-mcp-bridge/node_modules && \
    cp -r /tmp/mcp-bridge-build/node_modules/@sinclair \
        /app/dist/extensions/openclaw-mcp-bridge/node_modules/ && \
    cp -r /tmp/mcp-bridge-build/node_modules/openclaw \
        /app/dist/extensions/openclaw-mcp-bridge/node_modules/ && \
    rm -rf /tmp/mcp-bridge-build && \
    chown -R node:node /app/dist/extensions/openclaw-mcp-bridge
# Patch dist/index.js:
# 1. Add id so the plugin is recognized (openclaw reads module.default.id at load time).
# 2. Add synchronous tool registration from entrypoint-written cache — openclaw drops
#    api.registerTool() calls made after register() returns (async .then() is too late).
COPY patch-plugin.js /tmp/patch-plugin.js
RUN node /tmp/patch-plugin.js
# Patch openclaw loader to bypass contracts.tools requirement for extension plugins.
# openclaw 2026.5.27 rejects api.registerTool() calls from plugins that don't declare
# contracts.tools in their manifest. The mcp-bridge registers dynamic tools (names depend
# on the MCP server's tool list), so it cannot declare them statically.
COPY patch-loader.js /tmp/patch-loader.js
RUN node /tmp/patch-loader.js

# Pre-install reins-thread-prompt at build time to avoid the 4-minute cold-boot
# npm install that was causing health check failures and restart loops.
COPY reins-thread-prompt-0.3.1.tgz /tmp/reins-thread-prompt-0.3.1.tgz
RUN mkdir -p /home/node/.openclaw/plugins/reins-thread-prompt && \
    cd /home/node/.openclaw/plugins/reins-thread-prompt && \
    npm init -y > /dev/null 2>&1 && \
    npm install --no-fund --no-audit /tmp/reins-thread-prompt-0.3.1.tgz && \
    chown -R node:node /home/node/.openclaw

# Fix missing plugin runtime module (packaging gap in main image)
RUN mkdir -p /app/dist/plugins/runtime
COPY plugin-runtime-shim.mjs /app/dist/plugins/runtime/index.js

# Copy entrypoint, auth helper, workspace templates, and Chromium wrapper
COPY entrypoint.sh /entrypoint.sh
COPY chromium-wrapper.sh /usr/local/bin/chromium-wrapper
COPY write-codex-auth.js /write-codex-auth.js
COPY workspace/ /workspace-template/

# Bundle skills: Reins platform knowledge + inbox distillation
RUN mkdir -p /app/skills/reins /app/skills/inbox-distillation
COPY skills/reins/SKILL.md /app/skills/reins/SKILL.md
COPY skills/inbox-distillation/SKILL.md /app/skills/inbox-distillation/SKILL.md
RUN chmod +x /entrypoint.sh /usr/local/bin/chromium-wrapper && chown -R node:node /workspace-template /app/skills/reins /app/skills/inbox-distillation

# Ensure Xvfb socket directory is writable by node user
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Switch back to non-root user
USER node

ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
ENV DISPLAY=:99

# Bake the git SHA (or custom tag) into the image at build time
ARG CONTAINER_VERSION=dev
ENV CONTAINER_VERSION=${CONTAINER_VERSION}

# Virtual display resolution (can be overridden per image variant)
ARG XVFB_RESOLUTION=1280x1024x24
ENV XVFB_RESOLUTION=${XVFB_RESOLUTION}

EXPOSE 18789

ENTRYPOINT ["/entrypoint.sh"]
