import Stripe from "stripe";
import { ApiError } from "../../utils/errors.js";

function providerError() {
  const error = new ApiError(
    503,
    "The payment provider is temporarily unavailable. Please try again.",
  );
  error.code = "PAYMENT_PROVIDER_UNAVAILABLE";
  return error;
}

function webhookError() {
  const error = new ApiError(400, "Invalid Stripe webhook.");
  error.code = "INVALID_WEBHOOK_SIGNATURE";
  return error;
}

export function createStripeProvider(
  config,
  { StripeClient = Stripe, httpClient } = {},
) {
  const { secretKey, webhookSecret } = config.payments ?? {};
  if (secretKey && !/^sk_test_[A-Za-z0-9]+$/.test(secretKey)) {
    throw new Error("Stripe requires a test-mode STRIPE_SECRET_KEY.");
  }
  if (webhookSecret && !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) {
    throw new Error("Stripe requires a valid STRIPE_WEBHOOK_SECRET.");
  }
  if (!secretKey || !webhookSecret) return null;

  const stripe = new StripeClient(secretKey, {
    timeout: 10000,
    // Persisted domain jobs own retries so uncertain outcomes use the same key.
    maxNetworkRetries: 0,
    ...(httpClient ? { httpClient } : {}),
  });
  const request = async (operation) => {
    try {
      return await operation();
    } catch {
      // Provider errors can include credentials, request data and customer data.
      throw providerError();
    }
  };

  return {
    createCheckout(
      { attemptId, orderId, amountPaise, frontendOrigin, expiresAt },
      idempotencyKey,
    ) {
      const metadata = { attemptId, orderId };
      const orderUrl = `${frontendOrigin}/orders/${encodeURIComponent(orderId)}`;
      return request(() =>
        stripe.checkout.sessions.create(
          {
            mode: "payment",
            payment_method_types: ["card"],
            client_reference_id: orderId,
            metadata,
            payment_intent_data: { metadata },
            line_items: [
              {
                price_data: {
                  currency: "inr",
                  unit_amount: amountPaise,
                  product_data: { name: `Marketplace order ${orderId}` },
                },
                quantity: 1,
              },
            ],
            allow_promotion_codes: false,
            automatic_tax: { enabled: false },
            adaptive_pricing: { enabled: false },
            success_url: `${orderUrl}?payment=returned`,
            cancel_url: `${orderUrl}?payment=cancelled`,
            expires_at: expiresAt,
          },
          { idempotencyKey },
        ),
      );
    },
    retrieveCheckout(sessionId) {
      return request(() =>
        stripe.checkout.sessions.retrieve(sessionId, {
          expand: ["payment_intent.latest_charge"],
        }),
      );
    },
    retrievePaymentIntent(paymentIntentId) {
      return request(() =>
        stripe.paymentIntents.retrieve(paymentIntentId, {
          expand: ["latest_charge"],
        }),
      );
    },
    expireCheckout(sessionId) {
      return request(() => stripe.checkout.sessions.expire(sessionId));
    },
    createRefund({ paymentIntentId, amountPaise }, idempotencyKey) {
      return request(() =>
        stripe.refunds.create(
          { payment_intent: paymentIntentId, amount: amountPaise },
          { idempotencyKey },
        ),
      );
    },
    retrieveRefund(refundId) {
      return request(() => stripe.refunds.retrieve(refundId));
    },
    verifyWebhook(rawBody, signature) {
      try {
        if (!Buffer.isBuffer(rawBody) || typeof signature !== "string")
          throw webhookError();
        const event = stripe.webhooks.constructEvent(
          rawBody,
          signature,
          webhookSecret,
          300,
        );
        if (event.livemode !== false) throw webhookError();
        return event;
      } catch {
        throw webhookError();
      }
    },
  };
}
