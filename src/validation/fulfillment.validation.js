import { fulfillmentOrderParams } from "../../../shared/fulfillment.mjs";
import { validateSource } from "./checkout.validation.js";
export const validateFulfillmentOrder = validateSource(
  fulfillmentOrderParams,
  "params",
  "validatedParams",
);
