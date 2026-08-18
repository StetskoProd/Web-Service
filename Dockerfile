FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache curl

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

EXPOSE 3210

ENV PORT=3210
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV REFRESH_MS=15000
ENV SOURCE_TIMEOUT_MS=10000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3210/health || exit 1

CMD ["node", "src/server.js"]