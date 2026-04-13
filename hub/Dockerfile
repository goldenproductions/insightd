# Frontend build stage
FROM node:25-alpine AS frontend
WORKDIR /app
COPY hub/src/web/frontend/package*.json ./hub/src/web/frontend/
RUN cd hub/src/web/frontend && npm ci
COPY hub/src/web/frontend/ ./hub/src/web/frontend/
RUN cd hub/src/web/frontend && npm run build

# Backend build stage — compile better-sqlite3 native addon
FROM node:25-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY hub/package*.json ./hub/
RUN cd hub && npm ci --only=production

# Production stage
FROM node:25-alpine
WORKDIR /app

COPY --from=builder /app/hub/node_modules ./hub/node_modules
COPY hub/package*.json ./hub/
COPY hub/src/ ./hub/src/
COPY shared/ ./shared/
COPY src/ ./src/
COPY tsconfig.json ./

# Copy built frontend assets (overwrites source public/ files)
COPY --from=frontend /app/hub/src/web/public/ ./hub/src/web/public/

ARG INSIGHTD_VERSION=dev
ENV INSIGHTD_VERSION=$INSIGHTD_VERSION

RUN mkdir -p /data

ENV NODE_OPTIONS="--max-old-space-size=256"

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200?0:1))})"

CMD ["npx", "tsx", "hub/src/index.ts"]
