import { ApiError } from "../utils/errors.js";

export const validate = (schema) => (req, _res, next) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    const errors = new Map();
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".");
      if (!errors.has(field))
        errors.set(field, { field, message: issue.message });
    }
    return next(
      new ApiError(422, "Please check the highlighted fields.", [
        ...errors.values(),
      ]),
    );
  }
  req.validated = parsed.data;
  next();
};
