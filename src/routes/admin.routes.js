import { Router } from "express";
import { authenticate, requireRole } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { review, validateSellerQuery } from "../validation/admin.validation.js";
import * as controller from "../controllers/admin.controller.js";

export function adminRoutes(config) {
  const router = Router();
  router.use(authenticate(config), requireRole("admin"));
  router.get("/sellers", validateSellerQuery, controller.listSellers);
  router.post("/sellers/:id/review", validate(review), controller.reviewSeller);
  return router;
}
