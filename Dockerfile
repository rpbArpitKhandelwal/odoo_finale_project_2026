# DealFlow360 — API + built React client in one image (works on Render, Railway, Fly.io, any Docker host)
FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package.json ./
RUN npm install --no-audit --no-fund
COPY client/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY src ./src
COPY docs ./docs
COPY --from=client /app/client/dist ./client/dist
EXPOSE 4300
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://localhost:${PORT:-4300}/api/health || exit 1
CMD ["node", "server.js"]
