import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __test } from "../cloudflare/_worker.js";

describe("Cloudflare Pages Feishu authentication gateway", () => {
  it("accepts JSON and comma-separated tenant allowlists", () => {
    assert.deepEqual(__test.allowedTenantKeys({ ALLOWED_TENANT_KEYS: '["tenant-a","tenant-b"]' }), ["tenant-a", "tenant-b"]);
    assert.deepEqual(__test.allowedTenantKeys({ ALLOWED_TENANT_KEYS: "tenant-a, tenant-b" }), ["tenant-a", "tenant-b"]);
  });

  it("rejects malformed tenant allowlists", () => {
    assert.deepEqual(__test.allowedTenantKeys({ ALLOWED_TENANT_KEYS: "[broken" }), []);
  });

  it("allows only same-origin relative return paths", () => {
    assert.equal(__test.safeReturnTo("/prd/prd_v1.0.html?x=1#details"), "/prd/prd_v1.0.html?x=1#details");
    assert.equal(__test.safeReturnTo("https://evil.example/steal"), "/");
    assert.equal(__test.safeReturnTo("//evil.example/steal"), "/");
    assert.equal(__test.safeReturnTo("/\\evil.example"), "/");
  });

  it("signs, verifies, and detects tampering", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await __test.signPayload({ sub: "ou_test", tenant: "tenant-a", exp: now + 60 }, "a sufficiently long test secret");
    const payload = await __test.verifyPayload(token, "a sufficiently long test secret");
    assert.equal(payload.sub, "ou_test");
    assert.equal(payload.tenant, "tenant-a");
    assert.equal(await __test.verifyPayload(`${token}tampered`, "a sufficiently long test secret"), null);
    assert.equal(await __test.verifyPayload(token, "wrong secret"), null);
  });

  it("rejects expired sessions", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await __test.signPayload({ sub: "ou_test", tenant: "tenant-a", exp: now - 1 }, "a sufficiently long test secret");
    assert.equal(await __test.verifyPayload(token, "a sufficiently long test secret"), null);
  });

  it("fails closed when required secrets are absent", () => {
    assert.deepEqual(__test.missingConfiguration({}), [
      "FEISHU_APP_ID",
      "FEISHU_APP_SECRET",
      "ALLOWED_TENANT_KEYS",
      "SESSION_SECRET",
    ]);
    assert.deepEqual(
      __test.missingConfiguration({
        FEISHU_APP_ID: "app",
        FEISHU_APP_SECRET: "secret",
        ALLOWED_TENANT_KEYS: "tenant",
        SESSION_SECRET: "session",
      }),
      [],
    );
  });
});
