# Release Checklist

Use this checklist to produce a repeatable, versioned Agent Factory release.

## 1) Choose release version

- pick a semantic version tag (example: `v0.2.0`)
- use the same tag for container image and deployment manifests

## 2) Build and validate

```bash
npm install
npm run check
npm run demo
```

Optional server-mode validation:

```bash
npm run create-demo-fixture
npm run intake-api
```

In another terminal:

```bash
WORKER_METRICS_PORT=9090 PATH="$(pwd)/.work/demo-fixture/bin:$PATH" npm run worker -- --source .work/demo-fixture
```

## 3) Build and publish image

Example (adjust for your registry flow):

```bash
docker build -t ghcr.io/speedscale/agent-factory:v0.2.0 .
docker push ghcr.io/speedscale/agent-factory:v0.2.0
```

## 4) Pin deployment version

### Docker compose

```bash
AGENT_FACTORY_IMAGE=ghcr.io/speedscale/agent-factory:v0.2.0 docker compose -f docker-compose.server.yml up -d
```

### Kubernetes (kustomize)

Set image tag:

```bash
kubectl kustomize examples/deploy/kubernetes/base >/dev/null
```

Then update `examples/deploy/kubernetes/base/kustomization.yaml` `images.newTag` to release tag.

Deploy:

```bash
kubectl apply -k examples/deploy/kubernetes/base
```

## 5) Post-deploy checks

- intake health: `GET /healthz`
- run API: `GET /runs`
- metrics: `GET /metrics`
- one successful demo run and `result.json` produced

## 6) Docs and branch hygiene

- ensure docs match release behavior (`README`, runbooks, plan)
- confirm merged PR branches are auto-deleted
- prune local refs and delete stale locals:

```bash
git fetch --prune origin
git branch --merged main
```
