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
