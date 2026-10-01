import { validate } from "../middleware/validate.js";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { controllers } from "../controllers/auth.controller.js";
import {
  registration,
  login,
  empty,
  forgotPassword,
  resetPassword,
} from "../validation/auth.validation.js";
import { recoveryControllers } from "../controllers/recovery.controller.js";
import { authenticate } from "../middleware/authenticate.js";
import { digest, parseRefresh } from "../utils/tokens.js";

export function authRoutes(config, recoveryJobs) {
  const router = Router();
  const controller = controllers(config);
  const recovery = recoveryControllers(config, recoveryJobs);
  const limits = (max, options = {}) =>
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: max,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        success: false,
        message: "Too many attempts. Please try again later.",
        errors: [],
      },
      ...options,
    });
  // Never accept spoofable forwarded IPs. A coarse transport backstop bounds work;
  // the small credential/session buckets use identity, so proxy clients stay separate.
  const transportLimit = limits(config.transportLimit ?? 1000, {
    validate: { xForwardedForHeader: false },
  });
  const credentialsLimit = limits(config.authLimit ?? 30, {
    keyGenerator: (req) =>
      digest(
        typeof req.body?.email === "string"
          ? req.body.email.trim().toLowerCase()
          : "invalid-email",
      ),
    skipSuccessfulRequests: true,
  });
  router.post(
    "/register",
    transportLimit,
    credentialsLimit,
    validate(registration),
    controller.register,
  );
  router.post(
    "/login",
    transportLimit,
    credentialsLimit,
    validate(login),
    controller.login,
  );
  router.post(
    "/refresh",
    transportLimit,
    limits(config.authLimit ?? 120, {
      keyGenerator: (req) =>
        parseRefresh(req.cookies.mp_refresh)?.id ?? "invalid-session",
      skip: (req) => !parseRefresh(req.cookies.mp_refresh),
    }),
    validate(empty),
    controller.refresh,
  );
  router.post("/logout", validate(empty), controller.logout);
  router.post(
    "/forgot-password",
    transportLimit,
    limits(config.recoveryLimit ?? 5, {
      keyGenerator: (req) =>
        digest(
          typeof req.body?.email === "string"
            ? req.body.email.trim().toLowerCase()
            : "invalid-email",
        ),
    }),
    validate(forgotPassword),
    recovery.forgot,
  );
  router.post(
    "/reset-password",
    transportLimit,
    limits(config.recoveryLimit ?? 10, {
      keyGenerator: (req) =>
        digest(
          typeof req.body?.token === "string"
            ? req.body.token
            : "invalid-token",
        ),
    }),
    validate(resetPassword),
    recovery.reset,
  );
  router.get("/me", authenticate(config), controller.me);
  return router;
}
