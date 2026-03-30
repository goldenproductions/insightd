# Build stage — compile better-sqlite3 native addon
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY hub/package*.json ./hub/
RUN cd hub && npm ci --only=production

# Production stage
FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/hub/node_modules ./hub/node_modules
COPY hub/package*.json ./hub/
COPY hub/src/ ./hub/src/
COPY shared/ ./shared/
COPY src/ ./src/

RUN mkdir -p /data

ENV NODE_OPTIONS="--max-old-space-size=40"

VOLUME ["/data"]

CMD ["node", "hub/src/index.js"]
