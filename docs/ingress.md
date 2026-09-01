# Ingress: the address, the record, the certificate, and the six ways it looks fine and is not

The `app` chart renders one `Ingress`. Getting a request from a browser to a pod
takes four independent controllers, none of which is Kubernetes:

| Piece | Who | Where |
|---|---|---|
| The address | ingress-nginx | `k8s/argocd/<env>/applications/ingress-nginx.yaml` |
| The DNS record | external-dns | `k8s/argocd/<env>/applications/external-dns.yaml` |
| The certificate | cert-manager | `k8s/argocd/<env>/applications/cert-manager.yaml` |
| The issuer | a `ClusterIssuer` | `k8s/cert-manager/<env>/cluster-issuer.yaml` |
| Route 53 permission | two IRSA roles | `EksStack`, `props.dns` |
| The object itself | the chart | `k8s/charts/app/templates/ingress.yaml` |

The reason this document is long is the shape those four failures share. An
`Ingress` has one status field — `status.loadBalancer` — and it says nothing
about DNS, nothing about TLS and nothing about whether any controller claimed
the object. Every failure below leaves the Ingress looking exactly like a
working one.

---

## 1. What the chart renders, and the three fields that carry the weight

```yaml
ingress:
  enabled: true
  className: nginx
  hosts: [app.staging.example.com]
  path: /
  pathType: Prefix
  tls:
    clusterIssuer: letsencrypt-staging
    renewBefore: 720h
```

**`ingressClassName`, not the annotation.** `kubernetes.io/ingress.class` was
deprecated in Kubernetes 1.18, and ingress-nginx 1.0 stopped honouring it unless
the controller runs with `--watch-ingress-without-class`. An Ingress carrying
only the annotation is admitted by the API server, listed by `kubectl`, and
picked up by no controller — so `status.loadBalancer` stays empty, external-dns
publishes nothing, and cert-manager's ingress-shim never sees it. All three
symptoms read as a DNS problem.

**`spec.tls` is what makes the cert-manager annotation mean anything.**
ingress-shim builds its `Certificate` from the hosts in `spec.tls`, not from the
hosts in `spec.rules`. An Ingress annotated with `cert-manager.io/cluster-issuer`
and no `tls` block produces no Certificate, no event and no error — the
annotation simply reads as though TLS were handled. That is why this chart has
no `ingress.tls.enabled`: there is no supported shape in which the annotation is
present and inert, and `values.schema.json` rejects `tls: null`.

**The backend port is named.** `port: {name: http}` refers to the *Service's*
port name, which itself targets the container port by name. A number there would
be `service.port` — correct today and wrong the first time that value moves.

The IngressClass is deliberately **not** the cluster default
(`ingressClassResource.default: false`). A default class adopts every Ingress
that names none, including ones a chart nobody audited creates, and including
the ones somebody meant to point at a second controller later.

---

## 2. The AWS half: two IRSA roles, and why they are two

`EksStack` creates them only when it is given zones:

```sh
cdk deploy --context stagingEksHostedZoneIds=Z0123456789ABCDEFGHIJ
PRODUCTION_EKS_HOSTED_ZONE_IDS=Z0123456789ABCDEFGHIJ cdk deploy
```

Left unset, neither role exists. There is no zone the stack could invent, and an
IAM policy naming a zone that is not yours grants nothing while failing as an
access denied against a zone the reader has never seen.

The role names — `<environment>-external-dns` and `<environment>-cert-manager` —
are fixed rather than generated, because the Argo CD Applications annotate their
service accounts with those ARNs. The two halves of an IRSA pair are in
different files by necessity; making the name predictable is what keeps them
from drifting.

**Two roles, not one.** external-dns publishes address records for every Ingress
in the cluster and maintains a TXT ownership registry beside them; cert-manager
writes one `_acme-challenge` TXT record per order and deletes it again. A shared
role is the union of both, held by both, permanently — and the interesting half
of that union is cert-manager gaining the ability to rewrite the very A record
external-dns publishes.

