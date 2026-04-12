# Build stage — compile TypeScript to JavaScript
FROM node:25-alpine AS builder
WORKDIR /app

# Install root devDependencies (type definitions needed for compilation)
COPY package*.json ./
RUN npm ci

# Install agent dependencies
COPY agent/package*.json ./agent/
RUN cd agent && npm ci

COPY tsconfig.json ./
COPY shared/ ./shared/
COPY agent/src/ ./agent/src/
COPY agent/tsconfig.build.json ./agent/
RUN cd agent && npx tsc -p tsconfig.build.json

# Production stage — no tsx, no devDependencies, no type packages
FROM node:25-alpine
WORKDIR /app

COPY agent/package*.json ./agent/
RUN cd agent && npm ci --omit=dev

COPY --from=builder /app/agent/dist/ ./agent/dist/

ARG INSIGHTD_VERSION=dev
ENV NODE_OPTIONS="--max-old-space-size=40"
ENV NODE_ENV=production
ENV INSIGHTD_VERSION=$INSIGHTD_VERSION

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const fs=require('fs');try{const s=fs.statSync('/tmp/insightd-healthy');process.exit(Date.now()-s.mtimeMs<600000?0:1)}catch{process.exit(1)}"

CMD ["node", "agent/dist/agent/src/index.js"]
