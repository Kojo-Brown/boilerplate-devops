import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';
import { ENVIRONMENTS, ENVIRONMENT_CLUSTER_ISSUERS } from '../tools/audit-helm-values';

/**
 * The ACME issuers under `k8s/cert-manager/`.
 *
 * These are the one part of the ingress path that no other gate reaches.
 * `npm run audit:argocd` reads `k8s/argocd/`, which holds the Application that
 * *points* at this directory but not what is in it; `npm run audit:helm` reads
 * the chart, which names an issuer by string and cannot see whether the cluster
 * installs one. So the manifest that decides which certificate authority signs
 * production's certificate is checked here.
 *
 * The failure worth the most attention is the staging tree pointed at Let's
 * Encrypt's production directory. It is a one-word edit, it *works* — the
 * certificate is trusted, so nothing looks wrong — and it spends a rate limit
 * Let's Encrypt counts on the registered domain rather than the subdomain, so
 * the next thing it breaks is issuance in production. See docs/ingress.md §4.
 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ISSUER_DIRECTORY = path.join(REPO_ROOT, 'k8s', 'cert-manager');

/** The ACME directory each environment's cluster must register against. */
const ACME_DIRECTORIES: Readonly<Record<string, string>> = {
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
  production: 'https://acme-v02.api.letsencrypt.org/directory',
};

const issuer = (environment: string): Record<string, any> =>
  load(
    fs.readFileSync(path.join(ISSUER_DIRECTORY, environment, 'cluster-issuer.yaml'), 'utf8'),
  ) as Record<string, any>;

describe('the ACME issuers under k8s/cert-manager', () => {
  it('has one tree per environment and nothing else', () => {
    const onDisk = fs
      .readdirSync(ISSUER_DIRECTORY, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(onDisk).toEqual([...ENVIRONMENTS].sort());
  });

  it.each(ENVIRONMENTS)('%s holds exactly one manifest', (environment) => {
    // The Application over this directory sets `recurse: false` and prunes, so
    // a second file here is one more cluster-scoped object applied by a path
    // nobody reads as a deploy.
    const files = fs.readdirSync(path.join(ISSUER_DIRECTORY, environment)).sort();

    expect(files).toEqual(['cluster-issuer.yaml']);
  });

  it.each(ENVIRONMENTS)('%s declares a cert-manager ClusterIssuer', (environment) => {
    const document = issuer(environment);

    expect(document.apiVersion).toBe('cert-manager.io/v1');
    // Not an `Issuer`: a namespaced Issuer would need duplicating into every
    // namespace that wants a certificate, and cert-manager permits ambient
    // credentials — how it reaches IRSA — for cluster issuers by default and
    // not for namespaced ones.
    expect(document.kind).toBe('ClusterIssuer');
  });

  it.each(ENVIRONMENTS)('%s is named what the chart’s values name', (environment) => {
    // cert-manager resolves an issuer by name and reports a miss on a
    // CertificateRequest, not on the Ingress — which stays healthy, serving the
    // controller's self-signed default. This and `npm run audit:helm` read the
    // same constant so the two halves cannot drift apart.
    expect(issuer(environment).metadata.name).toBe(ENVIRONMENT_CLUSTER_ISSUERS[environment]);
  });

  it.each(ENVIRONMENTS)('%s registers against its own ACME directory', (environment) => {
    expect(issuer(environment).spec.acme.server).toBe(ACME_DIRECTORIES[environment]);
  });

  it('keeps staging off the endpoint whose rate limit production needs', () => {
    // Stated separately from the row above because it is the assertion with a
    // consequence: Let's Encrypt counts its 50-certificates-per-week limit on
    // the *registered* domain rather than the subdomain, so a staging cluster
    // reissuing on every merge stops production issuing.
    expect(issuer('staging').spec.acme.server).not.toBe(ACME_DIRECTORIES.production);
  });

  it.each(ENVIRONMENTS)('%s registers an address expiry notices can reach', (environment) => {
    // Let's Encrypt mails this address 20 days before an unreplaced certificate
    // expires, which is the only external signal that a renewal loop has been
    // failing — nothing in this repository scrapes cert-manager's metrics. See
    // docs/ingress.md §7.
    expect(issuer(environment).spec.acme.email).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  });

  it('gives each environment its own ACME account key', () => {
    const names = ENVIRONMENTS.map((environment) => issuer(environment).spec.acme.privateKeySecretRef.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it.each(ENVIRONMENTS)('%s solves through DNS-01 against Route 53', (environment) => {
    const solvers = issuer(environment).spec.acme.solvers;

    expect(solvers).toHaveLength(1);
    // HTTP-01 would need `/.well-known/acme-challenge/` reachable over
    // plaintext, which the controller's `ssl-redirect: "true"` breaks — and it
    // breaks renewals months after an issuance that worked.
    expect(Object.keys(solvers[0])).toEqual(['dns01', 'selector']);
    expect(Object.keys(solvers[0].dns01)).toEqual(['route53']);
  });

  it.each(ENVIRONMENTS)('%s scopes its solver to a zone', (environment) => {
    // A solver with no selector answers every challenge, so a second solver
    // added later for another zone would never be reached.
    const zones = issuer(environment).spec.acme.solvers[0].selector?.dnsZones;

    expect(Array.isArray(zones)).toBe(true);
    expect(zones.length).toBeGreaterThan(0);
  });

  it.each(ENVIRONMENTS)('%s pins no hosted zone identifier', (environment) => {
    // Everything in this repository is copied into somebody else's account, and
    // a zone ID is the one identifier `npm run scan:identifiers` does not look
    // for. Resolving by name costs one `route53:ListHostedZonesByName` the IRSA
    // policy already grants for exactly this.
    expect(issuer(environment).spec.acme.solvers[0].dns01.route53.hostedZoneID).toBeUndefined();
  });
});
