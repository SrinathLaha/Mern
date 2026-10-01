import { Router } from "express";
import { authenticate, requireRole } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { emptyInput } from "../../../shared/checkout.mjs";
import { validateOrderId } from "../validation/orders.validation.js";
import { paymentController } from "../controllers/payments.controller.js";
export function paymentRoutes(config, service) {
  const router = Router();
  router.use(authenticate(config), requireRole("customer"));
  router.get(
    "/:id/payment",
    validateOrderId,
    paymentController(service, "get"),
  );
  for (const action of ["checkout", "refresh", "refund"])
    router.post(
      `/:id/payment/${action}`,
      validateOrderId,
      validate(emptyInput),
      paymentController(service, action),
    );
  return router;
}
