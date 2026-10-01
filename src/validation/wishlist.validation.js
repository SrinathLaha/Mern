import { wishlistItemParams } from "../../../shared/shopping.mjs";
import { ApiError } from "../utils/errors.js";

export function validateWishlistParams(req, _res, next) {
  const result = wishlistItemParams.safeParse(req.params);
  if (!result.success)
    throw new ApiError(
      422,
      "Choose a valid product.",
      result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      })),
    );
  req.validatedParams = result.data;
  next();
}
