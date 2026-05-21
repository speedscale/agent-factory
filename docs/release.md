# Release Checklist

Audience: Agent Factory developers/release maintainers.

Use this checklist to produce a repeatable, versioned Agent Factory release.

## 1) Choose release version

- pick a semantic version tag (example: `v0.2.0`)
- use the same tag for the Helm chart `appVersion` and any published artifacts

## 2) Build and validate

```bash
npm install
npm run check
npm test
```

## 3) Helm chart

Bump `charts/agent-factory/Chart.yaml` `appVersion` (and `version` per semver rules), then dry-run:

```bash
helm lint ./charts/agent-factory
helm template ./charts/agent-factory \
  --values ./examples/instances/internal/values/base.yaml >/dev/null
```

## 4) Post-deploy checks

- intake-api pod healthy: `kubectl get pods -l app.kubernetes.io/component=intake-api`
- worker pod healthy and consuming the queue
- one end-to-end AgentRun reaches `succeeded` with `result.json` produced

## 5) Docs and branch hygiene

- ensure docs match release behavior (`README`, runbooks, plan)
- confirm merged PR branches are auto-deleted
- prune local refs and delete stale locals:

```bash
git fetch --prune origin
git branch --merged main
```
