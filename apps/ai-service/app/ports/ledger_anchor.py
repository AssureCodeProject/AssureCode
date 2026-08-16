"""Contract anchoring: resolve the genesis hash H0 that a scope decision binds to.

Objective 3 requires scope requests to be judged "against the original hashed
contract", not against whatever the contract text happens to say today. That
needs a stable identifier for the contract version the decision was made under.

H0 is the `current_hash` of the first merkle_ledger row for a contract — the
row whose `previous_hash` is the literal 'GENESIS' sentinel (see
infra/migrations/postgres/V002__ledger.sql). Every later row chains from it, so
H0 names the contract as originally locked. Recording it alongside a scope
decision makes the decision independently checkable later: given H0 you can
replay the chain and confirm which contract text the guard actually compared
against.

Anchoring is not optional. If H0 cannot be resolved, the guard has no verifiable
contract to judge against and must say so rather than silently degrade into a
free-floating similarity check.

DO NOT DELETE THIS MODULE AS DEAD CODE. Nothing inside apps/ai-service imports
it, so a grep scoped to this service makes it look orphaned — it is not. The
real consumer is apps/scope-guard, which has no `app/ports/` package of its own
and reaches this file through `from app.ports.ledger_anchor import ...`; both
services declare a top-level package named `app`, so scope-guard's import
resolves here. Removing it breaks scope-guard's `/scope-check` at import time,
not at runtime.

That coupling is fragile and is the same package-name collision that forces CI
to run the two pytest suites from separate working directories (see
.github/workflows/production-ci-cd.yml). Moving this module into a shared
package, or giving scope-guard its own copy, would be an improvement; until then
this notice is the safeguard.
"""
from __future__ import annotations

from dataclasses import dataclass


class LedgerAnchorUnavailable(RuntimeError):
    """H0 could not be resolved for the contract."""


@dataclass(frozen=True)
class ContractAnchor:
    contract_id: str
    genesis_hash: str
    action_type: str
    created_at: str


class PostgresLedgerAnchor:
    """Reads H0 from merkle_ledger."""

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url
        self._conn = None

    def _connect(self):
        if self._conn is not None and not getattr(self._conn, "closed", False):
            return self._conn
        try:
            import psycopg
        except ImportError as err:  # pragma: no cover — packaging issue
            raise LedgerAnchorUnavailable("psycopg is not installed") from err
        try:
            self._conn = psycopg.connect(self._database_url, autocommit=True)
        except Exception as err:
            self._conn = None
            raise LedgerAnchorUnavailable(f"cannot connect to the ledger: {err}") from err
        return self._conn

    def genesis(self, contract_id: str) -> ContractAnchor:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                # Lowest ledger_id is the chain head. Selecting on
                # previous_hash = 'GENESIS' would be equivalent but breaks if a
                # contract were ever re-anchored; ordering is the safer read.
                cur.execute(
                    """
                    SELECT current_hash, action_type, created_at
                      FROM merkle_ledger
                     WHERE contract_id = %s
                     ORDER BY ledger_id ASC
                     LIMIT 1
                    """,
                    (contract_id,),
                )
                row = cur.fetchone()
        except Exception as err:
            self._conn = None
            raise LedgerAnchorUnavailable(f"ledger lookup failed: {err}") from err

        if row is None:
            raise LedgerAnchorUnavailable(
                f"contract {contract_id} has no ledger entries, so there is no genesis hash "
                "to anchor a scope decision to. Lock the contract before checking scope."
            )
        return ContractAnchor(
            contract_id=contract_id,
            genesis_hash=str(row[0]),
            action_type=str(row[1]),
            created_at=row[2].isoformat() if hasattr(row[2], "isoformat") else str(row[2]),
        )


class InMemoryLedgerAnchor:
    """Test double. Anchors must be registered explicitly — there is no
    default hash, because inventing one would defeat the purpose."""

    def __init__(self, anchors: dict[str, str] | None = None) -> None:
        self._anchors: dict[str, str] = dict(anchors or {})

    def register(self, contract_id: str, genesis_hash: str) -> None:
        self._anchors[contract_id] = genesis_hash

    def genesis(self, contract_id: str) -> ContractAnchor:
        if contract_id not in self._anchors:
            raise LedgerAnchorUnavailable(
                f"contract {contract_id} has no ledger entries, so there is no genesis hash "
                "to anchor a scope decision to. Lock the contract before checking scope."
            )
        return ContractAnchor(
            contract_id=contract_id,
            genesis_hash=self._anchors[contract_id],
            action_type="GENESIS",
            created_at="1970-01-01T00:00:00+00:00",
        )
