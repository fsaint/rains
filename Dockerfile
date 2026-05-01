FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY shared/package.json shared/
COPY servers/package.json servers/
COPY backend/package.json backend/
COPY frontend/package.json frontend/

RUN npm ci

COPY shared/ shared/
COPY servers/ servers/
COPY backend/ backend/
COPY frontend/ frontend/
COPY templates/ templates/

RUN npm run build --workspace=shared
RUN npm run build --workspace=servers
RUN npm run build --workspace=backend
RUN npm run build --workspace=frontend

# --- Production image ---
FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY servers/package.json servers/
COPY backend/package.json backend/

RUN npm ci --omit=dev

COPY --from=builder /app/shared/dist shared/dist
COPY --from=builder /app/servers/dist servers/dist
COPY --from=builder /app/backend/dist backend/dist
COPY --from=builder /app/frontend/dist frontend/dist
COPY templates/ templates/

WORKDIR /app/backend
EXPOSE 5001
CMD ["node", "dist/index.js"]
