# Golden Path Demo

Run the full local loop with:

```bash
npm run demo
```

This command:

- creates a demo `AgentRun` from the sample app and issue
- writes a structured `AgentPlan`
- runs the build stage in an isolated workspace
- runs proxymock validation with a local shim
- leaves artifacts under `artifacts/<run-name>/`
