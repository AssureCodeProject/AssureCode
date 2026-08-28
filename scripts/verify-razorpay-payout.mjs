/**
 * One-off script: trigger a single real RazorpayX test-mode payout and print
 * the raw result, so its shape can be diffed against what
 * packages/razorpay-adapter/src/index.ts assumes (toPayoutResult, PayoutStatus).
 *
 * Usage: node scripts/verify-razorpay-payout.mjs [fundAccountId]
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@assurecode/config';
import {
  createPayoutAdapter,
  RazorpayXPayoutAdapter,
  RazorpayApiError,
} from '@assurecode/razorpay-adapter';

const config = loadConfig();
const fundAccountId = process.argv[2] ?? 'fa_TUrp3JnX0Kvfw0';

const razorpayConfig = {
  keyId: config.RAZORPAY_KEY_ID ?? '',
  keySecret: config.RAZORPAY_KEY_SECRET ?? '',
  webhookSecret: config.RAZORPAY_WEBHOOK_SECRET ?? '',
  accountNumber: config.RAZORPAYX_ACCOUNT_NUMBER ?? '',
};

const payouts = createPayoutAdapter(razorpayConfig);

console.log('Adapter selected:', payouts.constructor.name);
if (!(payouts instanceof RazorpayXPayoutAdapter)) {
  console.error(
    'Refusing to continue: createPayoutAdapter fell back to FakePayoutAdapter.\n' +
      'Check RAZORPAY_KEY_ID starts with rzp_ and does not contain "mock" or "...".',
  );
  process.exit(1);
}
if (!razorpayConfig.accountNumber) {
  console.error('RAZORPAYX_ACCOUNT_NUMBER is not set in .env — set it before running this.');
  process.exit(1);
}

const idempotencyKey = `verify-${randomUUID()}`;

console.log('Triggering payout:', {
  contractId: 'AC-VERIFY-TEST',
  accountId: fundAccountId,
  amountMinor: 100,
  currency: 'INR',
  idempotencyKey,
});

try {
  const result = await payouts.initiatePayout({
    contractId: 'AC-VERIFY-TEST',
    accountId: fundAccountId,
    amountMinor: 100,
    currency: 'INR',
    idempotencyKey,
  });
  console.log('\nPayoutResult:', JSON.stringify(result, null, 2));

  const fetched = await payouts.fetchPayout(result.payoutId);
  console.log('\nfetchPayout() result:', JSON.stringify(fetched, null, 2));
} catch (err) {
  if (err instanceof RazorpayApiError) {
    console.error('\nRazorpayApiError:', {
      message: err.message,
      statusCode: err.statusCode,
      code: err.code,
      reason: err.reason,
    });
  } else {
    console.error('\nUnexpected error:', err);
  }
  process.exit(1);
}
