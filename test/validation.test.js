import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registration,
  forgotPassword,
  resetPassword,
  login,
} from "../src/validation/auth.validation.js";

const customer = {
  name: "Asha Sharma",
  email: "asha@example.test",
  phone: "+91 9876543210",
  password: "A long passphrase!",
  accountType: "customer",
};
test("registration rejects punctuation-only phones, too many digits and blank passwords", () => {
  for (const phone of [
    "-------",
    "() () ()",
    "+1234567890123456",
    "123456",
    "+91 abc 1234567",
  ])
    assert.equal(
      registration.safeParse({ ...customer, phone }).success,
      false,
      phone,
    );
  assert.equal(
    registration.safeParse({ ...customer, password: "        " }).success,
    false,
  );
  assert.equal(
    registration.safeParse({ ...customer, name: "1234" }).success,
    false,
  );
});
test("shared rules normalize identifiers but preserve passwords and support Unicode names", () => {
  const parsed = registration.parse({
    ...customer,
    name: "  శ్రీనివాస్  ",
    email: " ASHA@EXAMPLE.TEST ",
    password: "  My passphrase!  ",
  });
  assert.equal(parsed.name, "శ్రీనివాస్");
  assert.equal(parsed.email, "asha@example.test");
  assert.equal(parsed.password, "  My passphrase!  ");
  assert.equal(
    forgotPassword.safeParse({ email: "asha@localhost" }).success,
    false,
  );
  assert.equal(
    login.safeParse({ email: customer.email, password: "old" }).success,
    true,
  );
});
test("missing input and confirmation produce actionable first errors", () => {
  for (const email of [undefined, "", "   "]) {
    const result = forgotPassword.safeParse({ email });
    assert.equal(result.success, false);
    assert.equal(result.error.issues[0].message, "Enter your email address.");
  }
  const result = resetPassword.safeParse({
    token: "a".repeat(64),
    password: "A long passphrase!",
    confirmPassword: "",
  });
  assert.equal(
    result.error.issues.find((issue) => issue.path[0] === "confirmPassword")
      .message,
    "Confirm your new password.",
  );
});
