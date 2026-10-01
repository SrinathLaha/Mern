import { Router } from "express";
import { authenticate, requireRole } from "../middleware/authenticate.js";
import {
  categoryInput,
  categoryUpdate,
  productInput,
  productUpdate,
  productReview,
  versionAction,
  catalogQuery,
  productListQuery,
} from "../../../shared/catalog.mjs";
import { validate, validateQuery } from "../validation/catalog.validation.js";
import * as controller from "../controllers/catalog.controller.js";

export function catalogRoutes(config) {
  const router = Router();
  router.get("/catalog/categories", controller.listPublicCategories);
  router.get(
    "/catalog/products",
    validateQuery(catalogQuery),
    controller.listPublicProducts,
  );
  router.get("/catalog/products/:id", controller.getPublicProduct);
  const seller = Router();
  seller.use(authenticate(config), requireRole("seller"));
  seller.get(
    "/",
    validateQuery(productListQuery),
    controller.listSellerProducts,
  );
  seller.post("/", validate(productInput), controller.createProduct);
  seller.get("/:id", controller.getSellerProduct);
  seller.patch("/:id", validate(productUpdate), controller.updateProduct);
  seller.post("/:id/submit", validate(versionAction), controller.submitProduct);
  seller.post(
    "/:id/archive",
    validate(versionAction),
    controller.archiveProduct,
  );
  router.use("/seller/products", seller);
  const categories = Router();
  categories.use(authenticate(config), requireRole("admin"));
  categories.get("/", controller.listCategories);
  categories.post("/", validate(categoryInput), controller.createCategory);
  categories.patch("/:id", validate(categoryUpdate), controller.updateCategory);
  router.use("/admin/categories", categories);
  const products = Router();
  products.use(authenticate(config), requireRole("admin"));
  products.get("/", validateQuery(productListQuery), controller.listProducts);
  products.post(
    "/:id/review",
    validate(productReview),
    controller.reviewProduct,
  );
  router.use("/admin/products", products);
  return router;
}
