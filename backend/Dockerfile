FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# package.json requis par certains modules (pino, etc.)
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/dist         ./dist
COPY --from=builder /app/node_modules ./node_modules

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
