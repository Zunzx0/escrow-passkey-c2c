FROM node:22-bookworm-slim AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

FROM base AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM base AS backend-build
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npx prisma generate && npm run build

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=backend-build /app/backend/package.json /app/backend/package-lock.json ./
COPY --from=backend-build /app/backend/node_modules ./node_modules
COPY --from=backend-build /app/backend/dist ./dist
COPY --from=backend-build /app/backend/prisma ./prisma
COPY --from=frontend-build /app/frontend/dist ./public

EXPOSE 10000
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed && node dist/server.js"]
