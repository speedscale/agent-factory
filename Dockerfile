FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 8080
CMD ["node", "dist/bin/intake-api.js"]
