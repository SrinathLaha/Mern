import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config/env.js";

const env = {
  MONGODB_URI: "mongodb://127.0.0.1:27017/example",
  FRONTEND_URL: "http://localhost:3000",
  JWT_ACCESS_SECRET: "a-valid-length-test-secret-not-for-real-use-123456789",
};
test("environment rejects the example signing secret rather than starting insecurely", () => {
  assert.throws(
    () =>
      readConfig({
        ...env,
        JWT_ACCESS_SECRET:
          "replace-with-a-random-secret-of-at-least-48-characters",
      }),
    /JWT_ACCESS_SECRET/,
  );
});
test("production requires HTTPS and configuration errors do not expose secrets", () => {
  assert.throws(() => readConfig({ ...env, NODE_ENV: "production" }), /HTTPS/);
  assert.throws(
    () => readConfig({ ...env, FRONTEND_URL: "http://localhost:3000/path" }),
    /origin/,
  );
  assert.throws(
    () => readConfig({ ...env, JWT_ACCESS_SECRET: "short-private-secret" }),
    (error) => !error.message.includes("short-private-secret"),
  );
  assert.equal(
    readConfig({
      ...env,
      NODE_ENV: "production",
      FRONTEND_URL: "https://marketplace.example",
      MAIL_MODE: "smtp",
      MAIL_FROM: "noreply@marketplace.example",
      SMTP_HOST: "smtp.example.test",
      SMTP_USER: "test",
      SMTP_PASSWORD: "test-password",
    }).nodeEnv,
    "production",
  );
});
test("production rejects local mail and incomplete SMTP credentials without leaking secrets", () => {
  const production = {
    ...env,
    NODE_ENV: "production",
    FRONTEND_URL: "https://marketplace.example",
  };
  assert.throws(() => readConfig(production), /SMTP/);
  assert.throws(
    () =>
      readConfig({
        ...production,
        MAIL_MODE: "smtp",
        SMTP_PASSWORD: "private-smtp-password",
      }),
    (error) =>
      /SMTP/.test(error.message) &&
      !error.message.includes("private-smtp-password"),
  );
  assert.throws(() => readConfig({ ...env, SMTP_SECURE: "no" }), /SMTP_SECURE/);
  assert.equal(readConfig(env).mail.mode, "local");
});

test("Stripe configuration permits absent keys and accepts only test secrets", () => {
  assert.deepEqual(readConfig(env).payments, {
    secretKey: undefined,
    webhookSecret: undefined,
  });
  assert.deepEqual(
    readConfig({ ...env, STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" })
      .payments,
    { secretKey: undefined, webhookSecret: undefined },
  );
  assert.deepEqual(
    readConfig({
      ...env,
      STRIPE_SECRET_KEY: "sk_test_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    }).payments,
    { secretKey: "sk_test_fixture", webhookSecret: "whsec_fixture" },
  );
  for (const secretKey of ["sk_live_private", "pk_test_private", "sk_test_"]) {
    assert.throws(
      () => readConfig({ ...env, STRIPE_SECRET_KEY: secretKey }),
      (error) =>
        /STRIPE_SECRET_KEY/.test(error.message) &&
        !error.message.includes(secretKey),
    );
  }
  assert.throws(
    () =>
      readConfig({ ...env, STRIPE_WEBHOOK_SECRET: "private-invalid-secret" }),
    (error) =>
      /STRIPE_WEBHOOK_SECRET/.test(error.message) &&
      !error.message.includes("private-invalid-secret"),
  );
});
