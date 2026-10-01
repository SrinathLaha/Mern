import { cartItemParams } from "../../../shared/shopping.mjs";
import { ApiError } from "../utils/errors.js";

export function validateCartParams(req, _res, next) {
  const result = cartItemParams.safeParse(req.params);
  if (!result.success)
    throw new ApiError(
      422,
      "Choose a valid product and SKU.",
      result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    );
  req.validatedParams = result.data;
  next();
}
