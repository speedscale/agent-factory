FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git make openjdk-17-jdk-headless \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Run as the built-in `node` user (UID 1000) so the chart's
# securityContext.runAsNonRoot:true default is satisfied. /app is chowned so
# the runtime can read its own files; PVC mounts at /app/artifacts and
# /app/.work need fsGroup=1000 on the pod spec to be writable.
RUN chown -R node:node /app
USER node

EXPOSE 8080
CMD ["node", "dist/bin/intake-api.js"]
