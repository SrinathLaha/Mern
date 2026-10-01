import * as service from "../services/accounts.service.js";
export const updateProfile = async (req, res) =>
  res.json({
    success: true,
    data: { user: await service.updateProfile(req.user._id, req.validated) },
  });
export const listAddresses = async (req, res) =>
  res.json({
    success: true,
    data: { book: await service.getAddresses(req.user._id) },
  });
export const changeAddress = (action) => async (req, res) =>
  res.status(action === "create" ? 201 : 200).json({
    success: true,
    data: {
      book: await service.changeAddress(
        req.user._id,
        action,
        req.params.id,
        req.validated,
      ),
    },
  });
