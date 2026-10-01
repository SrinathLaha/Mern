import * as service from "../services/admin.service.js";

export const listSellers = async (req, res) =>
  res.json({
    success: true,
    data: await service.listSellers(req.validatedQuery),
  });

export const reviewSeller = async (req, res) =>
  res.json({
    success: true,
    data: {
      user: await service.reviewSeller(
        req.params.id,
        req.user._id,
        req.validated,
      ),
    },
  });
