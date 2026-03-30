# Build stage — compile better-sqlite3 native addon
FROM node:20-alpine AS builder
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

# Production stage
FROM node:20-alpine
WORKDIR /app

# Copy compiled node_modules and source
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

# Data directory for SQLite
RUN mkdir -p /data

# Memory limit
ENV NODE_OPTIONS="--max-old-space-size=40"

VOLUME ["/data"]

CMD ["node", "src/index.js"]
