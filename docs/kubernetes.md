# Kubernetes Deployment Guide

This guide shows how to run Agent Factory on Kubernetes using the same intake/worker split used locally.

## What this deployment includes

- `intake-api` deployment and service
- `worker` deployment
- shared PVC for `artifacts/` and `.work/`
- Kustomize base at `examples/deploy/kubernetes/base`

## Prerequisites

- Kubernetes cluster access
- `kubectl`
- image available at `ghcr.io/speedscale/agent-factory:latest`

If you are building locally and using kind/minikube, load the image into your cluster runtime.

## Deploy

```bash
kubectl apply -k examples/deploy/kubernetes/base
```

Check status:

```bash
kubectl -n agent-factory get deploy,pods,svc,pvc
```

## Submit a run

Port-forward intake API:

```bash
kubectl -n agent-factory port-forward svc/intake-api 8080:8080
```

Submit sample intake payload:

```bash
curl -sS -X POST http://127.0.0.1:8080/runs \
  -H "content-type: application/json" \
  --data-binary @examples/runs/demo-node-intake.json
```

Watch worker logs:

```bash
kubectl -n agent-factory logs deploy/worker -f
```

## Current limits of this deployment

- worker is wired to the local demo fixture source (`/app/.work/demo-fixture`)
- queue backend is filesystem only
- PVC assumes single-writer style semantics for this early reference path

This is sufficient to prove service-mode architecture on cluster before introducing Redis queueing and multi-replica worker scaling.