**The conditions matter more than the resource.** `hostedzone/<id>` is the only
resource ARN `route53:ChangeResourceRecordSets` accepts, and within a zone it
permits *every* record — the `NS` and `SOA` records that delegate the domain
included. So both roles carry
`route53:ChangeResourceRecordSetsRecordTypes`, and cert-manager's also carries
`route53:ChangeResourceRecordSetsNormalizedRecordNames` restricted to
`_acme-challenge.*`. Neither controller needs `NS`, `SOA`, or any record outside
its own job, so the conditions cost nothing:

| Role | Zones | Record types | Names |
|---|---|---|---|
| `<env>-external-dns` | the given zones | A, AAAA, CNAME, TXT | any |
| `<env>-cert-manager` | the given zones | TXT | `_acme-challenge.*` |

Three list actions support no resource-level permission and are granted on `*`:
`route53:ListHostedZones`, `ListResourceRecordSets`, `ListTagsForResource` for
external-dns, and `ListHostedZonesByName` for cert-manager. The last is
load-bearing — the ClusterIssuer deliberately pins no `hostedZoneID` (see §4) —
and all four are reads.

One cert-manager requirement has nothing to do with IAM and fails identically:
the projected service-account token is mounted `0600 root:root`, and the
cert-manager container runs as a non-root user. Without
`securityContext.fsGroup: 1001` in its values it cannot read the file the AWS
SDK needs, and every DNS-01 challenge fails with a credentials error naming
neither a file nor a permission.

---

## 3. The load balancer, and what this repository does not install

`controller.service.type: LoadBalancer` with
`service.beta.kubernetes.io/aws-load-balancer-type: nlb` provisions a Network
Load Balancer through the AWS **cloud controller manager**, which EKS runs on
the managed control plane. It needs no add-on and no IAM of ours: the control
plane holds the permissions.

The alternative is the **AWS Load Balancer Controller**, which is the more
capable path — `target-type: ip` so traffic skips the second kube-proxy hop, WAF
and Shield association, the `aws-load-balancer-scheme` annotation, ALBs as well
as NLBs. It is not installed here, and that is a real trade rather than an
omission: it is another add-on, another IRSA role, and an IAM policy of about
sixty actions. What this repository loses by not having it:

- No `target-type: ip`. Traffic lands on a node and is forwarded, which is what
  makes `externalTrafficPolicy: Local` necessary below.
- No WAF association on the ingress path. `WafStack` protects the CloudFront and
  ALB paths; the NLB in front of ingress-nginx is layer 4 and has no hook for it.
- `service.beta.kubernetes.io/aws-load-balancer-scheme` is not honoured. The
  legacy annotation for an internal load balancer is
  `aws-load-balancer-internal: "true"`; its absence means internet-facing.

`externalTrafficPolicy: Local` is what preserves the client's source IP. With
`Cluster`, the packet is SNATed by the receiving node's kube-proxy before it
reaches a controller pod on another node, so every request arrives from a node
address and rate limiting, allowlists and access logs all see one client. The
cost is that only nodes running a controller pod pass the NLB's health check —
which is why production runs two replicas with a `minAvailable: 1` budget and a
zone spread, and why a single-replica cluster loses its ingress during any node
drain.

Because nothing in front of nginx sets `X-Forwarded-For` — the NLB forwards TCP
without touching the request — `use-forwarded-headers` is explicitly `false`.
Turning it on would mean trusting a header the client sent, which is the header
every source-IP allowlist is built from.

---

## 4. Two ACME endpoints, and why staging does not use the real one

| Cluster | ClusterIssuer | ACME directory |
|---|---|---|
| staging | `letsencrypt-staging` | `acme-staging-v02.api.letsencrypt.org` |
| production | `letsencrypt-production` | `acme-v02.api.letsencrypt.org` |

Let's Encrypt's production endpoint enforces two limits that a staging cluster
hits in different ways. **5 duplicate certificates per week** for an identical
set of names is the one a cluster that reissues on every merge reaches first,
and it only blocks that one hostname. **50 certificates per registered domain
per week** is the one that matters here, because it is counted on the registered
domain — `example.com`, not `app.staging.example.com` — so a staging cluster
churning through subdomains stops *production* from issuing. The staging
endpoint's certificates chain to a root no browser trusts, which is the correct
cost for a hostname no browser should be visiting.

