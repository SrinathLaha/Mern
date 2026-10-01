import { fulfillmentRoutes } from "./routes/fulfillment.routes.js";
import { checkoutRoutes } from "./routes/checkout.routes.js";
import { orderRoutes } from "./routes/orders.routes.js";
import { couponRoutes } from "./routes/coupons.routes.js";
import express from "express";
import { catalogRoutes } from "./routes/catalog.routes.js";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { authRoutes } from "./routes/auth.routes.js";
import { authenticate, requireRole } from "./middleware/authenticate.js";
import { errorHandler } from "./middleware/error-handler.js";
import { ApiError } from "./utils/errors.js";
import { createMailer } from "./integrations/email/mailer.js";
import { createRecoveryJobs } from "./jobs/recovery.jobs.js";
import { requestPasswordReset } from "./services/recovery.service.js";
import { accountRoutes } from "./routes/accounts.routes.js";
import { sellerRoutes } from "./routes/sellers.routes.js";
import { adminRoutes } from "./routes/admin.routes.js";
import { cartRoutes } from "./routes/cart.routes.js";
import { wishlistRoutes } from "./routes/wishlist.routes.js";

import { createStripeProvider } from "./integrations/payments/stripe.js";
import { createPaymentService } from "./services/payments.service.js";
import { paymentRoutes } from "./routes/payments.routes.js";
import { stripeWebhookController } from "./controllers/payments.controller.js";

export function createApp(config, options = {}) {
  if (Object.hasOwn(options, "paymentProvider") && config.nodeEnv !== "test")
    throw new Error(
      "Payment provider overrides are allowed only in test mode.",
    );
  const paymentProvider = Object.hasOwn(options, "paymentProvider")
    ? options.paymentProvider
    : createStripeProvider(config);
  const app = express();
  app.locals.paymentService = createPaymentService(config, paymentProvider);
  const mailer = createMailer(config);
  app.locals.recoveryJobs = createRecoveryJobs((email) =>
    requestPasswordReset(email, config, mailer),
  );
  app.disable("x-powered-by");
  app.use(helmet());
  app.use((req, res, next) => {
    req.id = randomUUID();
    res.setHeader("X-Request-Id", req.id);
    res.setHeader("Cache-Control", "no-store");
    const started = performance.now();
    if (config.nodeEnv !== "test")
      res.on("finish", () =>
        console.info(
          JSON.stringify({
            requestId: req.id,
            method: req.method,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - started),
          }),
        ),
      );
    next();
  });
  app.post(
    /^\/api\/payments\/stripe\/webhook$/,
    express.raw({ type: "application/json", limit: "256kb" }),
    stripeWebhookController(app.locals.paymentService),
  );
  app.use((req, _res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("Origin") !== config.frontendOrigin
    )
      throw new ApiError(403, "This request origin is not allowed.");
    next();
  });
  // Five 2,048-character URLs, 5,000-character description and 20 variants can exceed 16 KB.
  app.use("/api/seller/products", express.json({ limit: "64kb" }));
  app.use(express.json({ limit: "16kb" }));
  app.use(cookieParser());
  app.get("/api/health", (_req, res) => {
    const connected = mongoose.connection.readyState === 1;
    res.status(connected ? 200 : 503).json({
      success: connected,
      data: { database: connected ? "connected" : "unavailable" },
    });
  });
  app.use("/api/checkout", checkoutRoutes(config));
  app.use("/api/orders", paymentRoutes(config, app.locals.paymentService));
  app.use("/api/orders", orderRoutes(config));
  app.use("/api/seller/orders", fulfillmentRoutes(config));
  app.use("/api/seller/orders", orderRoutes(config, true));
  app.use("/api/admin/coupons", couponRoutes(config));
  app.use("/api", catalogRoutes(config));
  app.use("/api/auth", authRoutes(config, app.locals.recoveryJobs));
  app.use("/api/account", accountRoutes(config));
  app.use("/api/cart", cartRoutes(config));
  app.use("/api/wishlist", wishlistRoutes(config));
  app.use("/api/seller", sellerRoutes(config));
  app.use("/api/admin", adminRoutes(config));
  for (const role of ["seller", "admin"])
    app.get(
      `/api/${role}/access`,
      authenticate(config),
      requireRole(role),
      (_req, res) => res.json({ success: true, data: { allowed: true } }),
    );
  app.use((_req, _res, next) =>
    next(new ApiError(404, "This endpoint does not exist.")),
  );
  app.use(errorHandler);
  return app;
}
