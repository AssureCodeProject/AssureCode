#!/usr/bin/env python3
"""
Offline structural validation for infra/k8s/.

── Why this exists ──────────────────────────────────────────────────────
The CI pipeline validated manifests with:

    kubectl apply --dry-run=client -f infra/k8s/

That does not work without a cluster. `--dry-run=client` still contacts the
API server to resolve resource kinds and download the OpenAPI schema, so on a
runner with no cluster it fails every file with "dial tcp [::1]:8080:
connection refused" — including with `--validate=false`. The step could not
have been passing.

Schema validation proper is kubeconform's job and runs in CI against the
upstream JSON schemas. This script is the half that needs no network and no
extra binary: it parses every document, checks the fields Kubernetes requires,
and enforces the invariants specific to this repository.

Usage:
    python scripts/validate-k8s.py [--dir infra/k8s]

Exits non-zero on any error.
"""

from __future__ import annotations

import argparse
import sys
from collections import Counter
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is required: pip install pyyaml")


# Workloads whose pods must not silently run as root. Datastore images
# (postgres, redis, neo4j) manage their own users and are exempt.
WORKLOAD_KINDS = {"Deployment", "StatefulSet", "Job"}
DATASTORE_NAMES = {"postgres", "redis", "neo4j"}

# Values that must never appear as a real secret. Mirrors
# PLACEHOLDER_SECRET_VALUES in packages/config/src/secrets.ts — the base
# manifest is *expected* to carry REPLACE_ME, so this checks the inverse:
# that no plausibly-real credential has been committed.
PLACEHOLDER = "REPLACE_ME"


def load_documents(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [doc for doc in yaml.safe_load_all(handle) if doc]


def check_document(doc: dict, path: Path, errors: list[str]) -> None:
    kind = doc.get("kind")
    meta = doc.get("metadata") or {}
    name = meta.get("name")

    if not kind:
        errors.append(f"{path}: document has no `kind`")
        return
    if not name:
        errors.append(f"{path}: {kind} has no `metadata.name`")
        return
    if not doc.get("apiVersion"):
        errors.append(f"{path}: {kind}/{name} has no `apiVersion`")

    # Everything except the Namespace object itself belongs to the namespace.
    if kind != "Namespace" and not meta.get("namespace"):
        errors.append(f"{path}: {kind}/{name} has no `metadata.namespace`")

    if kind in WORKLOAD_KINDS:
        check_workload(doc, kind, name, path, errors)

    if kind == "Secret":
        check_secret(doc, name, path, errors)


def pod_spec_of(doc: dict, kind: str) -> dict:
    spec = doc.get("spec") or {}
    if kind == "Job":
        return (spec.get("template") or {}).get("spec") or {}
    return (spec.get("template") or {}).get("spec") or {}


def check_workload(doc: dict, kind: str, name: str, path: Path, errors: list[str]) -> None:
    pod = pod_spec_of(doc, kind)
    containers = pod.get("containers") or []

    if not containers:
        errors.append(f"{path}: {kind}/{name} has no containers")
        return

    if name not in DATASTORE_NAMES:
        security = pod.get("securityContext") or {}
        if not security.get("runAsNonRoot"):
            errors.append(
                f"{path}: {kind}/{name} does not set "
                "`spec.template.spec.securityContext.runAsNonRoot: true`"
            )

    for container in containers:
        cname = container.get("name", "<unnamed>")
        label = f"{kind}/{name} container {cname}"

        # Unbounded pods are how one workload starves every other on the node.
        resources = container.get("resources") or {}
        if not resources.get("requests"):
            errors.append(f"{path}: {label} has no resource requests")
        if not resources.get("limits"):
            errors.append(f"{path}: {label} has no resource limits")

        # A Job runs to completion; probes only make sense for long-lived pods.
        if kind != "Job" and not container.get("livenessProbe"):
            errors.append(f"{path}: {label} has no livenessProbe")

        image = container.get("image", "")
        if image and ":" not in image:
            errors.append(f"{path}: {label} image `{image}` has no tag")


def check_secret(doc: dict, name: str, path: Path, errors: list[str]) -> None:
    """
    The tracked base Secret must hold only placeholders.

    infra/k8s/01-configmap-secrets.yaml previously carried a live-looking
    JWT_SECRET and database credentials in git. This is what stops that from
    silently coming back: every value in a tracked Secret must be REPLACE_ME
    or empty. Real values belong in an overlay (see infra/k8s/overlays/).
    """
    for key, value in (doc.get("stringData") or {}).items():
        if not isinstance(value, str):
            continue
        stripped = value.strip()
        if stripped and stripped != PLACEHOLDER and not _is_template(stripped):
            errors.append(
                f"{path}: Secret/{name} key `{key}` holds a non-placeholder value. "
                "Committed secrets must be REPLACE_ME; put real values in an overlay."
            )


def _is_template(value: str) -> bool:
    """Overlay templates use obvious stand-ins rather than REPLACE_ME."""
    return value.startswith(("postgresql://USER", "redis://HOST", "bolt://HOST"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default="infra/k8s", type=Path)
    args = parser.parse_args()

    base = args.dir
    if not base.is_dir():
        print(f"No such directory: {base}", file=sys.stderr)
        return 1

    errors: list[str] = []

    # Non-recursive, matching how the base is applied. Overlays deliberately
    # redefine the same object names and are validated separately below.
    base_files = sorted(base.glob("*.yaml"))
    identities: Counter = Counter()

    for path in base_files:
        try:
            docs = load_documents(path)
        except yaml.YAMLError as exc:
            errors.append(f"{path}: YAML parse error: {exc}")
            continue
        for doc in docs:
            check_document(doc, path, errors)
            meta = doc.get("metadata") or {}
            identities[(doc.get("kind"), meta.get("name"), meta.get("namespace"))] += 1

    # Two objects of the same kind and name in one apply set is an error:
    # whichever is applied last silently wins.
    for (kind, name, _ns), count in identities.items():
        if count > 1:
            errors.append(f"{base}: {kind}/{name} is defined {count} times in the base")

    # Overlays are parsed for syntax and secret-hygiene only. They are meant
    # to collide with base object names — that is how they override.
    for path in sorted(base.glob("overlays/**/*.yaml")):
        try:
            for doc in load_documents(path):
                if doc.get("kind") == "Secret":
                    check_secret(doc, (doc.get("metadata") or {}).get("name", "?"), path, errors)
        except yaml.YAMLError as exc:
            errors.append(f"{path}: YAML parse error: {exc}")

    doc_count = sum(identities.values())
    if errors:
        print(f"{len(errors)} problem(s) in {len(base_files)} base file(s):\n", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1

    # ASCII only: this prints to a cp1252 console on Windows, where an em dash
    # comes out as a replacement character.
    print(f"OK - {doc_count} documents across {len(base_files)} base manifests.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
