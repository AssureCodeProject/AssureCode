/** Razorpay payment + payout webhooks. */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getCorrelationId } from '@assurecode/config';
import { paymentEntityOf, orderEntityOf, payoutEntityOf } from '@assurecode/razorpay-adapter';
import { EVENT_TOPICS } from '@assurecode/shared';
import { dbPool, logger, eventBus, payments, ledgerClient, recordPaymentEvent } from '../context.js';

export function registerWebhookRoutes(server: FastifyInstance): void {
  /**
   * Razorpay's authoritative confirmation of a payment's state.
   *
   * Public by virtue of the `/webhooks/` prefix in the auth plugin's allow-list —
   * the HMAC *is* the authentication here, so a JWT check would only reject a
   * caller that has no way to hold one.
   *
   * Two Razorpay-specific facts shape this handler:
   *
   *   1. The event id is not in the body. Unlike Stripe, Razorpay carries it in
   *      the `x-razorpay-event-id` header, and it is the only stable dedupe key.
   *   2. Deliveries are retried until Razorpay gets a 2xx, so the same event
   *      arrives more than once as a matter of course — not as an anomaly. Every
   *      write below is therefore either guarded on current status or protected
   *      by the unique index on payment_events.provider_event_id.
   *
   * The route answers 200 for anything it has authenticated, including events it
   * does not act on. Answering non-2xx would make Razorpay retry an event we have
   * already handled correctly.
   */
  server.post<{
    Reply: { received: boolean } | { error: string };
  }>('/webhooks/razorpay', async (request, reply) => {
    const signature = request.headers['x-razorpay-signature'] ?? '';
    const providerEventId = (request.headers['x-razorpay-event-id'] as string) || null;

    // The bytes as Razorpay sent them, captured by the content-type parser above.
    // Re-serialising the parsed body here is what made every real signature fail
    // under the previous provider.
    const rawBody = (request as any).rawBody as Buffer | undefined;
    // `rawBody.length === 0`, not just `!rawBody`: an empty Buffer is truthy, so
    // the bare guard let a zero-byte request through to signature verification
    // and answered 401 "Invalid signature" for what is really a malformed
    // request. Both reject, but only one of them tells the truth about why.
    if (!rawBody || rawBody.length === 0) {
      return reply.status(400).send({ error: 'Empty request body' });
    }

    const verification = await payments.verifyWebhook(rawBody, String(signature));

    if (!verification.valid) {
      logger.warn({ error: verification.error }, 'Razorpay webhook signature verification failed');
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    const event = verification.event!;

    // Checked first, ahead of the payment/order resolution below: a payout
    // webhook carries neither an orderId nor a paymentId, so it would
    // otherwise fall straight into the `!orderId && !paymentId` early-return
    // a few lines down and be silently dropped. It also resolves through
    // settlements.payout_id, not the escrow table — a payout has no escrow
    // row of its own.
    const payoutEntity = payoutEntityOf(event);
    if (payoutEntity) {
      const payoutId = payoutEntity.id ? String(payoutEntity.id) : null;
      logger.info({ type: event.event, payoutId, providerEventId }, 'Razorpay payout webhook verified');
      if (!payoutId) {
        return reply.status(200).send({ received: true });
      }

      const settlementRow = await dbPool.query(
        `SELECT contract_id FROM settlements WHERE payout_id = $1`,
        [payoutId],
      );
      if (settlementRow.rowCount === 0) {
        logger.warn({ payoutId }, 'Razorpay payout webhook for an unknown payout; ignoring');
        return reply.status(200).send({ received: true });
      }
      const payoutContractId: string = settlementRow.rows[0].contract_id;

      const audit = await recordPaymentEvent({
        contractId: payoutContractId,
        eventType: event.event,
        amountMinor: Number(payoutEntity.amount ?? 0),
        paymentId: payoutId,
        providerEventId,
        payload: { source: 'webhook', status: payoutEntity.status ?? null },
      });
      if (providerEventId && !audit.inserted) {
        logger.info(
          { providerEventId, contractId: payoutContractId },
          'Razorpay payout webhook already processed; ignoring redelivery',
        );
        return reply.status(200).send({ received: true });
      }

      // 'processing' arrives synchronously from initiatePayout itself and is
      // already recorded before any webhook can reach us — only the terminal
      // states are worth a write here. Anything else (a status this webhook
      // handler doesn't recognize) is logged via recordPaymentEvent above and
      // otherwise ignored, matching the 'payment.captured' branch below.
      const finalPayoutStatus =
        event.event === 'payout.processed'
          ? 'COMPLETED'
          : event.event === 'payout.failed' ||
              event.event === 'payout.reversed' ||
              // A distinct real terminal-failure state — e.g. malformed
              // beneficiary details — confirmed via razorpay.com/docs/webhooks/payouts/.
              event.event === 'payout.rejected'
            ? 'FAILED'
            : null;
      if (finalPayoutStatus) {
        await dbPool.query(
          `UPDATE settlements
              SET payout_status = $1, payout_failure_reason = $2, payout_updated_at = NOW()
            WHERE payout_id = $3`,
          [finalPayoutStatus, payoutEntity.failure_reason ?? null, payoutId],
        );
        logger.info(
          { contractId: payoutContractId, payoutId, status: finalPayoutStatus },
          'Payout status updated from webhook',
        );
      }

      return reply.status(200).send({ received: true });
    }

    const paymentEntity = paymentEntityOf(event);
    const orderEntity = orderEntityOf(event);

    const paymentId = paymentEntity?.id ? String(paymentEntity.id) : null;
    const orderId = paymentEntity?.order_id
      ? String(paymentEntity.order_id)
      : orderEntity?.id
        ? String(orderEntity.id)
        : null;

    logger.info({ type: event.event, paymentId, orderId, providerEventId }, 'Razorpay webhook verified');

    if (!orderId && !paymentId) {
      return reply.status(200).send({ received: true });
    }

    // Resolve the contract from our own escrow row rather than from the event's
    // notes. Razorpay copies order notes onto a payment inconsistently, and the
    // escrow table is the record we actually wrote.
    const escrowRow = await dbPool.query(
      `SELECT contract_id, order_id, amount_cents, currency, status FROM escrow
        WHERE order_id = $1 OR payment_id = $2
        LIMIT 1`,
      [orderId, paymentId],
    );

    if (escrowRow.rowCount === 0) {
      logger.warn({ orderId, paymentId }, 'Razorpay webhook for an unknown escrow; ignoring');
      return reply.status(200).send({ received: true });
    }

    const contractId: string = escrowRow.rows[0].contract_id;
    const amountMinor = Number(escrowRow.rows[0].amount_cents);
    const correlationId = getCorrelationId() || randomUUID();

    // The dedupe gate, and the reason it comes before any other write: the unique
    // index on provider_event_id means a redelivery conflicts and inserts nothing,
    // so `inserted === false` identifies a repeat atomically. Checking by reading
    // first would race two concurrent deliveries of the same event straight past
    // each other and append the ledger entry twice.
    const audit = await recordPaymentEvent({
      contractId,
      eventType: event.event,
      amountMinor,
      orderId: escrowRow.rows[0].order_id,
      paymentId,
      providerEventId,
      payload: { source: 'webhook', status: paymentEntity?.status ?? null },
    });

    if (providerEventId && !audit.inserted) {
      logger.info(
        { providerEventId, contractId },
        'Razorpay webhook already processed; ignoring redelivery',
      );
      return reply.status(200).send({ received: true });
    }

    if (event.event === 'payment.authorized' || event.event === 'order.paid') {
      const updated = await dbPool.query(
        `UPDATE escrow
            SET status = 'AUTHORIZED', payment_id = $1, authorized_at = COALESCE(authorized_at, NOW())
          WHERE order_id = $2 AND status = 'PENDING'
          RETURNING order_id`,
        [paymentId, escrowRow.rows[0].order_id],
      );

      // Only append to the ledger if this call is what made the transition. The
      // /escrow/verify route may have got there first, and a hash chain with two
      // entries for one event is a chain that misreports what happened.
      if (updated.rowCount === 1) {
        await ledgerClient.append(contractId, 'ESCROW_AUTHORIZED', {
          orderId: escrowRow.rows[0].order_id,
          paymentId,
          amountMinor,
          currency: escrowRow.rows[0].currency,
        });
        // BUG-002: ESCROW_LOCKED, not CONTRACT_LOCKED — payment webhooks must not
        // re-trigger the contract-lock subscriber flow and corrupt ledger state.
        await eventBus.publish(
          EVENT_TOPICS.ESCROW_LOCKED,
          { contractId, orderId: escrowRow.rows[0].order_id, paymentId, type: 'payment.authorized' },
          correlationId,
        );
      }
    } else if (event.event === 'payment.failed') {
      const updated = await dbPool.query(
        `UPDATE escrow SET status = 'FAILED'
          WHERE order_id = $1 AND status IN ('PENDING', 'AUTHORIZED')
          RETURNING order_id`,
        [escrowRow.rows[0].order_id],
      );

      if (updated.rowCount === 1) {
        await ledgerClient.append(contractId, 'ESCROW_EVENT', {
          orderId: escrowRow.rows[0].order_id,
          paymentId,
          type: event.event,
          errorDescription: paymentEntity?.error_description ?? null,
        });
        await eventBus.publish(
          EVENT_TOPICS.ESCROW_LOCKED,
          { contractId, orderId: escrowRow.rows[0].order_id, paymentId, type: 'payment.failed' },
          correlationId,
        );
        logger.warn({ contractId, paymentId }, 'Escrow payment failed; marked FAILED');
      }
    } else if (event.event === 'payment.captured') {
      // The settlement worker captures and writes RELEASED in the same
      // transaction as the ledger entry, so this is confirmation of something
      // already recorded, not a state change to apply.
      logger.info({ contractId, paymentId }, 'Razorpay confirmed capture of released escrow');
    }

    return reply.status(200).send({ received: true });
  });
}
