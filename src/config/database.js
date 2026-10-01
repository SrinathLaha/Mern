import mongoose from "mongoose";

export async function connectDatabase(uri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  // Ensure uniqueness exists before accepting the first registration.
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
}
