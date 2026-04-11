# Microsvc Onboarding

Audience: Agent Factory users/operators onboarding the microsvc demo target.

This guide shows how to run Agent Factory against `speedscale/microsvc` with the user-service target.

Use `docs/users.md` for generic runtime setup first, then apply the microsvc-specific values here.

## 1. Clone microsvc

You already have the repo at `/Users/kahrens/go/src/github.com/speedscale/microsvc`.

Use the `backend/user-service` module as the initial onboarded app.

## 2. Start Agent Factory (server mode)

```bash
npm run intake-api
```

In another terminal:

```bash
npm run worker -- --source /Users/kahrens/go/src/github.com/speedscale/microsvc
```

## 3. Submit the run

POST `examples/runs/microsvc-user-service-pr-quality-intake.json` to `/qa/runs`:

```bash
curl -s -X POST http://127.0.0.1:8080/qa/runs \
  -H 'content-type: application/json' \
  --data @examples/runs/microsvc-user-service-pr-quality-intake.json
```

Capture the returned run name, then use it in the next steps.

## 4. Monitor run execution

The worker automatically runs plan/build/validate.

```bash
curl -sS "http://127.0.0.1:8080/runs/<run-name>"
```

Check artifacts:

```bash
ls artifacts/<run-name>
```

## Full sequence (operator path)

```bash
npm run intake-api
npm run worker -- --source /Users/kahrens/go/src/github.com/speedscale/microsvc
curl -sS -X POST http://127.0.0.1:8080/qa/runs \
  -H 'content-type: application/json' \
  --data-binary @examples/runs/microsvc-user-service-pr-quality-intake.json
curl -sS "http://127.0.0.1:8080/runs/<run-name>"
```

## 5. Optional: create a PR from a succeeded run

```bash
npm run run-to-pr -- --run <run-name> --repo /Users/kahrens/go/src/github.com/speedscale/microsvc
```

## 6. Full demo

For the built-in sample app, use:

```bash
npm run demo
```
