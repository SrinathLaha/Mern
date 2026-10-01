import { sellerQuery } from "../../../shared/sellers.mjs";
import { ApiError } from "../utils/errors.js";
export { review } from "../../../shared/sellers.mjs";

export function validateSellerQuery(req, _res, next) {
  const parsed = sellerQuery.safeParse(req.query);
  if (!parsed.success)
    throw new ApiError(422, "Choose a valid status and page.");
  req.validatedQuery = parsed.data;
  next();
}
