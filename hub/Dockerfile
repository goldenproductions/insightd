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
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200?0:1))})"

CMD ["node", "hub/src/index.js"]
