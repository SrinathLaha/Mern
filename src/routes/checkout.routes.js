import { Router } from "express";
import { authenticate, requireRole } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { quoteInput } from "../../../shared/checkout.mjs";
import { quote } from "../controllers/checkout.controller.js";
export function checkoutRoutes(config) {
  const router = Router();
  router.use(authenticate(config), requireRole("customer"));
  router.post("/quote", validate(quoteInput), quote);
  return router;
}
