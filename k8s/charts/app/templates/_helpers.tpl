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

{{/*
The Secret cert-manager writes the issued certificate and key into.

Derived from the fullname rather than taken from the hostname, so that two
releases in one namespace cannot collide: a Certificate owns its Secret, and two
Certificates naming the same one take turns overwriting each other's key pair.
The symptom arrives at the first renewal after the second release lands, which
is up to sixty days after the change that caused it.

`ingress.tls.secretName` overrides it, which is what an existing certificate
already in the cluster needs.
*/}}
{{- define "app.tlsSecretName" -}}
{{- if .Values.ingress.tls.secretName }}
{{- .Values.ingress.tls.secretName | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-tls" (include "app.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
One direction of an HPA's `behavior`, rendered from one entry of
`.Values.autoscaling.behavior`. Called with that entry as its context.

The values file names the two policy kinds as `percent` and `pods` rather than
supplying the API's list of `{type, value, periodSeconds}` objects, for the same
reason every other list in this chart is a map: Helm replaces arrays wholesale
instead of merging them, so an environment file that wanted to change the
scale-down period would have to restate every policy — and the one it forgot
would disappear silently.

`with` is safe on both: a policy is a non-empty map or it is absent, and the
schema requires at least one of the two, so `policies` is never rendered empty.
An empty `policies` list is not the same as no `policies` key — the API server
rejects it, which is a better failure than the one below, but only at apply
time.

`stabilizationWindowSeconds: 0` must render, so it is emitted unconditionally
rather than through `with`: `with 0` is false in Go templates, and an absent
window is not zero — it falls back to the API default, which for scale-down is
300 seconds. That is the difference between "scale up immediately" and "wait
five minutes", written identically.
*/}}
{{- define "app.hpaScalingRules" -}}
stabilizationWindowSeconds: {{ .stabilizationWindowSeconds }}
selectPolicy: {{ .selectPolicy }}
policies:
{{- with .percent }}
  - type: Percent
    value: {{ .value }}
    periodSeconds: {{ .periodSeconds }}
{{- end }}
{{- with .pods }}
  - type: Pods
    value: {{ .value }}
    periodSeconds: {{ .periodSeconds }}
{{- end }}
{{- end }}

{{/*
One NetworkPolicy peer, rendered as a single-element list from one entry of
`.Values.networkPolicy.ingress` or `.egress`. Called with that entry as its
context.

A single element, deliberately. `from`/`to` is a list, and the difference
between one element carrying both selectors and two elements carrying one each
is the difference between AND and OR — written almost identically, silently
accepted either way, and the single most common way an allowlist ends up
broader than its author read it. Because one values entry becomes one peer,
`namespaceLabels` and `podLabels` in the same entry are always ANDed, and
allowing two sources means writing two entries.

`ipBlock` and the selectors are mutually exclusive within a peer — the API
accepts a peer carrying both and the CNI's interpretation is not something to
rely on — so `values.schema.json` rejects an entry that sets `cidr` alongside
either selector, and this template need not choose between them.

Built as a map and passed through `toYaml` rather than written out as literal
YAML: the alternative is hand-managed indentation under a `- ` list marker for
a structure that is two or three levels deep and conditionally present, which
is where template-rendered manifests go wrong in ways `helm lint` cannot see.
*/}}
{{- define "app.networkPolicyPeer" -}}
{{- $peer := dict -}}
{{- if hasKey . "cidr" -}}
  {{- $block := dict "cidr" .cidr -}}
  {{- with .except }}{{- $_ := set $block "except" . -}}{{- end -}}
  {{- $_ := set $peer "ipBlock" $block -}}
{{- else -}}
  {{- with .namespaceLabels }}{{- $_ := set $peer "namespaceSelector" (dict "matchLabels" .) -}}{{- end -}}
  {{- with .podLabels }}{{- $_ := set $peer "podSelector" (dict "matchLabels" .) -}}{{- end -}}
{{- end -}}
{{- toYaml (list $peer) -}}
{{- end }}

{{/*
The ports of one allowlist entry, rendered from its `ports` list.

`protocol` defaults to TCP here rather than being left out. Kubernetes defaults
it to TCP too, so the rendered manifest is the same either way — but a rule
that omits it reads as "any protocol" to most people looking at
`kubectl describe netpol`, and that reading is wrong. Writing it out costs a
line and removes the question.

The schema requires at least one port per entry: a `from`/`to` with no `ports`
allows every port from that peer, which is an allowlist entry that names a
source and then does not limit what it may do.
*/}}
{{- define "app.networkPolicyPorts" -}}
{{- $ports := list -}}
{{- range . -}}
{{- $ports = append $ports (dict "port" .port "protocol" (.protocol | default "TCP")) -}}
{{- end -}}
{{- toYaml $ports -}}
{{- end }}
