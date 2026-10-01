import { Router } from "express";
import { authenticate, requireRole } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  couponCreateInput,
  couponDisableInput,
} from "../../../shared/checkout.mjs";
import { validateCouponId } from "../validation/coupons.validation.js";
import * as controller from "../controllers/coupons.controller.js";
export function couponRoutes(config) {
  const router = Router();
  router.use(authenticate(config), requireRole("admin"));
  router.get("/", controller.list);
  router.post("/", validate(couponCreateInput), controller.create);
  router.post(
    "/:id/disable",
    validateCouponId,
    validate(couponDisableInput),
    controller.disable,
  );
  return router;
}
