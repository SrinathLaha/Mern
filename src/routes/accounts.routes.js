import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { validate } from "../middleware/validate.js";
import { profile, address, version } from "../../../shared/accounts.mjs";
import * as controller from "../controllers/accounts.controller.js";
export function accountRoutes(config) {
  const router = Router();
  router.use(authenticate(config));
  router.patch("/profile", validate(profile), controller.updateProfile);
  router.get("/addresses", controller.listAddresses);
  router.post(
    "/addresses",
    validate(address),
    controller.changeAddress("create"),
  );
  router.patch(
    "/addresses/:id",
    validate(address),
    controller.changeAddress("update"),
  );
  router.patch(
    "/addresses/:id/default",
    validate(version),
    controller.changeAddress("default"),
  );
  router.delete(
    "/addresses/:id",
    validate(version),
    controller.changeAddress("delete"),
  );
  return router;
}
