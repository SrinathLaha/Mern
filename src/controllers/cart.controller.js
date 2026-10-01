import * as service from "../services/cart.service.js";

const send = (res, cart) => res.json({ success: true, data: { cart } });
export const getCart = async (req, res) =>
  send(res, await service.getCart(req.user._id));
export const addItem = async (req, res) =>
  send(res, await service.addItem(req.user._id, req.validated));
export const updateItem = async (req, res) =>
  send(
    res,
    await service.updateItem(req.user._id, req.validatedParams, req.validated),
  );
export const removeItem = async (req, res) =>
  send(
    res,
    await service.removeItem(req.user._id, req.validatedParams, req.validated),
  );
