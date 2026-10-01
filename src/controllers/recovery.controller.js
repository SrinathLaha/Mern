import { resetPassword } from "../services/recovery.service.js";
import { ApiError } from "../utils/errors.js";
import { clearSessionCookie } from "./auth.controller.js";

export const recoveryControllers = (config, jobs) => ({
  forgot: (req, res) => {
    if (!jobs.enqueue(req.validated.email))
      throw new ApiError(
        503,
        "Recovery is temporarily busy. Please try again shortly.",
      );
    res.status(202).json({
      success: true,
      message:
        "If an active account matches that email, you will receive a password reset link shortly.",
      data: null,
    });
  },
  reset: async (req, res) => {
    await resetPassword(req.validated);
    clearSessionCookie(res, config);
    res.json({
      success: true,
      message: "Password updated. Sign in with your new password.",
      data: null,
    });
  },
});