`npm run audit:helm` fails a values file naming the wrong issuer, in both
directions. Naming an issuer that does not exist is the milder failure:
cert-manager reports `issuer not found` on a *CertificateRequest*, not on the
Ingress, which stays healthy while serving the controller's self-signed default.
Naming the *other environment's* issuer is worse, because it resolves.

**DNS-01, not HTTP-01.** The solver writes a TXT record instead of answering a
request, which buys three things:

- It works before the name resolves publicly and before the controller has an
  address, so a first deploy is not a three-way chicken-and-egg between the
  record, the certificate and the Ingress.
- It is the only challenge type that can issue a wildcard.
- It needs no path through the ingress, so `ssl-redirect: "true"` can stay on
  globally. An HTTP-01 setup has to keep `/.well-known/acme-challenge/`
  reachable over plaintext, and a redirect added later is the usual cause of a
  renewal that worked at issuance and silently stopped months afterwards.

The solver pins no `hostedZoneID` — a real zone identifier committed to a
repository whose purpose is being copied into other people's accounts is a
liability, and resolving by name costs one API call the role already permits.
`dns01RecursiveNameservers` points at public resolvers rather than CoreDNS: the
cluster resolves through the VPC resolver, which for a private hosted zone
returns the private view, so cert-manager would see its own TXT record as absent
and fail an order against a zone in which the record plainly exists.

Ambient credentials are why this is a `ClusterIssuer` and not an `Issuer`.
cert-manager takes AWS credentials from the pod only when ambient credentials
are permitted, which is the default for cluster issuers
(`--cluster-issuer-ambient-credentials=true`) and *not* the default for
namespaced ones.

---

## 5. external-dns: the two settings that make deletion safe

```yaml
registry: txt
txtOwnerId: staging-eks
policy: sync
domainFilters: [staging.example.com]
sources: [ingress]
```

`registry: txt` writes a companion TXT record beside every record external-dns
creates, stamped with `txtOwnerId`. It then treats any record without a matching
stamp as somebody else's and leaves it alone. **`txtOwnerId` must therefore be
unique per cluster.** Two clusters sharing a zone and an owner id each believe
they own the other's records, and `policy: sync` means each deletes what the
other created, in a loop, for as long as both are running.

`policy: sync` rather than the chart's `upsert-only` default. Upsert-only never
deletes, which sounds safer and means a hostname removed from git keeps
resolving to a load balancer that no longer serves it — a stale record pointing
at an address AWS will eventually hand to someone else. The TXT registry is what
bounds the deletions to records this cluster created; `domainFilters` bounds them
to one zone.

`sources: [ingress]` narrows the chart's default of `[service, ingress]`. A
Service becomes a record through an annotation any namespace owner can add, so
dropping it keeps "which names exist" answerable from the Ingress objects alone.

The chart's Ingress deliberately carries **no**
`external-dns.alpha.kubernetes.io/hostname` annotation. For an Ingress source
external-dns already reads `spec.rules[].host` and `spec.tls[].hosts`; the
annotation *replaces* that set rather than adding to it, so writing it out puts
the hostnames in a second place that no longer fails when the two disagree — it
just publishes the annotation's list.

---

## 6. Wildcards

`values.schema.json` rejects a host beginning `*.`, which is a decision about the
issuer rather than a longer hostname. A wildcard SAN can only be issued through a
DNS-01 challenge on the *apex* of the zone, so the ClusterIssuer's solver
selector and the IRSA policy both have to cover it, and one certificate then
fronts every name under the domain — including ones added later by someone who
did not know a certificate already covered them. Naming each host is the
reviewable form; a wildcard is available by widening the schema deliberately.

---

## 7. Renewal, and the one thing nothing here watches

