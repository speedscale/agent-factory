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
  && apt-get install -y --no-install-recommends git make openjdk-17-jdk-headless python3 curl \
  && rm -rf /var/lib/apt/lists/*

# Download loki-gather.py from the canonical speedscale/demo reference architecture at a
# pinned commit so the image is reproducible. The script stays in the demos repo as the
# single source of truth; we pull it at build time rather than duplicating it here.
# nocheck — commit SHA below is a git hash, not a secret
ARG LOKI_GATHER_COMMIT=98e6f4ef742565bb09c719c0c93282eddc02850d # nocheck
RUN curl -fsSL \
    "https://raw.githubusercontent.com/speedscale/demo/${LOKI_GATHER_COMMIT}/reference-architectures/grafana/scripts/loki-gather.py" \
    -o /usr/local/bin/loki-gather \
  && chmod +x /usr/local/bin/loki-gather

ARG ES_GATHER_COMMIT=923265b74add898979d08a0566a589cccacde8b5 # nocheck
RUN curl -fsSL \
    "https://raw.githubusercontent.com/speedscale/demo/${ES_GATHER_COMMIT}/reference-architectures/elasticsearch/scripts/es-gather.py" \
    -o /usr/local/bin/es-gather \
  && chmod +x /usr/local/bin/es-gather

COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Install proxymock CLI and speedctl so the radar-monitor CronJob can create
# and pull traffic snapshots. v2.5.605 streams large snapshot artifacts to disk
# and caps the Go runtime to the cgroup, so a pull no longer OOMs the 1Gi pod on
# big windows (earlier builds buffered raw.jsonl whole in memory). To update:
# bump both ARGs and rebuild.
# nocheck — version tags, not secrets
ARG PROXYMOCK_VERSION=v2.5.605
ARG SPEEDCTL_VERSION=v2.5.605
RUN ARCH="$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" && \
    curl -fsSL \
      "https://downloads.speedscale.com/proxymock/${PROXYMOCK_VERSION}/proxymock-linux-${ARCH}" \
      -o /usr/local/bin/proxymock && \
    chmod +x /usr/local/bin/proxymock && \
    curl -fsSL \
      "https://downloads.speedscale.com/speedctl/${SPEEDCTL_VERSION}/speedctl-linux-${ARCH}" \
      -o /usr/local/bin/speedctl && \
    chmod +x /usr/local/bin/speedctl

# Run as the built-in `node` user (UID 1000) so the chart's
# securityContext.runAsNonRoot:true default is satisfied. /app is chowned so
# the runtime can read its own files; PVC mounts at /app/artifacts and
# /app/.work need fsGroup=1000 on the pod spec to be writable.
RUN chown -R node:node /app
USER node

EXPOSE 8080
EXPOSE 4317
CMD ["node", "dist/bin/intake-api.js"]
