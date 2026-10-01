import { Router } from "express";
import { authenticate, requireRole } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { fulfillmentTransitionInput } from "../../../shared/fulfillment.mjs";
import { validateFulfillmentOrder } from "../validation/fulfillment.validation.js";
import { transition } from "../controllers/fulfillment.controller.js";
export function fulfillmentRoutes(config) {
  const router = Router();
  router.use(authenticate(config), requireRole("seller"));
  router.patch(
    "/:orderId/fulfillment",
    validateFulfillmentOrder,
    validate(fulfillmentTransitionInput),
    transition,
  );
  return router;
}
