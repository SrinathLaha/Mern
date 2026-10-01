import { ApiError } from "../utils/errors.js";
export function validateSource(schema, source, destination) {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success)
      throw new ApiError(
        422,
        "Please check the request fields.",
        result.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      );
    req[destination] = result.data;
    next();
  };
}
