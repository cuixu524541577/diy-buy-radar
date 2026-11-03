FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
COPY api/package.json ./api/
RUN npm install --workspace=api --omit=dev=false

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/api/node_modules ./api/node_modules
COPY package.json ./
COPY api ./api
WORKDIR /app/api
RUN npx tsc -p tsconfig.json

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/api/node_modules ./api/node_modules
COPY package.json ./
COPY api/package.json ./api/
COPY --from=build /app/api/dist ./api/dist
COPY api/src/db/schema.sql ./api/dist/db/schema.sql
RUN mkdir -p /app/data/reports
WORKDIR /app/api
EXPOSE 3001
CMD ["node", "dist/index.js"]
