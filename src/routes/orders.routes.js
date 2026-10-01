import { Router } from "express";
import { authenticate, requireRole } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  orderCreateInput,
  emptyInput,
} from "../../../shared/checkout.mjs";
import {
  validateOrderId,
  validateOrderList,
} from "../validation/orders.validation.js";
import * as controller from "../controllers/orders.controller.js";
export function orderRoutes(config, seller = false) {
  const router = Router();
  router.use(authenticate(config), requireRole(seller ? "seller" : "customer"));
  router.get("/", validateOrderList, controller.list(seller));
  router.get("/:id", validateOrderId, controller.get(seller));
  if (!seller) {
    router.post("/", validate(orderCreateInput), controller.create);
    router.post(
      "/:id/cancel",
      validateOrderId,
      validate(emptyInput),
      controller.cancel,
    );
  }
  return router;
}
