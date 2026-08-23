{{/*
Name helpers.

Kubernetes object names are limited to 63 characters for anything that becomes
a label value, and a name that is truncated after a hyphen is invalid, so every
helper truncates and then trims a trailing hyphen.
*/}}

{{- define "app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
The name every object in the release is derived from.

`contains $name .Release.Name` is the standard guard against `app-app`: a
release already called `app-staging` should not produce `app-staging-app`.
*/}}
{{- define "app.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "app.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Labels on every object.

`app.kubernetes.io/*` are the names every Kubernetes tool already understands,
so `kubectl get pods -l app.kubernetes.io/instance=<release>` works without the
operator knowing anything about this chart. `app.kubernetes.io/environment` is
not part of that set but is the one label that answers "which values file
produced this pod", which is the question asked during an incident.
*/}}
{{- define "app.labels" -}}
helm.sh/chart: {{ include "app.chart" . }}
{{ include "app.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: {{ include "app.name" . }}
app.kubernetes.io/environment: {{ .Values.environment | quote }}
{{- end }}

{{/*
Selector labels are a subset of the above and are immutable on a Deployment:
`spec.selector` cannot be changed after creation, so anything that varies
between releases — the chart version, the image tag — must stay out of it.
Putting `app.kubernetes.io/version` in here would make every version bump a
delete-and-recreate rather than a rolling update.
*/}}
{{- define "app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "app.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "app.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
An HTTP probe, rendered from one entry of `.Values.probes`. Called with that
entry as its context, not with the root.

`hasKey` rather than `with`: `with 0` is false in Go templates, so `with
.initialDelaySeconds` silently drops `initialDelaySeconds: 0` — which is a
different probe from one with no `initialDelaySeconds` only in that the field
is absent, but the same template bug would drop a `failureThreshold` of 0 if
one were ever legal. Testing for the key means the rendered probe contains
exactly the fields the values file set.

The port is referenced by name, so `containerPort` is set in one place.
*/}}
{{- define "app.httpProbe" -}}
httpGet:
  path: {{ .path }}
  port: http
{{- if hasKey . "initialDelaySeconds" }}
initialDelaySeconds: {{ .initialDelaySeconds }}
{{- end }}
periodSeconds: {{ .periodSeconds }}
{{- if hasKey . "timeoutSeconds" }}
timeoutSeconds: {{ .timeoutSeconds }}
{{- end }}
failureThreshold: {{ .failureThreshold }}
{{- if hasKey . "successThreshold" }}
successThreshold: {{ .successThreshold }}
{{- end }}
{{- end }}

{{- define "app.configMapName" -}}
{{- printf "%s-config" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
