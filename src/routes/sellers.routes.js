import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { ApiError } from "../utils/errors.js";
import { validate } from "../middleware/validate.js";
import { application } from "../../../shared/sellers.mjs";
import * as controller from "../controllers/sellers.controller.js";

export function sellerRoutes(config) {
  const router = Router();
  router.use(authenticate(config), (req, _res, next) => {
    if (req.user.role !== "seller")
      throw new ApiError(403, "This area is for seller accounts.");
    next();
  });
  router.get("/application", controller.getApplication);
  router.patch(
    "/application",
    validate(application),
    controller.updateApplication,
  );
  return router;
}
