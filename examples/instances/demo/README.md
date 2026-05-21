# Demo instance

Public demo with frozen sample data. Time-bounded runs. No real SCM
credentials; no production traffic. Safe to expose externally.

In production this tree lives in `demos/agent-factory-config/`.

## Guard rails

- `agentDefaults.*.autoCreatePR: false` — every agent, every time.
- `agentDefaults.pr-replay-check.blockMerge: false` — advisory only.
- `engine.authSecret` references a demo-bounded API key with low quota.
- `TrafficSource` points at a frozen sample snapshot (not a live store).
