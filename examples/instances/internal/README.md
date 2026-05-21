# Internal dogfood instance

Speedscale's own deployment, run in our internal k8s cluster against our
own services (radar, usr-mgmt, etc.). Doubles as the release QA harness —
every binary release is gated on dogfood eval runs against held-out
historical snapshots.

In production this tree lives in `speedstack/agent-factory-internal/`
(separate repo). The version here is a reference; copy and fill in the
secrets via sealed-secrets or your secret manager.

## Layout

```
.
├── README.md
├── values.yaml                      # chart values (engine, sizing, RBAC)
├── trafficsources/
│   └── prod-speedscale.yaml         # TrafficSource CRs
└── apps/
    ├── radar.yaml                   # AgentApp CRs
    └── usr-mgmt.yaml
```

## Apply

```bash
helm upgrade --install agent-factory ../../../charts/agent-factory \
  --namespace agent-factory --create-namespace \
  --values values.yaml

kubectl apply -f trafficsources/
kubectl apply -f apps/
```

## Eval datasets

Eval data (`eval/historical-snapshots/`, `eval/known-fixes.yaml`,
`eval/coverage-baseline.yaml`) is dogfood-only and lives in
`speedstack/agent-factory-internal/eval/` — not in this public repo.
Held-out Speedscale-internal traffic must not be checked in here.
