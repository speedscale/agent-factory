# Demo instance

Hosted demo using [outerspace-go](https://github.com/speedscale/outerspace-go)
as the target application. Traffic is pulled live from a Grafana/Loki stack via
the `byoc-grafana-snapshot` TrafficSource. All agents run in advisory mode —
no SCM writes, no PR creation.

In production this tree lives in `demos/agent-factory-config/`.

## Traffic path

`store.kind: loki` — the controller calls `loki-gather` at AgentRun start,
pulling the last `-1h` of RRPairs from Loki and writing them into a local
snapshot directory. The Worker reads that directory via the standard
`local-fs` code path; nothing downstream changes.

Update `store.endpoint` in `trafficsources/byoc-grafana-snapshot.yaml` (and in
`values.yaml`) to point at your Loki instance. For the reference Grafana BYOC
stack the default value is correct:

```
http://loki.observability.svc.cluster.local:3100
```

See `docs/CONFIG.md` for the full list of `store.kind` options (Speedscale
Cloud, on-prem, Loki, Elasticsearch).

## Guard rails

- `agents.*.autoCreatePR: false` — every agent runs advisory, no SCM writes.
- `agents.pr-replay-check.blockMerge: false` — replay checks never block.
- `engine.authSecret` references a demo-bounded key with low quota.
