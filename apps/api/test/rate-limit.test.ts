import assert from "node:assert/strict";
import test from "node:test";
import type { PgBoss } from "pg-boss";
import { buildApp } from "../src/app.js";

test("development disables both global and route-specific rate limits", async () => {
  const original = process.env.RATE_LIMIT_ENABLED;
  delete process.env.RATE_LIMIT_ENABLED;
  const app = buildApp({} as PgBoss);
  app.get("/dev-limit-test", { config: { rateLimit: { max: 1, timeWindow: "1 minute" } } }, async () => ({ ok: true }));
  try {
    for (let i = 0; i < 125; i++) {
      const response = await app.inject({ method: "GET", url: "/dev-limit-test" });
      assert.equal(response.statusCode, 200);
    }
  } finally {
    await app.close();
    if (original === undefined) delete process.env.RATE_LIMIT_ENABLED; else process.env.RATE_LIMIT_ENABLED = original;
  }
});
