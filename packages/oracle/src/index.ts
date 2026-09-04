/**
 * Durable oracle state for the settlement decision.
 *
 * This lives in a package rather than inside the settlement worker because two
 * services need the verdict: the worker, which acts on it, and the gateway,
 * which reports it to the UI. A second copy of `evaluate()` in the gateway would
 * be a second definition of the money-releasing gate, free to drift from the
 * one that actually releases the money. The gateway only ever reads.
 *
 * The signals used to live in a module-level `Map`. That had two consequences
 * neither of which is acceptable for something that releases money:
 *
 *   * a restart between the audit and the settlement request silently reset
 *     every signal to false, so the contract could never settle; and
 *   * with more than one replica, each process saw only the events its own
 *     subscription received, so whether a contract settled depended on which
 *     worker happened to get which message.
 *
 * Oracle state is a property of the contract, so it lives with the contract.
 *
 * The scope signal is deliberately not stored. It is derived from scope_checks
 * on read — see `evaluate()` — because a stored copy can disagree with the
 * decisions it summarises, and the previous stored version did exactly that.
 */
import pg from 'pg';

export interface OracleSignals {
  astPassed: boolean;
  testsPassed: boolean;
  securityPassed: boolean;
  scopePassed: boolean;
  trustScore: number | null;
  criticalVulns: number | null;
}

/** The settlement gate Objective 4 specifies, plus the four CI signals. */
export interface OracleVerdict {
  approved: boolean;
  signals: OracleSignals;
  /** Human-readable reasons the contract failed. Empty when approved. */
  blockers: string[];
}

export const TRUST_SCORE_THRESHOLD = 85;

export class OracleStore {
  constructor(private readonly pool: pg.Pool) {}

  /** Record the three CI-derived signals from an AUDIT_COMPLETED event. */
  async recordAudit(
    contractId: string,
    signals: { astPassed: boolean; testsPassed: boolean; securityPassed: boolean },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO oracle_state (contract_id, ast_passed, tests_passed, security_passed, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (contract_id) DO UPDATE
         SET ast_passed = EXCLUDED.ast_passed,
             tests_passed = EXCLUDED.tests_passed,
             security_passed = EXCLUDED.security_passed,
             updated_at = now()`,
      [contractId, signals.astPassed, signals.testsPassed, signals.securityPassed],
    );
  }

  /**
   * Record the trust score from an XAI_SCORED event.
   *
   * The write is monotonic in `scored_at`: a score is only applied if it is at
   * least as recent as the one already stored. Two audits in quick succession
   * produce two XAI_SCORED events, and under Redis Streams that is harmless
   * because a stream is FIFO and the poll loop is sequential. Under Kafka,
   * publish() supplies no partition key, so the two can land on different
   * partitions and be consumed out of order -- leaving oracle_state holding the
   * older score while the newer one is silently discarded. This is the same
   * shape as the escrow status guard in apps/settlement-worker: an event that
   * arrives late must not drag state backwards.
   *
   * `scoredAt` comes from the event payload rather than the clock here, so the
   * comparison is between two producer timestamps and does not depend on when
   * each consumer happened to run.
   */
  async recordScore(
    contractId: string,
    trustScore: number,
    criticalVulns: number,
    scoredAt?: string | Date | null,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO oracle_state (contract_id, trust_score, critical_vulns, scored_at, updated_at)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), now())
       ON CONFLICT (contract_id) DO UPDATE
         SET trust_score = EXCLUDED.trust_score,
             critical_vulns = EXCLUDED.critical_vulns,
             scored_at = EXCLUDED.scored_at,
             updated_at = now()
         WHERE oracle_state.scored_at IS NULL
            OR oracle_state.scored_at <= EXCLUDED.scored_at`,
      [contractId, trustScore, criticalVulns, scoredAt ?? null],
    );
  }

