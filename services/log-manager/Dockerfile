FROM node:20-alpine

RUN apk add --no-cache wget openssl curl jq bash && \
    addgroup -g 1001 nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy all files
COPY package*.json ./
COPY tsconfig.json ./
COPY packages/shared ./packages/shared
COPY services/log-manager ./services/log-manager

# Install only log-manager and shared dependencies (exclude apps/* to avoid native deps)
RUN npm install --workspace=packages/shared --workspace=services/log-manager --include-workspace-root && \
    cd /app/packages/shared && npm run build && \
    cd /app/services/log-manager && \
    npm run build

USER nodejs

EXPOSE 4001

ENV NODE_ENV=production

WORKDIR /app/services/log-manager

CMD ["node", "dist/services/log-manager/src/index.js"]