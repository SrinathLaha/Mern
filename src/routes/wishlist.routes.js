import { Router } from "express";
import { authenticate, requireRole } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { wishlistInput } from "../../../shared/shopping.mjs";
import { validateWishlistParams } from "../validation/wishlist.validation.js";
import * as controller from "../controllers/wishlist.controller.js";

export function wishlistRoutes(config) {
  const router = Router();
  router.use(authenticate(config), requireRole("customer"));
  router.get("/", controller.getWishlist);
  router.put(
    "/items/:productId",
    validateWishlistParams,
    validate(wishlistInput),
    controller.addItem,
  );
  router.delete(
    "/items/:productId",
    validateWishlistParams,
    validate(wishlistInput),
    controller.removeItem,
  );
  return router;
}
