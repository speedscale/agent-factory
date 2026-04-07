# Phase B First Live Run

This is the concrete execution plan for the first real-ticket autonomous run.

## Selected target

- repo: `speedscale/microsvc`
- issue: `#58`
- issue URL: `https://github.com/speedscale/microsvc/issues/58`
- intake payload: `examples/runs/microsvc-user-service-intake.json`

## Why this issue

- already documented in repo examples
- has clear behavior delta (expected `404`, observed `500`)
- has declared validation path (`make proxymock-replay`)

## Execution steps

1. start intake and worker in server mode
2. submit `microsvc-user-service-intake.json` to intake API
3. wait for run phase to reach `succeeded` or `failed`
4. collect evidence bundle from `artifacts/<run-name>/`
5. evaluate against `docs/autonomy-mvp.md` rubric
6. record operator decision using template below

## Operator decision record template

- run name:
- final phase:
- issue acceptance checks satisfied (yes/no):
- validation command passed (yes/no):
- scope remained ticket-focused (yes/no):
- decision: approve / reject
- notes:

## Latest execution result

- run name: `run-microsvc-user-service-microsvc-user-service-404`
- final phase: `failed`
- build command: `make test` (exit `0`)
- validation command: `make proxymock-replay` (exit `2`)
- key failure: service failed to become ready due runtime dependency failure

Observed validation error excerpt:

```text
service bootstrap timed out: localhost:8081 did not become ready
...
HikariPool-1 - Exception during pool initialization
org.postgresql.util.PSQLException: The connection attempt failed.
```

## What was implemented during this run

- workspace copy now excludes `node_modules`, `.git`, `.work`, and `artifacts` to avoid recursive copy failures
- validation flow now supports service bootstrap (`validate.proxymock.service`) with TCP readiness waiting
- validation logs now include captured service stdout/stderr on bootstrap timeout

## Next remediation for Phase B

Before the first ticket can pass autonomously, runtime dependency bootstrapping must be added for validation service startup:

1. provide dependency profile for service bootstrap (DB/mock endpoints/env)
2. start dependencies before service bootstrap
3. re-run replay validation and evaluate against rubric
