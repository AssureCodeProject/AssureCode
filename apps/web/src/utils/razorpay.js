/**
 * Razorpay Checkout script loader.
 *
 * Checkout is a hosted script, not an npm package: Razorpay serves the modal
 * from their own origin so card data is entered inside their context and never
 * touches this app's DOM. That is also why there is no bundled alternative —
 * loading it from checkout.razorpay.com is the integration.
 *
 * The loader is idempotent and shared. Appending a second <script> for the same
 * URL would re-run it and clobber `window.Razorpay` mid-checkout, so a single
 * in-flight promise is cached and every caller awaits the same one.
 */

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/** The single in-flight (or settled) load. Null until the first call. */
let loadPromise = null;

/**
 * Resolve once `window.Razorpay` is callable.
 *
 * Rejects rather than hanging when the script cannot be fetched — offline, or
 * blocked by an extension or a corporate proxy — because a silent failure here
 * shows the user a button that does nothing when clicked.
 */
export function loadRazorpayCheckout() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    // A previous mount may have inserted the tag without finishing; reuse it
    // rather than racing a second copy of the same script.
    const existing = document.querySelector(`script[src="${CHECKOUT_SRC}"]`);
    const script = existing ?? document.createElement('script');

    const onLoad = () => {
      if (window.Razorpay) {
        resolve(window.Razorpay);
      } else {
        // The request succeeded but did not give us the global — treat it as a
        // failure rather than resolving with undefined and failing at the call.
        loadPromise = null;
        reject(new Error('Razorpay Checkout loaded but window.Razorpay is undefined'));
      }
    };

    const onError = () => {
      // Clear the cache so a later attempt can retry; a rejected promise cached
      // forever would make one transient network blip permanent.
      loadPromise = null;
      script.remove();
      reject(new Error('Could not load Razorpay Checkout. Check your network connection.'));
    };

    script.addEventListener('load', onLoad, { once: true });
    script.addEventListener('error', onError, { once: true });

    if (!existing) {
      script.src = CHECKOUT_SRC;
      script.async = true;
      document.body.appendChild(script);
    }
  });

  return loadPromise;
}

/**
 * Open Checkout for an order and resolve with the fields the gateway needs to
 * verify the payment.
 *
 * Resolves only on a successful payment. A dismissed modal rejects with
 * `code: 'DISMISSED'` so the caller can tell "the user changed their mind"
 * apart from "the payment failed" — they warrant different messages, and only
 * one of them is worth reporting as an error.
 */
export function openRazorpayCheckout({ keyId, orderId, amountMinor, currency, contractId, prefill }) {
  return new Promise((resolve, reject) => {
    loadRazorpayCheckout()
      .then((Razorpay) => {
        let settled = false;

        const checkout = new Razorpay({
          key: keyId,
          // Razorpay takes the authoritative amount from the order itself;
          // these are display values for the modal. Passing them keeps the
          // modal from showing a blank total before it fetches the order.
          amount: amountMinor,
          currency,
          order_id: orderId,
          name: 'AssureCode',
          description: `Escrow funding for contract ${contractId}`,
          notes: { contractId },
          prefill: prefill ?? {},
          theme: { color: '#0f172a' },
          handler(response) {
            settled = true;
            resolve({
              razorpayOrderId: response.razorpay_order_id,
              razorpayPaymentId: response.razorpay_payment_id,
              // HMAC over `orderId|paymentId`. Worthless to verify here — the
              // browser does not have the key secret, and could lie about the
              // result anyway. The gateway checks it.
              razorpaySignature: response.razorpay_signature,
            });
          },
          modal: {
            ondismiss() {
              // `handler` fires before `ondismiss` on success, so the guard
              // stops a completed payment being reported as abandoned.
              if (settled) return;
              const err = new Error('Payment cancelled.');
              err.code = 'DISMISSED';
              reject(err);
            },
          },
        });

        // Razorpay reports a declined card here rather than through `handler`.
        checkout.on('payment.failed', (response) => {
          settled = true;
          const err = new Error(response?.error?.description ?? 'Payment failed.');
          err.code = response?.error?.code ?? 'PAYMENT_FAILED';
          reject(err);
        });

        checkout.open();
      })
      .catch(reject);
  });
}
