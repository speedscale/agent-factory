# Golden Path Demo

Audience: Agent Factory users/operators.

Run the full local loop with:

```bash
npm run loop-demo
```

This command:

- runs baseline mode first to seed the baseline contract
- runs comparison mode with a forced replay failure to prove regression detection
- runs comparison mode again with a passing replay to prove recovery
- applies command guardrails (timeout, no-output timeout, retry) in build and validation
- leaves artifacts under `artifacts/<run-name>/`

For a single bot-orchestrated run from an intake file:

```bash
npm run bot -- --intake examples/runs/demo-node-intake.json
```
