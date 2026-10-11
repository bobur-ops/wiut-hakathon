import assert from "node:assert/strict";
import test from "node:test";
import { api, sessionToken, setSessionToken } from "../src/api.ts";

test("session requests use shared cookies and expire the workspace only on unauthorized responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const saved = new Map<string, string>();
  const events = new EventTarget();
  let expired = 0;
  events.addEventListener("regcheck-session-expired", () => expired++);
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  try {
    saved.set("regcheck-session","legacy-tab-token");
    setSessionToken(null);
    assert.equal(saved.has("regcheck-session"),false);
    globalThis.fetch = async (_url, options) => {
      assert.equal(new Headers(options?.headers).get("authorization"), null);
      assert.equal(options?.credentials,"include");
      return new Response(JSON.stringify({ identity: { organization_id: "organization-a" } }), { status: 200 });
    };
    for (let reload = 0; reload < 2; reload++) {
      const response = await api<{ identity: { organization_id: string } }>("/api/auth/me");
      assert.equal(response.identity.organization_id, "organization-a");
      assert.equal(sessionToken(), null);
    }

    globalThis.fetch = async () => { throw new TypeError("Network unavailable"); };
    await assert.rejects(api("/api/auth/me"), /Network unavailable/);
    assert.equal(sessionToken(), null);

    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Temporary server error" }), { status: 503 });
    await assert.rejects(api("/api/auth/me"), /Temporary server error/);
    assert.equal(sessionToken(), null);
    assert.equal(expired, 0);

    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: "Old session expired" }), { status: 401 });
    };
    await assert.rejects(api("/api/auth/me"), /Old session expired/);
    assert.equal(sessionToken(), null);
    assert.equal(expired, 1);

    globalThis.fetch = async () => new Response(JSON.stringify({ error: "Session expired" }), { status: 401 });
    await assert.rejects(api("/api/auth/me"), /Session expired/);
    assert.equal(sessionToken(), null);
    assert.equal(expired, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
