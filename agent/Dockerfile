FROM node:20-alpine
WORKDIR /app

COPY agent/package*.json ./
RUN npm ci --only=production

COPY shared/ ./shared/
COPY agent/src/ ./agent/src/

ENV NODE_OPTIONS="--max-old-space-size=40"

CMD ["node", "agent/src/index.js"]
