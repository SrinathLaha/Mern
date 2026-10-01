import * as service from "../services/wishlist.service.js";

const send = (res, wishlist) => res.json({ success: true, data: { wishlist } });
export const getWishlist = async (req, res) =>
  send(res, await service.getWishlist(req.user._id));
export const addItem = async (req, res) =>
  send(res, await service.addItem(req.user._id, req.validatedParams.productId));
export const removeItem = async (req, res) =>
  send(
    res,
    await service.removeItem(req.user._id, req.validatedParams.productId),
  );
