#!/usr/bin/env python3
"""Phase 4 (C1) live verification — sequential scope-drift detection.

The plan's gate for this phase:

    synthetic drift sequence: alarm fires after onset
    pure in-scope sequence:   no alarm
    empirical false-alarm rate over 1000 in-scope sequences <= delta

The unit tests cover those against synthetic residuals. This script covers what
they cannot: that the detector runs on residuals read back out of live
PostgreSQL, that the per-message scope guard genuinely misses the gradual case
the detector catches, and that the assessment is anchored in the Merkle ledger.

    python tools/verify_phase4_live.py

Everything is namespaced under a run-specific contract id and deleted at the
end, so it is safe against a shared database.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "ai-service"))
sys.path.insert(0, str(REPO_ROOT / "apps" / "scope-guard"))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _load_dotenv() -> None:
    env_path = REPO_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

from app.ports.scope_log import PostgresScopeLog, ScopeDecisionRecord  # noqa: E402
from app.services.drift_detector import ConformalDriftDetector  # noqa: E402

CA_BUNDLE = REPO_ROOT / "infra" / "certs" / "supabase-ca-bundle.crt"
THRESHOLD = float(os.environ.get("SCOPE_SIMILARITY_THRESHOLD", "0.2731"))
DELTA = 0.05
EPSILON = 0.92

failures: list[str] = []
checks = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global checks
    checks += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        failures.append(label)


def section(title: str) -> None:
    print(f"\n{title}")
    print("-" * len(title))


def connect():
    import psycopg

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is not set.")
    kwargs: dict[str, object] = {"autocommit": True, "connect_timeout": 10}
    if "supabase.co" in url and CA_BUNDLE.exists():
        kwargs["sslmode"] = "verify-full"
        kwargs["sslrootcert"] = str(CA_BUNDLE)
    return psycopg.connect(url, **kwargs)


def main() -> int:
    rng = np.random.default_rng(20260804)
    contract_id = f"VERIFY-P4-{uuid.uuid4().hex[:8].upper()}"

    print("=" * 78)
    print("  Phase 4 live verification — C1 sequential scope-drift detection")
    print("=" * 78)
    print(f"  contract: {contract_id}")

    # Calibration: synthetic, and labelled synthetic everywhere it surfaces.
    # T2 does not exist (Phase 7), so no number below is a publishable
    # false-alarm rate — it verifies the arithmetic, not the field behaviour.
    calibration = [float(x) for x in rng.beta(2.0, 8.0, size=400)]

    conn = connect()
    try:
        section("0. Preflight")
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
        check("PostgreSQL reachable", True)
        check(
            "calibration set is synthetic and labelled as such",
            True,
            f"n={len(calibration)} — T2 (Phase 7) does not exist, so delta is nominal",
        )

        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO contracts (contract_id, client_id, freelancer_id, title,
                                       requirements, budget_cents, deadline, status)
                VALUES (%s, 'verify-client', 'verify-freelancer', 'Phase 4 verification',
                        'Verification fixture.', 250000, '2026-12-31', 'IN_PROGRESS')
                """,
                (contract_id,),
            )
            cur.execute(
                "SELECT append_ledger(%s, %s, %s)",
                (contract_id, "GENESIS", '{"source":"verify_phase4_live"}'),
            )
            cur.execute(
                "SELECT current_hash FROM merkle_ledger WHERE contract_id=%s ORDER BY ledger_id LIMIT 1",
                (contract_id,),
            )
            genesis_hash = cur.fetchone()[0]
        check("fixture contract anchored", len(genesis_hash) == 64)

        # ── 1. The gradual-drift sequence ─────────────────────────────────
        section("1. Gradual drift that every per-message check individually allows")

        log = PostgresScopeLog(database_url=os.environ["DATABASE_URL"])
        onset = 25
        similarities: list[float] = []

        for i in range(onset):
            # Comfortably in scope.
            sim = float(np.clip(rng.normal(0.72, 0.05), 0.0, 1.0))
            similarities.append(sim)

        for step in range(70):
            # Creeps down toward, but stays above, the shipped threshold.
            sim = float(np.clip(rng.normal(0.68 - 0.0045 * step, 0.03), 0.0, 1.0))
            similarities.append(sim)

        for i, sim in enumerate(similarities):
            log.record(
                ScopeDecisionRecord(
                    contract_id=contract_id,
                    sender="client",
                    message=f"message {i}",
                    allowed=sim >= THRESHOLD,
                    similarity=sim,
                    threshold=THRESHOLD,
                    genesis_hash=genesis_hash,
                )
            )

        adherence = log.adherence(contract_id)
        check(
            "the per-message scope guard allowed EVERY message",
            adherence.allowed == adherence.total,
            f"{adherence.allowed}/{adherence.total} allowed, all above threshold {THRESHOLD}",
        )
        check(
            "so per-message scope adherence reports a clean contract",
            adherence.ratio == 1.0,
            "this is the blind spot C1 exists to cover",
        )

        # ── 2. The detector reads the same recorded sequence ──────────────
        section("2. The detector runs on residuals read back from PostgreSQL")

        residuals = log.residuals(contract_id)
        check(
            "residuals recovered from scope_checks",
            len(residuals) == len(similarities),
            f"{len(residuals)} residuals, s_t = 1 - similarity",
        )
        check(
            "they match the recorded similarities",
            all(abs((1.0 - s) - r) < 1e-6 for s, r in zip(similarities, residuals)),
        )

        detector = ConformalDriftDetector(
            contract_centroid=[1.0],
            calibration_residuals=calibration,
            delta=DELTA,
            epsilon=EPSILON,
            calibration_is_synthetic=True,
        )
        for r in residuals:
            detector.observe_residual(r)

        check(
            "the detector ALARMS on the drift the per-message check missed",
            detector.state.alarmed,
            f"alarm at message {detector.state.alarmed_at} of {len(residuals)}",
        )
        check(
            "the alarm does not predate the drift onset",
            detector.state.alarmed_at is not None and detector.state.alarmed_at >= onset,
            f"onset={onset}, alarm={detector.state.alarmed_at}",
        )
        delay = detector.detection_delay(onset)
        check("detection delay is reported in messages", delay is not None and delay > 0, f"{delay} messages")
        check(
            "the coverage note states the guarantee is synthetic",
            "SYNTHETIC" in detector.coverage_note,
            detector.coverage_note[:70] + "…",
        )

        # ── 3. A clean contract does not alarm ────────────────────────────
        section("3. A genuinely in-scope contract does not alarm")

        clean_id = f"{contract_id}-CLEAN"
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO contracts (contract_id, client_id, title, requirements,
                                       budget_cents, deadline, status)
                VALUES (%s, 'verify-client', 'Phase 4 clean', 'Fixture.', 1000, '2026-12-31', 'IN_PROGRESS')
                """,
                (clean_id,),
            )
            cur.execute(
                "SELECT append_ledger(%s, %s, %s)",
                (clean_id, "GENESIS", '{"source":"verify_phase4_live_clean"}'),
            )

        for i in range(95):
            sim = float(np.clip(1.0 - rng.beta(2.0, 8.0), 0.0, 1.0))
            log.record(
                ScopeDecisionRecord(
                    contract_id=clean_id,
                    sender="client",
                    message=f"clean {i}",
                    allowed=sim >= THRESHOLD,
                    similarity=sim,
                    threshold=THRESHOLD,
                    genesis_hash=genesis_hash,
                )
            )

        clean_detector = ConformalDriftDetector(
            contract_centroid=[1.0],
            calibration_residuals=calibration,
            delta=DELTA,
            epsilon=EPSILON,
            calibration_is_synthetic=True,
        )
        for r in log.residuals(clean_id):
            clean_detector.observe_residual(r)

        check(
            "no alarm on an in-scope sequence of the same length",
            not clean_detector.state.alarmed,
            f"{len(clean_detector.state.steps)} messages, log M = "
            f"{clean_detector.state.steps[-1].log_martingale:.3f} "
            f"(threshold {clean_detector.log_alarm_threshold:.3f})",
        )

        # ── 4. The assessment is anchored ─────────────────────────────────
        section("4. The assessment is anchored in the Merkle ledger")

        record = detector.ledger_record(contract_id, genesis_hash)
        check("the record names the contract version it judged", record["genesisHash"] == genesis_hash)
        check(
            "it carries the statistics that produced the decision",
            all(record[k] is not None for k in ("logMartingale", "pValue", "residual", "delta", "calibrationN")),
            "so a disputed flag can be recomputed, not just asserted",
        )
        check(
            "it declares the calibration synthetic",
            record["calibrationIsSynthetic"] is True,
            "the limitation travels with the evidence",
        )

        # Anchor it the way the gateway route does, through append_ledger.
        # The canonical bytes here are produced by json.dumps with sorted keys
        # and no whitespace, which coincides with RFC 8785 for this payload
        # (strings, bools, ints, and floats already rounded to 6 places).
        canonical = json.dumps(record, sort_keys=True, separators=(",", ":"))
        with conn.cursor() as cur:
            cur.execute(
                "SELECT append_ledger(%s, %s, %s)",
                (contract_id, "SCOPE_DRIFT_ASSESSED", canonical),
            )
            cur.execute(
                """
                SELECT payload_canonical, hash_version FROM merkle_ledger
                 WHERE contract_id = %s AND action_type = 'SCOPE_DRIFT_ASSESSED'
                 ORDER BY ledger_id DESC LIMIT 1
                """,
                (contract_id,),
            )
            row = cur.fetchone()
        check("the assessment was appended to the chain", row is not None)
        check("stored verbatim at hash_version 2", row[0] == canonical and row[1] == 2)

        # ── 5. Refusals ───────────────────────────────────────────────────
        section("5. The detector refuses rather than inventing a guarantee")

        from app.services.drift_detector import NotCalibrated

        refused = False
        try:
            ConformalDriftDetector(contract_centroid=[1.0], calibration_residuals=[])
        except NotCalibrated:
            refused = True
        check(
            "an uncalibrated detector refuses to run",
            refused,
            "no default calibration set — delta would describe nothing",
        )

    finally:
        with conn.cursor() as cur:
            for cid in (f"{contract_id}-CLEAN", contract_id):
                cur.execute("DELETE FROM scope_checks WHERE contract_id = %s", (cid,))
                cur.execute("DELETE FROM merkle_ledger WHERE contract_id = %s", (cid,))
                cur.execute("DELETE FROM contracts WHERE contract_id = %s", (cid,))
        conn.close()

    print("\n" + "=" * 78)
    if not failures:
        print(f"  ALL {checks} CHECKS PASSED")
        print("  Gradual drift that every per-message check allowed was detected, anchored to H0.")
        print("  NOTE: calibration is synthetic. The delta reported is nominal, not measured —")
        print("  a publishable false-alarm rate needs the T2 set (Phase 7).")
        return 0
    print(f"  {len(failures)} of {checks} CHECKS FAILED")
    for f in failures:
        print(f"    - {f}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
