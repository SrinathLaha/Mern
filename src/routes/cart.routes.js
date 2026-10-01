import { Router } from "express";
import { authenticate, requireRole } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import {
  cartAddInput,
  cartUpdateInput,
  cartRemoveInput,
} from "../../../shared/shopping.mjs";
import { validateCartParams } from "../validation/cart.validation.js";
import * as controller from "../controllers/cart.controller.js";

export function cartRoutes(config) {
  const router = Router();
  router.use(authenticate(config), requireRole("customer"));
  router.get("/", controller.getCart);
  router.post("/items", validate(cartAddInput), controller.addItem);
  router.patch(
    "/items/:productId/:sku",
    validateCartParams,
    validate(cartUpdateInput),
    controller.updateItem,
  );
  router.delete(
    "/items/:productId/:sku",
    validateCartParams,
    validate(cartRemoveInput),
    controller.removeItem,
  );
  return router;
}
