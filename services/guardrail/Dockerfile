FROM node:20-alpine

RUN apk add --no-cache wget openssl curl jq bash && \
    addgroup -g 1001 nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy all files (matching pattern of working services)
COPY package*.json ./
COPY tsconfig.json ./
COPY packages/shared ./packages/shared
COPY services/guardrail ./services/guardrail

# Install only guardrail and shared dependencies (exclude apps/* to avoid native deps)
RUN npm install --workspace=packages/shared --workspace=services/guardrail --include-workspace-root && \
    cd /app/packages/shared && npm run build && \
    cd /app/services/guardrail && \
    npm run build && \
    cd /app && \
    npm prune --production

# Set ownership
RUN chown -R nodejs:nodejs /app

USER nodejs

ENV NODE_ENV=production
ENV GUARDRAIL_PORT=4002

WORKDIR /app/services/guardrail

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.GUARDRAIL_PORT||4002)+'/health/ready').then(r=>r.ok||process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]