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
- final phase: `succeeded`
- build command: `make test` (exit `0`)
- validation command: `make proxymock-replay` (exit `0`)
- result: replay validation completed successfully with runtime dependency + service bootstrap flow
- automated PR output: `https://github.com/speedscale/microsvc/pull/65`

Observed validation error excerpt:

```text
Validation succeeded: make proxymock-replay
```

## What was implemented during this run

- workspace copy now excludes `node_modules`, `.git`, `.work`, and `artifacts` to avoid recursive copy failures
- validation flow now supports service bootstrap (`validate.proxymock.service`) with TCP readiness waiting
- validation logs now include captured service stdout/stderr on bootstrap timeout
- validation supports dependency setup/teardown hooks (`validate.proxymock.dependencies`)
- microsvc profile now boots an isolated postgres dependency container and runs user-service on `SERVER_PORT=8081`

## Next remediation for Phase B

Phase B infrastructure path for first live run is now working. Next gap is autonomous ticket quality (triage/patch intent), not runtime orchestration.

End-to-end proof (ticket -> run -> validate -> PR) is now demonstrated for the selected microsvc issue path.

For ongoing proofs, populate `evidence.json` with:

- discovery notes from logs
- Speedscale capture dataset + request/response summary
- local repro steps and observed/expected behavior

1. run-to-PR automation from successful run artifacts
2. complete operator decision record against full autonomy rubric
3. validate that generated PR scope stays aligned to issue acceptance checks
