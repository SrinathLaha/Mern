import { safeUser } from "../models/user.model.js";
import * as service from "../services/sellers.service.js";

export const getApplication = (req, res) =>
  res.json({ success: true, data: { user: safeUser(req.user) } });

export const updateApplication = async (req, res) =>
  res.json({
    success: true,
    data: {
      user: await service.updateApplication(req.user._id, req.validated),
    },
  });
