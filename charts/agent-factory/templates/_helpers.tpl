{{/* Common labels and selector helpers for agent-factory. */}}

{{- define "agent-factory.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agent-factory.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "agent-factory.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agent-factory.labels" -}}
helm.sh/chart: {{ include "agent-factory.chart" . }}
{{ include "agent-factory.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "agent-factory.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agent-factory.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "agent-factory.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "agent-factory.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Resolved image reference. */}}
{{- define "agent-factory.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{/*
  Engine kind canonicalization. Mirrors src/lib/engine-config.ts:
  - claude-sdk                       -> anthropic   (cloud, needs auth)
  - openrouter / generic-llm /
    private-llm                      -> openrouter  (cloud, needs auth)
  - ds4, omlx                        -> local       (no auth needed)
  Returns "true" for kinds that need engine.authSecret mounted, "" otherwise.
  Fails the render on unknown kind so misconfiguration is caught at
  `helm template` / `helm install` time, not at pod startup.
*/}}
{{- define "agent-factory.engineKindRequiresAuth" -}}
{{- $kind := .Values.engine.kind -}}
{{- if or (eq $kind "claude-sdk") (eq $kind "openrouter") (eq $kind "generic-llm") (eq $kind "private-llm") -}}
true
{{- else if or (eq $kind "ds4") (eq $kind "omlx") -}}
{{/* local — no auth */}}
{{- else -}}
{{- fail (printf "engine.kind=%q is not a recognized kind. Expected one of: claude-sdk, openrouter, ds4, omlx, generic-llm, private-llm." $kind) -}}
{{- end -}}
{{- end -}}

{{/*
  Returns "true" when engine.kind maps to the anthropic provider — i.e.
  when ANTHROPIC_API_KEY must be mirrored from engine.authSecret so the
  Anthropic SDK can find it. Currently only claude-sdk; openrouter / ds4 /
  omlx have their own *_API_KEY conventions.
*/}}
{{- define "agent-factory.engineKindIsAnthropic" -}}
{{- if eq .Values.engine.kind "claude-sdk" -}}
true
{{- end -}}
{{- end -}}

{{/*
  Fail-fast guard. Used inside deployment templates: when the engine kind
  requires auth, engine.authSecret.name must be non-empty. Without this
  the pod would render with a secretKeyRef to "" and fail at scheduling
  time with a confusing error.
*/}}
{{- define "agent-factory.assertEngineAuthSecret" -}}
{{- if eq (include "agent-factory.engineKindRequiresAuth" .) "true" -}}
{{- if not .Values.engine.authSecret.name -}}
{{- fail (printf "engine.kind=%q requires engine.authSecret.name to be set (no API key secret configured)." .Values.engine.kind) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
  The worker container spec, shared by the standalone worker Deployment and
  the colocated mode (worker.colocated=true), where it runs as a second
  container in the intake-api pod. Keeping one definition guarantees both
  topologies run the worker with identical env wiring.
*/}}
{{- define "agent-factory.workerContainer" -}}
- name: worker
  image: {{ include "agent-factory.image" . }}
  imagePullPolicy: {{ .Values.image.pullPolicy }}
  command:
    - /bin/sh
    - -lc
    - |
      node dist/bin/worker.js --poll-ms {{ .Values.worker.pollIntervalMs }} --claim-ttl-ms {{ .Values.worker.claimTtlMs }}
  env:
    - name: RUN_QUEUE_BACKEND
      value: filesystem
    - name: AF_ENGINE_KIND
      value: {{ .Values.engine.kind | quote }}
    - name: AF_ENGINE_MODEL
      value: {{ .Values.engine.model | quote }}
    - name: AF_ENGINE_ENDPOINT
      value: {{ .Values.engine.endpoint | quote }}
    {{- /*
      AF_ENGINE_AUTH_TOKEN is only mounted when the kind requires
      auth and a secret name is configured. Local providers (ds4,
      omlx) speak to 127.0.0.1 and don't need a token; an empty
      secretKeyRef would fail scheduling.
    */ -}}
    {{- if and (eq (include "agent-factory.engineKindRequiresAuth" .) "true") .Values.engine.authSecret.name }}
    - name: AF_ENGINE_AUTH_TOKEN
      valueFrom:
        secretKeyRef:
          name: {{ .Values.engine.authSecret.name }}
          key: {{ .Values.engine.authSecret.key }}
    {{- end }}
    {{- /*
      ANTHROPIC_API_KEY is what the agent loop (src/lib/llm-providers.ts)
      reads. We mirror engine.authSecret into it so triage and other
      real agents can call Claude without operators having to rotate
      two copies of the same key. Only injected when engine.kind is
      claude-sdk; other providers read their own provider-specific
      env vars (OPENROUTER_API_KEY etc.) which stay separate.
    */ -}}
    {{- if and (eq (include "agent-factory.engineKindIsAnthropic" .) "true") .Values.engine.authSecret.name }}
    - name: ANTHROPIC_API_KEY
      valueFrom:
        secretKeyRef:
          name: {{ .Values.engine.authSecret.name }}
          key: {{ .Values.engine.authSecret.key }}
    {{- end }}
    {{- /*
      LINEAR_API_KEY lets agents post back to Linear (the triage
      agent's comment-back is the first user). Optional — if the
      secret isn't configured the agents log and skip; the verdict
      is still preserved in the run artifact.
    */ -}}
    {{- if .Values.linear.authSecret.name }}
    - name: LINEAR_API_KEY
      valueFrom:
        secretKeyRef:
          name: {{ .Values.linear.authSecret.name }}
          key: {{ .Values.linear.authSecret.key }}
          optional: true
    {{- end }}
    {{- /*
      AF_TRAFFIC_ARCHIVE_* — the reproduce handler fetches archived
      evidence back from the same S3 bucket intake-api wrote it to, so
      the worker mirrors intake-api's archive config. Bucket/endpoint/
      region are plain config; only the credentials come from a Secret.
    */ -}}
    {{- with .Values.intakeApi.otlp.archive }}
    {{- if .bucket }}
    - name: AF_TRAFFIC_ARCHIVE_BUCKET
      value: {{ .bucket | quote }}
    - name: AF_TRAFFIC_ARCHIVE_ENDPOINT
      value: {{ .endpoint | quote }}
    - name: AF_TRAFFIC_ARCHIVE_REGION
      value: {{ .region | default "us-east-1" | quote }}
    {{- if .secretName }}
    - name: AF_TRAFFIC_ARCHIVE_ACCESS_KEY_ID
      valueFrom:
        secretKeyRef:
          name: {{ .secretName }}
          key: access-key-id
    - name: AF_TRAFFIC_ARCHIVE_SECRET_ACCESS_KEY
      valueFrom:
        secretKeyRef:
          name: {{ .secretName }}
          key: secret-access-key
    {{- end }}
    {{- end }}
    {{- end }}
    {{- /*
      SPEEDSCALE_API_KEY / SPEEDSCALE_APP_URL — the reproduce handler
      initializes proxymock with these before replaying (the CLI refuses
      to run before `proxymock init`). Optional: without them, live
      replay fails and the run records proxymock's own error.
    */ -}}
    {{- if .Values.speedscale.authSecret.name }}
    - name: SPEEDSCALE_API_KEY
      valueFrom:
        secretKeyRef:
          name: {{ .Values.speedscale.authSecret.name }}
          key: {{ .Values.speedscale.authSecret.key }}
          optional: true
    {{- end }}
    {{- if .Values.speedscale.appUrl }}
    - name: SPEEDSCALE_APP_URL
      value: {{ .Values.speedscale.appUrl | quote }}
    {{- end }}
    {{- /*
      Reproduce handler config. All optional: no replayTarget → the
      handler degrades to re-analysing the captured traffic; no
      linearTeamId → it confirms but doesn't file a ticket.
    */ -}}
    {{- with .Values.worker.reproduce }}
    {{- if .replayTarget }}
    - name: REPRODUCE_REPLAY_TARGET
      value: {{ .replayTarget | quote }}
    {{- end }}
    {{- if .linearTeamId }}
    - name: LINEAR_REPRODUCE_TEAM_ID
      value: {{ .linearTeamId | quote }}
    {{- end }}
    {{- if .linearLabelId }}
    - name: LINEAR_REPRODUCE_LABEL_ID
      value: {{ .linearLabelId | quote }}
    {{- end }}
    {{- end }}
  resources:
    {{- toYaml .Values.worker.resources | nindent 4 }}
  {{- with .Values.securityContext }}
  securityContext:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  volumeMounts:
    - { name: agent-data, mountPath: /app/artifacts, subPath: artifacts }
    - { name: agent-data, mountPath: /app/.work,     subPath: work }
{{- end -}}
