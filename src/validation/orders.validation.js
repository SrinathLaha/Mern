import {
  orderIdParams,
  orderListQuery,
} from "../../../shared/checkout.mjs";
import { validateSource } from "./checkout.validation.js";
export const validateOrderId = validateSource(
  orderIdParams,
  "params",
  "validatedParams",
);
export const validateOrderList = validateSource(
  orderListQuery,
  "query",
  "validatedQuery",
);
