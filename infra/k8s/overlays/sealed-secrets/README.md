# Sealed Secrets overlay

The alternative to [External Secrets](../external-secrets/) when you want the
encrypted secret **committed to this repository** rather than fetched from an
external store at runtime. Encryption is to a public key held by the
controller in your cluster, so the sealed file is safe to track in git — only
that controller can decrypt it.

Pick this path if you have no secrets manager to point at. Pick External
Secrets if you do; rotation there does not require a commit.

## One-time setup

```bash
helm repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets
helm install sealed-secrets sealed-secrets/sealed-secrets \
    -n kube-system

# kubeseal CLI, matching the controller version
brew install kubeseal          # or: https://github.com/bitnami-labs/sealed-secrets/releases
```

## Generating the sealed manifest

Fill in a *local, untracked* Secret first, then seal it. Never commit the
plaintext intermediate.

```bash
# 1. Start from the template, fill in real values.
cp ../local/01-secrets.example.yaml /tmp/assurecode-secrets.yaml
$EDITOR /tmp/assurecode-secrets.yaml

# 2. Seal it against the cluster's controller public key.
kubeseal --format yaml \
    --controller-namespace kube-system \
    --controller-name sealed-secrets \
    < /tmp/assurecode-secrets.yaml \
    > sealed-secrets.yaml

# 3. Destroy the plaintext.
shred -u /tmp/assurecode-secrets.yaml   # or: rm -P on macOS
```

`sealed-secrets.yaml` is then safe to commit **in this directory**.

## Applying

```bash
kubectl apply -f infra/k8s/                          # base, with placeholders
kubectl apply -f infra/k8s/overlays/sealed-secrets/  # controller unseals it
```

The controller decrypts into a Secret named `assurecode-secrets` — the same
name the base creates and every Deployment references via `envFrom.secretRef`
— so it replaces the placeholders with no workload changes.

## Why this directory is outside the base

CI runs `kubectl apply --dry-run=client -f infra/k8s/`, which is
non-recursive. Keeping the overlay here means the dry-run never sees a
`SealedSecret` CRD that isn't installed on the runner, and never sees a second
object competing with the base's `assurecode-secrets`.

## Rotation

Re-seal and re-apply. The controller updates the Secret in place, but running
pods keep the old value in their environment — `envFrom` is resolved at pod
start, not watched. Restart the consumers:

```bash
kubectl rollout restart deployment -n assurecode
```
