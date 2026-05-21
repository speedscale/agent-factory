# Instance examples

Four flavors of agent-factory deployment, each with its own configuration
home outside this repo in production. The trees here are reference
templates — copy them into your own GitOps repo (or dotfile location for
`local/`) and fill in real values.

| Flavor | Topology | Config home in production |
|---|---|---|
| [`local/`](./local) | CLI only, no controller, single-user | `~/.agent-factory/config.toml` + per-project `.agent-factory.yaml` |
| [`internal/`](./internal) | Full Helm install in Speedscale's own cluster | `speedstack/agent-factory-internal/` GitOps repo |
| [`customer/`](./customer) | Full Helm install in customer VPC | Customer's GitOps repo + sealed secrets |
| [`demo/`](./demo) | Hosted Helm install with frozen sample data | `demos/agent-factory-config/` |

These directories are reference material only; they are not consumed by the
chart or the binary directly. The chart lives at `../../charts/agent-factory/`.

See `planning/projects/agent-factory/internal-design.md` §18 for the
architectural rationale (what stays the same vs. what varies across flavors).
