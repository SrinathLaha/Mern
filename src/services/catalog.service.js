import mongoose from "mongoose";
import { Category } from "../models/category.model.js";
import { Product } from "../models/product.model.js";
import { ApiError } from "../utils/errors.js";

const objectId = (value) => new mongoose.Types.ObjectId(value);
function requireId(id, resource = "Product") {
  if (!mongoose.isObjectIdOrHexString(id))
    throw new ApiError(404, `${resource} not found.`);
}
async function uniqueWrite(operation, message) {
  try {
    return await operation();
  } catch (error) {
    if (error.code === 11000) throw new ApiError(409, message);
    throw error;
  }
}
const categoryView = (category) => ({
  id: String(category._id),
  name: category.name,
  description: category.description,
  active: category.active,
  version: category.version,
});
export async function listCategories(publicOnly = false) {
  const categories = await Category.find(publicOnly ? { active: true } : {})
    .sort({ normalizedName: 1, _id: 1 })
    .lean();
  return { categories: categories.map(categoryView) };
}
export async function createCategory(data) {
  return categoryView(
    await uniqueWrite(
      () =>
        Category.create({ ...data, normalizedName: data.name.toLowerCase() }),
      "A category already uses this name.",
    ),
  );
}
export async function updateCategory(id, data) {
  requireId(id, "Category");
  const { version, ...fields } = data;
  const category = await uniqueWrite(
    () =>
      Category.findOneAndUpdate(
        { _id: id, version },
        {
          $set: { ...fields, normalizedName: data.name.toLowerCase() },
          $inc: { version: 1 },
        },
        { returnDocument: "after" },
      ),
    "A category already uses this name.",
  );
  if (!category) {
    if (!(await Category.exists({ _id: id })))
      throw new ApiError(404, "Category not found.");
    throw new ApiError(409, "This category changed. Reload before editing it.");
  }
  return categoryView(category);
}
function paise(price) {
  const [whole, fraction = ""] = price.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
function decimal(value) {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}
async function editableFields(data) {
  if (
    new Set(data.variants.map((variant) => variant.sku)).size !==
    data.variants.length
  )
    throw new ApiError(409, "Each variant must have a unique SKU.");
  if (!(await Category.exists({ _id: data.categoryId })))
    throw new ApiError(422, "Choose an existing category.");
  return {
    title: data.title,
    description: data.description,
    categoryId: data.categoryId,
    images: data.images,
    variants: data.variants.map(({ price, ...variant }) => ({
      ...variant,
      pricePaise: paise(price),
    })),
  };
}
function productView(product, publicOnly = false) {
  return {
    id: String(product._id),
    title: product.title,
    description: product.description,
    categoryId: String(product.categoryId),
    categoryName: product.category?.name ?? "",
    storeName: product.seller?.storeName ?? "",
    images: product.images.map(({ url, alt }) => ({ url, alt })),
    variants: product.variants.map(({ sku, label, pricePaise, stock }) => ({
      sku,
      label,
      price: decimal(pricePaise),
      stock,
    })),
    createdAt: product.createdAt,
    ...(!publicOnly
      ? {
          status: product.status,
          version: product.version,
          reviewNote: product.reviewNote ?? "",
        }
      : {}),
  };
}
function joins(publicOnly) {
  return [
    {
      $lookup: {
        from: "categories",
        localField: "categoryId",
        foreignField: "_id",
        as: "category",
        pipeline: [{ $project: { name: 1, active: 1 } }],
      },
    },
    { $unwind: { path: "$category", preserveNullAndEmptyArrays: !publicOnly } },
    {
      $lookup: {
        from: "users",
        localField: "sellerId",
        foreignField: "_id",
        as: "seller",
        pipeline: [
          { $project: { storeName: 1, role: 1, status: 1, sellerStatus: 1 } },
        ],
      },
    },
    { $unwind: { path: "$seller", preserveNullAndEmptyArrays: !publicOnly } },
    ...(publicOnly
      ? [
          {
            $match: {
              "category.active": true,
              "seller.role": "seller",
              "seller.status": "active",
              "seller.sellerStatus": "approved",
            },
          },
        ]
      : []),
  ];
}
export async function getProduct(id, { sellerId, publicOnly = false } = {}) {
  requireId(id);
  const [product] = await Product.aggregate([
    {
      $match: {
        _id: objectId(id),
        ...(sellerId ? { sellerId: objectId(sellerId) } : {}),
        ...(publicOnly ? { status: "approved" } : {}),
      },
    },
    ...joins(publicOnly),
    { $project: { reviews: 0 } },
  ]);
  if (!product) throw new ApiError(404, "Product not found.");
  return productView(product, publicOnly);
}
export async function createProduct(sellerId, data) {
  const fields = await editableFields(data);
  const product = await uniqueWrite(
    () => Product.create({ ...fields, sellerId }),
    "This seller already uses one of these SKUs.",
  );
  return getProduct(String(product._id), { sellerId });
}
async function ownedProduct(id, sellerId) {
  requireId(id);
  const product = await Product.findOne({ _id: id, sellerId });
  if (!product) throw new ApiError(404, "Product not found.");
  return product;
}
function checkVersion(product, version) {
  if (product.version !== version)
    throw new ApiError(409, "This product changed. Reload before continuing.");
}
async function mutateProduct(filter, update, sellerId) {
  const product = await uniqueWrite(
    () =>
      Product.findOneAndUpdate(
        {
          ...filter,
          ...(sellerId
            ? {
                variants: {
                  $not: {
                    $elemMatch: {
                      $or: [
                        { reserved: { $gt: 0 } },
                        { committed: { $gt: 0 } },
                      ],
                    },
                  },
                },
              }
            : {}),
        },
        { ...update, $inc: { version: 1 } },
        { returnDocument: "after" },
      ),
    "This seller already uses one of these SKUs.",
  );
  if (!product)
    throw new ApiError(
      409,
      "This product changed or has reserved or committed inventory. Reload and wait for orders to finish before editing.",
    );
  return getProduct(String(product._id), { sellerId });
}
export async function updateProduct(id, sellerId, data) {
  const current = await ownedProduct(id, sellerId);
  checkVersion(current, data.version);
  if (current.status === "archived")
    throw new ApiError(409, "Archived products cannot be edited.");
  const fields = await editableFields(data);
  return mutateProduct(
    { _id: id, sellerId, version: data.version, status: { $ne: "archived" } },
    { $set: { ...fields, status: "draft", reviewNote: "" } },
    sellerId,
  );
}
export async function submitProduct(id, sellerId, { version }) {
  const current = await ownedProduct(id, sellerId);
  checkVersion(current, version);
  if (!["draft", "rejected"].includes(current.status))
    throw new ApiError(
      409,
      "Only draft or rejected products can be submitted.",
    );
  if (!current.images.length)
    throw new ApiError(422, "Add at least one image before submitting.");
  if (!(await Category.exists({ _id: current.categoryId, active: true })))
    throw new ApiError(422, "Choose an active category before submitting.");
  return mutateProduct(
    { _id: id, sellerId, version, status: { $in: ["draft", "rejected"] } },
    { $set: { status: "pending", reviewNote: "" } },
    sellerId,
  );
}
export async function archiveProduct(id, sellerId, { version }) {
  const current = await ownedProduct(id, sellerId);
  checkVersion(current, version);
  if (current.status === "archived")
    throw new ApiError(409, "This product is already archived.");
  return mutateProduct(
    { _id: id, sellerId, version, status: { $ne: "archived" } },
    { $set: { status: "archived" } },
    sellerId,
  );
}
export async function reviewProduct(id, reviewerId, data) {
  requireId(id);
  if (!(await Product.exists({ _id: id })))
    throw new ApiError(404, "Product not found.");
  return mutateProduct(
    { _id: id, version: data.version, status: "pending" },
    {
      $set: { status: data.decision, reviewNote: data.reason ?? "" },
      $push: {
        reviews: {
          $each: [
            {
              decision: data.decision,
              reason: data.reason ?? "",
              reviewedBy: reviewerId,
              reviewedAt: new Date(),
              productVersion: data.version,
            },
          ],
          $slice: -50,
        },
      },
    },
  );
}
export async function listProducts(
  query,
  { sellerId, publicOnly = false } = {},
) {
  const match = {
    ...(sellerId ? { sellerId: objectId(sellerId) } : {}),
    ...(publicOnly
      ? { status: "approved" }
      : query.status !== "all"
        ? { status: query.status }
        : {}),
  };
  if (publicOnly) {
    if (query.categoryId) match.categoryId = objectId(query.categoryId);
    if (query.search) {
      const regex = query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      match.$or = [
        { title: { $regex: regex, $options: "i" } },
        { description: { $regex: regex, $options: "i" } },
      ];
    }
    const variant = {};
    if (query.inStock) variant.stock = { $gt: 0 };
    if (query.minPrice !== undefined || query.maxPrice !== undefined)
      variant.pricePaise = {
        ...(query.minPrice !== undefined
          ? { $gte: paise(query.minPrice) }
          : {}),
        ...(query.maxPrice !== undefined
          ? { $lte: paise(query.maxPrice) }
          : {}),
      };
    if (Object.keys(variant).length) match.variants = { $elemMatch: variant };
  }
  const sort =
    query.sort === "priceAsc"
      ? { lowestPrice: 1, _id: 1 }
      : query.sort === "priceDesc"
        ? { lowestPrice: -1, _id: 1 }
        : { createdAt: -1, _id: -1 };
  const [result] = await Product.aggregate([
    { $match: match },
    ...joins(publicOnly),
    {
      $facet: {
        products: [
          { $set: { lowestPrice: { $min: "$variants.pricePaise" } } },
          { $sort: sort },
          { $skip: (query.page - 1) * query.limit },
          { $limit: query.limit },
          { $project: { reviews: 0 } },
        ],
        count: [{ $count: "total" }],
      },
    },
  ]);
  return {
    products: result.products.map((product) =>
      productView(product, publicOnly),
    ),
    total: result.count[0]?.total ?? 0,
    page: query.page,
    limit: query.limit,
  };
}
