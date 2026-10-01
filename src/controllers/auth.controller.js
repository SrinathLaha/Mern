import * as service from "../services/auth.service.js";
import { safeUser } from "../models/user.model.js";

const cookieName = "mp_refresh";
const cookieOptions = (config) => ({
  httpOnly: true,
  secure: config.nodeEnv === "production",
  sameSite: "lax",
  path: "/api/auth",
});
export function clearSessionCookie(res, config) {
  res.clearCookie(cookieName, cookieOptions(config));
}
function sendSession(res, session, config) {
  res.cookie(cookieName, session.refreshToken, {
    ...cookieOptions(config),
    expires: session.expiresAt,
  });
  res.json({
    success: true,
    message: "Signed in.",
    data: { user: session.user, accessToken: session.accessToken },
  });
}
export const controllers = (config) => ({
  register: async (req, res) =>
    res.status(201).json({
      success: true,
      message: "Account created. You can now sign in.",
      data: { user: await service.register(req.validated) },
    }),
  login: async (req, res) =>
    sendSession(res, await service.signIn(req.validated, config), config),
  refresh: async (req, res) => {
    try {
      sendSession(
        res,
        await service.refresh(req.cookies[cookieName], config),
        config,
      );
    } catch (error) {
      if (error.status === 401)
        res.clearCookie(cookieName, cookieOptions(config));
      throw error;
    }
  },
  logout: async (req, res) => {
    await service.signOut(req.cookies[cookieName]);
    res.clearCookie(cookieName, cookieOptions(config));
    res.json({ success: true, message: "Signed out.", data: null });
  },
  me: (req, res) =>
    res.json({
      success: true,
      message: "Your account.",
      data: { user: safeUser(req.user) },
    }),
});