  /**
   * Read the current state and decide.
   *
   * A missing row is not a permissive default: with no oracle_state row every
   * boolean is false and the trust score is null, so the contract is blocked
   * and the blockers say why.
   */
  async evaluate(contractId: string): Promise<OracleVerdict> {
    const stateRes = await this.pool.query(
      `SELECT ast_passed, tests_passed, security_passed, trust_score, critical_vulns
         FROM oracle_state WHERE contract_id = $1`,
      [contractId],
    );

    // Derived scope signal. `rejected = 0` passes, including when no checks
    // exist at all — a contract with no chat traffic has made no out-of-scope
    // request. This mirrors how the trust score treats an unmeasured scope
    // term as neutral rather than as a pass or a failure, and it carries the
    // same stated weakness: avoiding the chat channel avoids the signal.
    const scopeRes = await this.pool.query(
      `SELECT count(*) FILTER (WHERE NOT allowed) AS rejected, count(*) AS total
         FROM scope_checks WHERE contract_id = $1`,
      [contractId],
    );
    const rejected = Number(scopeRes.rows[0]?.rejected ?? 0);

    const row = stateRes.rows[0];
    const signals: OracleSignals = {
      astPassed: Boolean(row?.ast_passed),
      testsPassed: Boolean(row?.tests_passed),
      securityPassed: Boolean(row?.security_passed),
      scopePassed: rejected === 0,
      trustScore: row?.trust_score == null ? null : Number(row.trust_score),
      criticalVulns: row?.critical_vulns == null ? null : Number(row.critical_vulns),
    };

    const blockers: string[] = [];
    if (!row) blockers.push('no audit or score has been recorded for this contract');
    if (!signals.astPassed) blockers.push('AST maintainability signal not satisfied');
    if (!signals.testsPassed) blockers.push('hidden test suite did not fully pass');
    if (!signals.securityPassed) blockers.push('security scan reported findings');
    if (!signals.scopePassed) blockers.push(`${rejected} scope check(s) were rejected`);

    // Objective 4's gate, verbatim: trustScore >= 85 && criticalVulns === 0.
    // null is "not yet scored" and must block — an unscored contract is not a
    // contract that scored well.
    if (signals.trustScore === null) {
      blockers.push('no trust score recorded (XAI_SCORED never received)');
    } else if (signals.trustScore < TRUST_SCORE_THRESHOLD) {
      blockers.push(`trust score ${signals.trustScore} is below the ${TRUST_SCORE_THRESHOLD} threshold`);
    }
    if (signals.criticalVulns === null) {
      blockers.push('critical vulnerability count unknown');
    } else if (signals.criticalVulns > 0) {
      blockers.push(`${signals.criticalVulns} critical vulnerability(ies) present`);
    }

    return { approved: blockers.length === 0, signals, blockers };
  }

  /**
   * The held payment for this contract — what the settlement worker captures.
   *
   * Selects on 'AUTHORIZED', not 'PENDING'. Under Razorpay's two-phase flow the
   * order is created before anyone pays it, and that order sits at 'PENDING'
   * with a NULL payment_id. Matching 'PENDING' — which is what this did — meant
   * the oracle would hand the worker an escrow no customer had funded, and the
   * worker would attempt to capture money that was never authorised. Only
   * 'AUTHORIZED' means the funds are actually held.
   *
   * The NOT NULL guard on payment_id is belt-and-braces: nothing should reach
   * 'AUTHORIZED' without one, and a capture call with a null id would fail
   * anyway, but failing to *find* a payment is a far clearer outcome than
   * calling Razorpay with garbage.
   */
  async findEscrowPayment(
    contractId: string,
  ): Promise<{ paymentId: string; amountMinor: number; currency: string } | null> {
    const res = await this.pool.query(
      `SELECT payment_id, amount_cents, currency FROM escrow
        WHERE contract_id = $1 AND status = 'AUTHORIZED' AND payment_id IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [contractId],
    );
    if (res.rowCount === 0) return null;
    return {
      paymentId: res.rows[0].payment_id,
      // `amount_cents` holds minor units — paise for INR. The column name
      // predates the provider change; see V014__razorpay_escrow.sql.
      amountMinor: Number(res.rows[0].amount_cents),
      currency: res.rows[0].currency ?? 'INR',
    };
  }
}
