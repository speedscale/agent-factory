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
