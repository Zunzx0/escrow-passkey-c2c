FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY cho-an-tam/package.json cho-an-tam/package-lock.json ./
RUN npm ci --omit=dev

COPY cho-an-tam/public ./public
COPY cho-an-tam/src ./src
COPY cho-an-tam/scripts ./scripts

RUN mkdir -p /app/data

EXPOSE 10000
CMD ["npm", "start"]
