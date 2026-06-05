FROM node:22-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
# node:sqlite is experimental in Node 22, unflagged in Node 23+
ENV NODE_OPTIONS=--experimental-sqlite

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/scripts ./scripts

RUN mkdir -p /app/data

EXPOSE 3000
CMD ["npm", "start"]
