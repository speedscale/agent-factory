# Customer (BYOC) instance — template

The shipped product. Customer forks this template into their own GitOps
repo. All evidence (traffic, code, logs, metrics, run artifacts) stays in
the customer's VPC; only DLP-masked prompts leave for the LLM (unless the
private-LLM path is configured).

## Customize

1. Copy this directory into your GitOps repo (e.g.
   `<your-org>/agent-factory-config/`).
2. Edit `values.yaml`: pick an `engine.kind` (Anthropic, Bedrock, Azure,
   or self-hosted vLLM), set `engine.endpoint` and `engine.authSecret`.
3. Edit `trafficsources/prod.yaml`: point `store` at your in-cluster
   proxymock RRPair store; set `scope.clusters` to your cluster names.
4. Add `AgentApp` CRs under `apps/` for each application you want
   the factory to operate on.
5. Provision secrets:
   - `anthropic-api-key` (or equivalent for your LLM choice)
   - One Git host PAT per repo, named `<repo>-git-pat`
   - `proxymock-api-key` (if `store.kind` is non-local)
   We recommend sealed-secrets, External Secrets Operator, or Vault CSI.
6. Apply:
   ```bash
   helm upgrade --install agent-factory speedscale/agent-factory \
     --namespace agent-factory --create-namespace \
     --values values.yaml

   kubectl apply -f trafficsources/
   kubectl apply -f apps/
   ```

## Data boundary

The chart never embeds secret values. The agent's only outbound call is
to the LLM endpoint, and only with DLP-masked content (controlled by
`TrafficSource.spec.dlp.profile`). The validating webhook rejects
`dlp.profile: none` on any TrafficSource scoped to a prod cluster.

For air-gapped installs, set `engine.kind=private-llm` and point
`engine.endpoint` at your in-cluster model serving endpoint (vLLM, TGI,
etc.). The chart wiring is identical; no data leaves the cluster.
