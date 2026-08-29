# Argo CD

The delivery path for the EKS clusters in `aws/cdk/lib/eks-stack.ts`. One Argo CD
per cluster, one root Application per Argo CD, and everything below it described
by files in this directory.

```
k8s/argocd/
  staging/            production/
    root.yaml           root.yaml          ← applied by hand, once, per cluster
    projects/           projects/          ← what each Application may deploy
      platform.yaml       platform.yaml       cluster add-ons (privileged)
      app.yaml            app.yaml            the release (one namespace)
    applications/       applications/      ← what is deployed
      metrics-server.yaml metrics-server.yaml
      app.yaml            app.yaml
  fixtures/                                ← manifests the audit must reject
```

Bootstrapping a cluster is one command against `root.yaml`; everything else
follows from git. `docs/gitops-argocd.md` is the guide — what the sync waves do
and do not guarantee, which drift self-heal corrects and which it cannot see, and
what automated sync in production costs.

The two environment trees are deliberately identical apart from the environment
name. `npm run audit:argocd` fails when they stop being, along with two dozen
other things the API server and Argo CD accept without complaint.
