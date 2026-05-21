# Local instance

CLI-only mode. No controller, no CRDs, no Review UI. Single-user. State
lives in `./.agent-factory/runs/` next to whatever app you're operating on.

In production:

```
~/.agent-factory/
├── config.toml              # global defaults
├── secrets/                 # mode 0700; files mode 0600
│   ├── anthropic.key
│   └── speedscale.key
└── runs/
    └── 2026-05-21-radar-triage/
        ├── spec.json
        ├── plan.md
        ├── candidate.diff
        ├── quality-report.json
        └── prompts/

# Per-project override, in the app's repo root (gitignored)
.agent-factory.yaml
```

Files in this directory are example contents. Copy `config.toml` into
`~/.agent-factory/config.toml` and edit; drop `.agent-factory.yaml` into
the project root where you'll run the agent.
