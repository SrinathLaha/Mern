import { ApiError } from "../utils/errors.js";

export function validate(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const duplicate = result.error.issues.some(
        (issue) => issue.params?.duplicateSku,
      );
      throw new ApiError(
        duplicate ? 409 : 422,
        duplicate
          ? "Each variant must have a unique SKU."
          : "Please check the highlighted fields.",
        result.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    req.validated = result.data;
    next();
  };
}
export function validateQuery(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success)
      throw new ApiError(
        422,
        "Choose valid catalog filters and pagination.",
        result.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      );
    req.validatedQuery = result.data;
    next();
  };
}