Renewal is not a scheduled job that can be missing. cert-manager reconciles every
`Certificate` continuously and re-issues at `renewBefore` before expiry, using
the same controller loop that issued it. The chart writes `renewBefore: 720h`
explicitly onto the Ingress: cert-manager's own default is two thirds of the
certificate's lifetime, which for Let's Encrypt's 90 days is the same 30 days —
so this changes nothing today and keeps the window fixed if the issuer shortens
the lifetime, which Let's Encrypt has said it intends to.

**A renewal that fails, fails silently.** The certificate keeps serving. The
Ingress stays Ready. The `Certificate` goes `Ready: False` and the reason sits
one or two resources further down — on the `CertificateRequest`, the `Order` or
the `Challenge` — and nothing surfaces it until the expiry, up to 30 days later.

Nothing in this repository alerts on it, and that is a real gap rather than an
oversight: the signal is a Prometheus metric,
`certmanager_certificate_expiration_timestamp_seconds`, and there is no
Prometheus here — `CloudWatchAlarmsStack` watches ALB and ECS metrics, and the
EKS control plane's logs do not carry cert-manager's. Until something scrapes
it, the two available signals are Let's Encrypt's own expiry mail to the address
in the ClusterIssuer (sent at 20 days), and this, run against a cluster:

```sh
kubectl get certificate -A \
  -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name,READY:.status.conditions[0].status,RENEWAL:.status.renewalTime
```

Wiring `certmanager_certificate_expiration_timestamp_seconds` to a CloudWatch
alarm is a Phase 10 observability item, not this one.

---

## 8. The failures, and what each one looks like

Every row is a cluster in which the Ingress object is valid and admitted.

| Symptom | Cause | Where it is actually reported |
|---|---|---|
| Ingress has no ADDRESS | no controller claimed the class | nowhere — the Ingress has no condition for it |
| Name does not resolve | the Ingress has no address yet, so external-dns has nothing to publish | external-dns pod logs |
| Records vanish and reappear | two clusters sharing a `txtOwnerId` | external-dns logs on both clusters |
| Browser sees a self-signed certificate | the ClusterIssuer does not exist, or no `spec.tls` | `CertificateRequest`, not the Ingress |
| Certificate stuck `Ready: False` | DNS-01 answered from the private view of the zone | `Challenge` events |
| DNS-01 fails with a credentials error | missing `fsGroup: 1001` on cert-manager | cert-manager pod logs |
| **503 with healthy pods and endpoints** | the NetworkPolicy allowlist has no ingress-controller entry | nowhere — a NetworkPolicy has no status |
| Certificate expires having renewed for a year | a renewal loop failing since a chart bump | Let's Encrypt's expiry mail, at 20 days |

The 503 row is the one this repository gates hardest, because it is the only one
where *every* layer reports success: DNS resolves, the certificate is valid, the
Ingress has an address, the Service has endpoints, the pods are Ready, and the
controller cannot open a connection to any of them. `npm run audit:helm` fails a
values file that enables the Ingress with an empty `networkPolicy.ingress`, and
both environment files carry the entry:

```yaml
networkPolicy:
  ingress:
    - name: ingress-controller
      namespaceLabels:
        kubernetes.io/metadata.name: ingress-nginx
      podLabels:
        app.kubernetes.io/name: ingress-nginx
      ports:
        - port: http          # the container port by name, not service.port
          protocol: TCP
```

Two things about that entry are easy to get wrong and are covered in
[docs/network-policies.md](./network-policies.md): the two selectors are one peer
and therefore ANDed, and the port is matched against the pod's `containerPort`
rather than the Service's, because kube-proxy rewrites the destination before
policy is evaluated.

The order the pieces land in is expressed as Argo CD sync waves — cert-manager
(1), the ClusterIssuer (2), ingress-nginx (3), external-dns (4), the release
(10). What a wave does and does not guarantee is in
[docs/gitops-argocd.md](./gitops-argocd.md) §4: it orders the creation of the
`Application` objects, not the readiness of what they install. Everything here
converges from any order eventually; the waves just make the first sync of a
fresh cluster converge without a human retrying it.
