# Microsvc Onboarding

This guide shows how to run Agent Factory against `speedscale/microsvc`.

## 1. Clone microsvc

You already have the repo at `/Users/kahrens/go/src/github.com/speedscale/microsvc`.

Use the `backend/user-service` module as the initial onboarded app.

## 2. Start Agent Factory intake

```bash
npm run intake-api
```

## 3. Submit the run

POST `examples/runs/microsvc-user-service-intake.json` to `/runs`:

```bash
curl -s -X POST http://127.0.0.1:8080/runs \
  -H 'content-type: application/json' \
  --data @examples/runs/microsvc-user-service-intake.json
```

Capture the returned run name, then use it in the next steps.

## 4. Plan

```bash
npm run planner -- --run <run-name>
```

This reads `artifacts/<run-name>/run.json` and writes `artifacts/<run-name>/plan.yaml`.

## 5. Build

```bash
npm run runner -- --run <run-name> --source /path/to/microsvc
```

Pass `/Users/kahrens/go/src/github.com/speedscale/microsvc` as the source path.

The runner copies the clone into `.work/<run-name>/` before executing the build command.

## 6. Validate

```bash
npm run validator -- --run <run-name>
```

The validator executes the app's proxymock replay command from the copied workspace.

It expects the runner step to have already populated the workspace.

## Full sequence

```bash
npm run intake-api
curl -s -X POST http://127.0.0.1:8080/runs \
  -H 'content-type: application/json' \
  --data @examples/runs/microsvc-user-service-intake.json
npm run planner -- --run <run-name>
npm run runner -- --run <run-name> --source /Users/kahrens/go/src/github.com/speedscale/microsvc
npm run validator -- --run <run-name>
```

## 7. Full demo

For the built-in sample app, use:

```bash
npm run demo
```
