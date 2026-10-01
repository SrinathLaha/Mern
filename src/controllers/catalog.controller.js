import * as service from "../services/catalog.service.js";

const send = (res, data, status = 200) =>
  res.status(status).json({ success: true, data });

export const listPublicCategories = async (_req, res) =>
  send(res, await service.listCategories(true));

export const listPublicProducts = async (req, res) =>
  send(
    res,
    await service.listProducts(req.validatedQuery, { publicOnly: true }),
  );

export const getPublicProduct = async (req, res) =>
  send(res, {
    product: await service.getProduct(req.params.id, { publicOnly: true }),
  });

export const listSellerProducts = async (req, res) =>
  send(
    res,
    await service.listProducts(req.validatedQuery, { sellerId: req.user._id }),
  );

export const createProduct = async (req, res) =>
  send(
    res,
    { product: await service.createProduct(req.user._id, req.validated) },
    201,
  );

export const getSellerProduct = async (req, res) =>
  send(res, {
    product: await service.getProduct(req.params.id, {
      sellerId: req.user._id,
    }),
  });

export const updateProduct = async (req, res) =>
  send(res, {
    product: await service.updateProduct(
      req.params.id,
      req.user._id,
      req.validated,
    ),
  });

export const submitProduct = async (req, res) =>
  send(res, {
    product: await service.submitProduct(
      req.params.id,
      req.user._id,
      req.validated,
    ),
  });

export const archiveProduct = async (req, res) =>
  send(res, {
    product: await service.archiveProduct(
      req.params.id,
      req.user._id,
      req.validated,
    ),
  });

export const listCategories = async (_req, res) =>
  send(res, await service.listCategories());

export const createCategory = async (req, res) =>
  send(res, { category: await service.createCategory(req.validated) }, 201);

export const updateCategory = async (req, res) =>
  send(res, {
    category: await service.updateCategory(req.params.id, req.validated),
  });

export const listProducts = async (req, res) =>
  send(res, await service.listProducts(req.validatedQuery));

export const reviewProduct = async (req, res) =>
  send(res, {
    product: await service.reviewProduct(
      req.params.id,
      req.user._id,
      req.validated,
    ),
  });
