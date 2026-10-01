export function errorHandler(error, req, res, _next) {
  let status = error.status ?? 500;
  let message = error.message;
  if (error.code === 11000) {
    status = 409;
    message = "An account already uses this email. Please sign in.";
  }
  if (error.type === "entity.parse.failed") {
    status = 400;
    message = "The request must contain valid JSON.";
  }
  if (error.type === "entity.too.large") {
    status = 413;
    message = "The request is too large.";
  }
  if (status >= 500) {
    console.error(
      JSON.stringify({
        level: "error",
        requestId: req.id,
        code: error.code ?? "INTERNAL_ERROR",
      }),
    );
    message =
      error.code === "PAYMENTS_DISABLED"
        ? "Payments are unavailable. Configure Stripe test credentials and the webhook secret to enable checkout."
        : "Something went wrong. Please try again.";
  }
  res.status(status).json({
    success: false,
    message,
    errors: error.errors ?? [],
    requestId: req.id,
  });
}
