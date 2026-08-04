"""Durable log of scope decisions, and the adherence figure derived from it.

Why this exists
---------------
The scope guard computed a decision, returned it, and forgot it. That left two
holes:

  * Objective 3 claims scope decisions are anchored to the hashed contract and
    therefore auditable. A decision nobody recorded cannot be audited.
  * Objective 4's trust score has a fourth term. It used to be `chat_sentiment`,
    a number no component ever produced — the gateway posted the literal 0.95.
    Replacing it with real scope adherence requires the decisions to exist
    somewhere durable first.

What "adherence" means, and what it does not
--------------------------------------------
Adherence is `allowed / total` over the scope checks recorded for a contract.
It is a measurement of the client's requests, not of the freelancer's work: a
low figure means the client repeatedly asked for things outside the agreed
scope. It is included in the trust score because a contract under sustained
scope pressure is one where delivered work and agreed work have diverged, which
is what the score is trying to capture.

`total == 0` is reported as *unmeasured*, never as 1.0. A contract with no chat
traffic has not demonstrated perfect adherence; it has demonstrated nothing.
Callers must handle the two cases differently — see
`app/routes/xai.py`, which renormalises the remaining weights and says so in its
justification rather than substituting a flattering default.

Known limitation, stated because it is exploitable: since an unmeasured scope
term is dropped rather than penalised, a participant who avoids the chat channel
entirely avoids the term. Closing that requires treating silence as evidence,
which per-message thresholding cannot do.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


class ScopeLogUnavailable(RuntimeError):
    """The scope decision log could not be reached or written."""


@dataclass(frozen=True)
class ScopeDecisionRecord:
    contract_id: str
    sender: str
    message: str
    allowed: bool
    similarity: float
    threshold: float
    genesis_hash: str


@dataclass(frozen=True)
class ScopeAdherence:
    """Allowed-vs-total over a contract's recorded scope checks."""

    contract_id: str
    allowed: int
    total: int

    @property
    def measured(self) -> bool:
        return self.total > 0

    @property
    def ratio(self) -> float | None:
        """Adherence in [0, 1], or None when nothing has been measured.

        None rather than a default is deliberate: every caller is forced to
        decide what to do about missing evidence instead of silently inheriting
        a value that looks like a measurement.
        """
        if self.total == 0:
            return None
        return self.allowed / self.total


class PostgresScopeLog:
    """Writes to and reads from the scope_checks table (V008)."""

    # Bounded, because libpq's default is to wait indefinitely. Without this the
    # trust score endpoint hung for as long as the client would hold the socket
    # open — measured at over 60 seconds against an unresponsive Supabase host —
    # rather than raising ScopeLogUnavailable and being turned into the 503 the
    # callers already handle. An unreachable log has to fail, and failing has to
    # take a bounded amount of time or it is indistinguishable from working.
    CONNECT_TIMEOUT_SECONDS = int(os.environ.get("SCOPE_LOG_CONNECT_TIMEOUT", "10"))

    def __init__(self, database_url: str) -> None:
        self._database_url = database_url
        self._conn = None

    def _connect(self):
        if self._conn is not None and not getattr(self._conn, "closed", False):
            return self._conn
        try:
            import psycopg
        except ImportError as err:  # pragma: no cover — packaging issue
            raise ScopeLogUnavailable("psycopg is not installed") from err
        try:
            self._conn = psycopg.connect(
                self._database_url,
                autocommit=True,
                connect_timeout=self.CONNECT_TIMEOUT_SECONDS,
            )
        except Exception as err:
            self._conn = None
            raise ScopeLogUnavailable(f"cannot connect to the scope log: {err}") from err
        return self._conn

    def record(self, decision: ScopeDecisionRecord) -> int:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO scope_checks
                        (contract_id, sender, message, allowed, similarity, threshold, genesis_hash)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING check_id
                    """,
                    (
                        decision.contract_id,
                        decision.sender,
                        decision.message,
                        decision.allowed,
                        float(decision.similarity),
                        float(decision.threshold),
                        decision.genesis_hash,
                    ),
                )
                return int(cur.fetchone()[0])
        except Exception as err:
            self._conn = None
            raise ScopeLogUnavailable(f"failed to record scope decision: {err}") from err

    def adherence(self, contract_id: str) -> ScopeAdherence:
        conn = self._connect()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT count(*) FILTER (WHERE allowed), count(*)
                      FROM scope_checks
                     WHERE contract_id = %s
                    """,
                    (contract_id,),
                )
                row = cur.fetchone()
        except Exception as err:
            self._conn = None
            raise ScopeLogUnavailable(f"failed to read scope adherence: {err}") from err
        return ScopeAdherence(contract_id=contract_id, allowed=int(row[0]), total=int(row[1]))


class InMemoryScopeLog:
    """Process-local log for tests and offline runs."""

    def __init__(self) -> None:
        self._rows: list[ScopeDecisionRecord] = []

    def record(self, decision: ScopeDecisionRecord) -> int:
        self._rows.append(decision)
        return len(self._rows)

    def adherence(self, contract_id: str) -> ScopeAdherence:
        rows = [r for r in self._rows if r.contract_id == contract_id]
        return ScopeAdherence(
            contract_id=contract_id,
            allowed=sum(1 for r in rows if r.allowed),
            total=len(rows),
        )
