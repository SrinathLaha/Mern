import * as service from "../services/coupons.service.js";
export async function list(req, res) {
  res.json({ success: true, data: await service.listCoupons() });
}
export async function create(req, res) {
  res
    .status(201)
    .json({
      success: true,
      data: { coupon: await service.createCoupon(req.validated) },
    });
}
export async function disable(req, res) {
  res.json({
    success: true,
    data: {
      coupon: await service.disableCoupon(
        req.validatedParams.id,
        req.validated.version,
      ),
    },
  });
}
