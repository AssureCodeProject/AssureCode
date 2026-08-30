/** Escrow funding, checkout-callback verification, and settlement requests. */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getCorrelationId } from '@assurecode/config';
import { EVENT_TOPICS } from '@assurecode/shared';
import { withIdempotency } from '../middleware/idempotency.js';
import {
  config,
  logger,
  dbPool,
  eventBus,
  ledgerClient,
  payments,
  recordPaymentEvent,
  clientVerified,
  settlementGuards,
} from '../context.js';

export function registerContractsEscrowRoutes(server: FastifyInstance): void {
  /**
   * Fund a contract's escrow.
   *
   * Creates a Razorpay *order*, which is what Checkout opens against. No money is
   * involved yet and no payment exists — the customer creates that by paying. The
   * order is created with `payment_capture: 0` inside the adapter, so when they
   * do, the payment settles at `authorized`: held, not taken. That is the escrow.
   *
   * Amounts are in the currency's minor unit (paise for INR), which is what
   * Razorpay expects and what `escrow.amount_cents` has always stored.
   */
  server.post<{
    Params: { contractId: string };
    Body: { amountCents?: number; amountMinor?: number; currency?: string };
    Reply: {
      contractId: string;
      orderId: string;
      amountMinor: number;
      currency: string;
      status: string;
      keyId: string;
    };
  }>('/api/contracts/:contractId/escrow', clientVerified, async (request, reply) => {
    return withIdempotency(dbPool, request, reply, async () => {
      const { contractId } = request.params;
      // `amountCents` is accepted alongside `amountMinor` because tools/benchmark.js
      // and tools/test_e2e_project_flow.js post it, and both meant minor units all
      // along. Same number, clearer name.
      const amountMinor = request.body.amountMinor ?? request.body.amountCents ?? 0;
      const currency = request.body.currency ?? 'INR';

      if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
        return {
          statusCode: 400,
          contractId,
          body: { error: 'amountMinor must be a positive integer in the minor unit (paise)' } as any,
        };
      }

      // Reuse an unpaid order rather than minting another one.
      //
      // Without this, every click of "Fund escrow" creates a fresh Razorpay order
      // — the idempotency middleware only dedupes when the caller sends an
      // Idempotency-Key header, and a user retrying after dismissing Checkout
      // sends nothing of the sort. The result would be a pile of orphan orders
      // per contract and a `SELECT ... LIMIT 1` in the oracle picking arbitrarily
      // between them. Matching on amount and currency means a genuine change of
      // intent still gets a new order; the stale one simply lapses unpaid.
      const reusable = await dbPool.query(
        `SELECT order_id, amount_cents, currency, status FROM escrow
          WHERE contract_id = $1 AND status = 'PENDING'
            AND amount_cents = $2 AND currency = $3
          ORDER BY created_at DESC LIMIT 1`,
        [contractId, amountMinor, currency],
      );

      if (reusable.rowCount === 1) {
        const existing = reusable.rows[0];
        logger.info(
          { contractId, orderId: existing.order_id },
          'Reusing the existing unpaid escrow order',
        );
        return {
          statusCode: 200,
          contractId,
          body: {
            contractId,
            orderId: existing.order_id,
            amountMinor: Number(existing.amount_cents),
            currency: existing.currency,
            status: 'created',
            keyId: config.RAZORPAY_KEY_ID ?? '',
          },
        };
      }

      const order = await payments.createOrder({ amountMinor, currency, contractId });

      logger.info(
        { contractId, orderId: order.orderId, amountMinor, currency, status: order.status },
        'Escrow order created',
      );

      await ledgerClient.append(contractId, 'ESCROW_CREATED', {
        orderId: order.orderId,
        amountMinor,
        currency,
        status: order.status,
      });

      // `order_id` is the primary key and is known now; `payment_id` stays NULL
      // until the customer actually pays. That gap is exactly what distinguishes
      // 'PENDING' from 'AUTHORIZED', and why the oracle must not capture on
      // 'PENDING'.
      await dbPool.query(
        `INSERT INTO escrow (order_id, contract_id, amount_cents, currency, status)
         VALUES ($1, $2, $3, $4, 'PENDING')
         ON CONFLICT (order_id) DO NOTHING`,
        [order.orderId, contractId, amountMinor, currency],
      );

      await recordPaymentEvent({
        contractId,
        eventType: 'escrow.created',
        amountMinor,
        orderId: order.orderId,
        payload: { orderId: order.orderId, currency, status: order.status },
      });

      return {
        statusCode: 200,
        contractId,
        body: {
          contractId,
          orderId: order.orderId,
          amountMinor: order.amountMinor,
          currency: order.currency,
          status: order.status,
          // Public key, returned so the browser can open Checkout. Serving it
          // from here rather than baking it into the web bundle keeps one source
          // of truth and makes rotation a restart rather than a rebuild.
          keyId: config.RAZORPAY_KEY_ID ?? '',
        },
      };
    });
  });

  /**
   * Confirm escrow funding from the Checkout callback.
   *
   * When a payment succeeds, Razorpay hands the browser `razorpay_payment_id`,
   * `razorpay_order_id` and `razorpay_signature` — an HMAC over `orderId|paymentId`
   * keyed by the API key secret. Verifying it here is what lets funding be
   * confirmed without a publicly reachable webhook URL, which matters because
   * Razorpay cannot deliver webhooks to a developer's localhost.
   *
   * The client is not trusted beyond the signature: the order must belong to this
   * contract, and the payment's status is re-read from Razorpay rather than taken
   * from the browser's word. The webhook remains the authoritative confirmation;
   * this is the fast path, and the two converge on the same row.
   */
  server.post<{
    Params: { contractId: string };
    Body: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string };
    Reply:
      | { contractId: string; orderId: string; paymentId: string; status: string; amountMinor: number }
      | { error: string; message?: string };
  }>('/api/contracts/:contractId/escrow/verify', clientVerified, async (request, reply) => {
    return withIdempotency(dbPool, request, reply, async () => {
      const { contractId } = request.params;
      const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = request.body || {};

      if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return {
          statusCode: 400,
          contractId,
          body: {
            error: 'razorpayOrderId, razorpayPaymentId and razorpaySignature are required',
          } as any,
        };
      }

      if (
        !payments.verifyCheckoutSignature({
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
          signature: razorpaySignature,
        })
      ) {
        logger.warn(
          { contractId, orderId: razorpayOrderId },
          'Razorpay checkout signature verification failed',
        );
        return { statusCode: 401, contractId, body: { error: 'Invalid signature' } as any };
      }

      // A valid signature proves Razorpay issued this order/payment pair. It does
      // not prove the order belongs to *this* contract — without this check, a
      // client could confirm one contract's escrow using another's genuine
      // payment.
      const escrowRow = await dbPool.query(
        `SELECT contract_id, amount_cents, currency, status FROM escrow WHERE order_id = $1`,
        [razorpayOrderId],
      );
      if (escrowRow.rowCount === 0) {
        return { statusCode: 404, contractId, body: { error: 'Escrow order not found' } as any };
      }
      if (escrowRow.rows[0].contract_id !== contractId) {
        logger.warn(
          { contractId, orderId: razorpayOrderId, actual: escrowRow.rows[0].contract_id },
          'Checkout callback presented an order belonging to a different contract',
        );
        return {
          statusCode: 403,
          contractId,
          body: { error: 'Order does not belong to this contract' } as any,
        };
      }

      // Re-read from Razorpay rather than trusting the browser about state.
      const payment = await payments.fetchPayment(razorpayPaymentId);
      if (payment.status !== 'authorized' && payment.status !== 'captured') {
        return {
          statusCode: 409,
          contractId,
          body: {
            error: 'Payment is not authorized',
            message: `Razorpay reports status '${payment.status}'`,
          } as any,
        };
      }

      // Guarded on 'PENDING' so a repeat call — or a webhook that already landed
      // — cannot move a RELEASED or FAILED escrow backwards.
      const updated = await dbPool.query(
        `UPDATE escrow
            SET status = 'AUTHORIZED', payment_id = $1, authorized_at = COALESCE(authorized_at, NOW())
          WHERE order_id = $2 AND status = 'PENDING'
          RETURNING amount_cents, currency`,
        [razorpayPaymentId, razorpayOrderId],
      );

      if (updated.rowCount === 1) {
        await ledgerClient.append(contractId, 'ESCROW_AUTHORIZED', {
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
          amountMinor: Number(updated.rows[0].amount_cents),
          currency: updated.rows[0].currency,
        });

        await recordPaymentEvent({
          contractId,
          eventType: 'escrow.authorized',
          amountMinor: Number(updated.rows[0].amount_cents),
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
          payload: { source: 'checkout_callback', status: payment.status },
        });

        await eventBus.publish(
          EVENT_TOPICS.ESCROW_LOCKED,
          {
            contractId,
            orderId: razorpayOrderId,
            paymentId: razorpayPaymentId,
            type: 'payment.authorized',
          },
          getCorrelationId() || randomUUID(),
        );

        logger.info(
          { contractId, orderId: razorpayOrderId, paymentId: razorpayPaymentId },
          'Escrow funded; funds authorized and held',
        );
      } else {
        // Already advanced past PENDING — the webhook won the race. Idempotent
        // by design, so this is a 200, not a conflict.
        logger.info(
          { contractId, orderId: razorpayOrderId, status: escrowRow.rows[0].status },
          'Escrow already confirmed; checkout callback was a no-op',
        );
      }

      return {
        statusCode: 200,
        contractId,
        body: {
          contractId,
          orderId: razorpayOrderId,
          paymentId: razorpayPaymentId,
          status: 'AUTHORIZED',
          amountMinor: Number(escrowRow.rows[0].amount_cents),
        },
      };
    });
  });

  server.post<{
    Params: { contractId: string };
    Body: { freelancerId: string; amountCents: number };
    Reply: { contractId: string; status: string } | { error: string };
  }>('/api/contracts/:contractId/settle', settlementGuards, async (request, reply) => {
    return withIdempotency(dbPool, request, reply, async () => {
      const { contractId } = request.params;
      const { freelancerId, amountCents } = request.body ?? ({} as typeof request.body);

      // Validate before publishing, because the failure lands somewhere far worse
      // than here.
      //
      // This route took both fields on trust. A request with an empty body
      // published `freelancerId: undefined` onto the bus; the settlement worker
      // approved the oracle verdict, captured the client's payment, and only then
      // failed inside commitSettlement — where the RFC 8785 canonicalizer
      // correctly refuses `undefined` because JSON.stringify would silently drop
      // it and the hashed payload would not be the payload that was passed.
      //
      // The result was money captured, no ledger entry, and a settlement row left
      // FAILED. A 400 here costs nothing; discovering it after the capture costs
      // a reconciliation.
      if (typeof freelancerId !== 'string' || freelancerId.trim() === '') {
        return {
          statusCode: 400,
          contractId,
          body: { error: 'freelancerId is required and must be a non-empty string' },
        };
      }
      if (!Number.isInteger(amountCents) || (amountCents as number) <= 0) {
        return {
          statusCode: 400,
          contractId,
          body: { error: 'amountCents is required and must be a positive integer' },
        };
      }

      // Idempotency check: has it already been settled?
      //
      // This looked for 'INVOICE', which nothing writes. commitSettlement in the
      // settlement worker appends 'SETTLEMENT_COMPLETED', so the 409 below never
      // fired and a repeat request got 202 "pending_oracle_verification" — only
      // stopped later, and silently, by the worker's own claim guard.
      const chain = await ledgerClient.getChain(contractId);
      const isSettled = chain.some((entry) => entry.actionType === 'SETTLEMENT_COMPLETED');
      if (isSettled) {
        return {
          statusCode: 409,
          contractId,
          body: { error: 'Contract already settled' },
        };
      }

      const correlationId = randomUUID();
      await eventBus.publish(
        EVENT_TOPICS.SETTLEMENT_REQUESTED,
        { contractId, freelancerId, amountCents, requestedAt: new Date().toISOString() },
        correlationId
      );

      logger.info({ contractId, freelancerId, amountCents }, 'Settlement requested via Oracle');

      return {
        statusCode: 202,
        contractId,
        body: {
          contractId,
          status: 'pending_oracle_verification',
        },
      };
    });
  });
}
