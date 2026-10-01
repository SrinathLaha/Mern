import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Stripe from "stripe";

import { createStripeProvider } from "../src/integrations/payments/stripe.js";
const config = {
  payments: { secretKey: "sk_test_fixture", webhookSecret: "whsec_fixture" },
};
function provider(options) {
  return createStripeProvider(config, options);
}
function transport(
  response = { id: "cs_test_fixture", object: "checkout.session" },
  status = 200,
) {
  const requests = [];
  const httpClient = Stripe.createFetchHttpClient(async (url, init) => {
    requests.push({
      url: new URL(url),
      method: init.method,
      headers: new Headers(init.headers),
      body: new URLSearchParams(init.body),
    });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { requests, httpClient };
}
const params = {
  attemptId: "attempt_123",
  orderId: "order_123",
  amountPaise: 24900,
  frontendOrigin: "http://localhost:3000",
  expiresAt: 1900000000,
};

test("missing credentials disables Stripe, and direct factory rejects live keys", () => {
  provider();
  assert.equal(createStripeProvider({}), null);
  assert.equal(
    createStripeProvider({ payments: { secretKey: "sk_test_fixture" } }),
    null,
  );
  assert.throws(
    () =>
      createStripeProvider({
        payments: {
          secretKey: "sk_live_private",
          webhookSecret: "whsec_fixture",
        },
      }),
    (error) => !error.message.includes("sk_live_private"),
  );
});

test("checkout sends an immutable INR total, order bindings and idempotency key through the real SDK", async () => {
  const { httpClient, requests } = transport();
  const result = await provider({ httpClient }).createCheckout(
    params,
    "checkout_attempt_123",
  );
  assert.equal(result.id, "cs_test_fixture");
  const request = requests[0];
  assert.equal(request.url.pathname, "/v1/checkout/sessions");
  assert.equal(request.method, "POST");
  assert.equal(request.headers.get("Idempotency-Key"), "checkout_attempt_123");
  assert.deepEqual(Object.fromEntries(request.body), {
    mode: "payment",
    "payment_method_types[0]": "card",
    client_reference_id: "order_123",
    "metadata[attemptId]": "attempt_123",
    "metadata[orderId]": "order_123",
    "payment_intent_data[metadata][attemptId]": "attempt_123",
    "payment_intent_data[metadata][orderId]": "order_123",
    "line_items[0][price_data][currency]": "inr",
    "line_items[0][price_data][unit_amount]": "24900",
    "line_items[0][price_data][product_data][name]":
      "Marketplace order order_123",
    "line_items[0][quantity]": "1",
    allow_promotion_codes: "false",
    "automatic_tax[enabled]": "false",
    "adaptive_pricing[enabled]": "false",
    success_url: "http://localhost:3000/orders/order_123?payment=returned",
    cancel_url: "http://localhost:3000/orders/order_123?payment=cancelled",
    expires_at: "1900000000",
  });
});

test("retrieval expands the captured charge and refunds preserve the persisted amount and key", async () => {
  const { httpClient, requests } = transport({
    id: "re_fixture",
    object: "refund",
    status: "pending",
  });
  const adapter = provider({ httpClient });
  await adapter.retrieveCheckout("cs_test_fixture");
  await adapter.expireCheckout("cs_test_fixture");
  const refund = await adapter.createRefund(
    { paymentIntentId: "pi_fixture", amountPaise: 24900 },
    "refund_attempt_123",
  );
  await adapter.retrieveRefund("re_fixture");
  assert.equal(
    requests[0].url.pathname,
    "/v1/checkout/sessions/cs_test_fixture",
  );
  assert.deepEqual(
    [...requests[0].url.searchParams],
    [["expand[0]", "payment_intent.latest_charge"]],
  );
  assert.equal(
    requests[1].url.pathname,
    "/v1/checkout/sessions/cs_test_fixture/expire",
  );
  assert.equal(requests[1].method, "POST");
  assert.equal(requests[2].url.pathname, "/v1/refunds");
  assert.deepEqual(Object.fromEntries(requests[2].body), {
    payment_intent: "pi_fixture",
    amount: "24900",
  });
  assert.equal(
    requests[2].headers.get("Idempotency-Key"),
    "refund_attempt_123",
  );
  assert.equal(refund.status, "pending");
  assert.equal(requests[3].url.pathname, "/v1/refunds/re_fixture");
});

function signed(payload, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = createHmac("sha256", "whsec_fixture")
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}
test("webhooks require raw signed bytes, a recent timestamp, and test-mode events", () => {
  const adapter = provider();
  const body = Buffer.from(
    '{ "id":"evt_fixture", "livemode":false,"type":"checkout.session.completed","data":{"object":{"id":"cs_test_fixture"}}}',
  );
  assert.equal(adapter.verifyWebhook(body, signed(body)).id, "evt_fixture");
  for (const [raw, signature] of [
    [Buffer.from(`${body} `), signed(body)],
    [body, signed(body, 1)],
    [body, "bad-signature"],
    [JSON.parse(body), signed(body)],
    [body, undefined],
  ]) {
    assert.throws(
      () => adapter.verifyWebhook(raw, signature),
      (error) =>
        error.status === 400 &&
        error.code === "INVALID_WEBHOOK_SIGNATURE" &&
        !error.message.includes("whsec_fixture"),
    );
  }
  const live = Buffer.from('{"id":"evt_live","livemode":true}');
  assert.throws(
    () => adapter.verifyWebhook(live, signed(live)),
    (error) => error.status === 400,
  );
});

test("provider failures are bounded and expose no provider payload or credentials", async () => {
  const { httpClient, requests } = transport(
    {
      error: {
        type: "api_error",
        message: "private-provider-body sk_test_fixture",
      },
    },
    500,
  );
  let options;
  class Client extends Stripe {
    constructor(key, settings) {
      super(key, settings);
      options = settings;
    }
  }
  const adapter = provider({ StripeClient: Client, httpClient });
  await assert.rejects(
    adapter.createCheckout(params, "checkout_attempt_123"),
    (error) => {
      assert.equal(error.code, "PAYMENT_PROVIDER_UNAVAILABLE");
      assert.equal(error.status, 503);
      assert.equal(error.cause, undefined);
      assert.ok(!JSON.stringify(error).includes("private-provider-body"));
      assert.ok(!error.message.includes("sk_test_fixture"));
      return true;
    },
  );
  assert.equal(
    requests.length,
    1,
    "durable domain retries own recovery after uncertain results",
  );
  assert.ok(options.timeout > 0 && options.timeout <= 15000);
});

test("payment intent lookup expands its latest charge for unmatched refund reconciliation", async () => {
  const { httpClient, requests } = transport({
    id: "pi_fixture",
    object: "payment_intent",
    latest_charge: { id: "ch_fixture", object: "charge", refunded: true },
  });
  const adapter = provider({ httpClient });
  assert.equal(typeof adapter.retrievePaymentIntent, "function");
  const intent = await adapter.retrievePaymentIntent("pi_fixture");
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].url.pathname, "/v1/payment_intents/pi_fixture");
  assert.deepEqual(
    [...requests[0].url.searchParams],
    [["expand[0]", "latest_charge"]],
  );
  assert.equal(intent.id, "pi_fixture");
  assert.equal(intent.latest_charge.refunded, true);
});
