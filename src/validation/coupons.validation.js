import { orderIdParams } from "../../../shared/checkout.mjs";
import { validateSource } from "./checkout.validation.js";
export const validateCouponId = validateSource(
  orderIdParams,
  "params",
  "validatedParams",
);
