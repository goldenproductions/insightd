FROM node:20-alpine
WORKDIR /app

COPY agent/package*.json ./agent/
RUN cd agent && npm ci --only=production

COPY shared/ ./shared/
COPY agent/src/ ./agent/src/
COPY tsconfig.json ./

ARG INSIGHTD_VERSION=dev
ENV NODE_OPTIONS="--max-old-space-size=40"
ENV INSIGHTD_VERSION=$INSIGHTD_VERSION

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const fs=require('fs');try{const s=fs.statSync('/tmp/insightd-healthy');process.exit(Date.now()-s.mtimeMs<600000?0:1)}catch{process.exit(1)}"

CMD ["npx", "tsx", "agent/src/index.ts"]
