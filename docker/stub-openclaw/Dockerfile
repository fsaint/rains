FROM node:20-alpine

WORKDIR /app

# No npm install needed — pure Node.js built-ins only
COPY server.js .

EXPOSE 18789

HEALTHCHECK --interval=5s --timeout=3s --start-period=2s --retries=3 \
  CMD wget -qO- http://localhost:18789/healthz || exit 1

CMD ["node", "server.js"]
