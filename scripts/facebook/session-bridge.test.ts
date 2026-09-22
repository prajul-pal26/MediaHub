import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeCookies, inspectBridgePage, validateBridgeCookies } from "../../src/server/services/facebook/session-bridge-validation";
import { OPTIONS, POST } from "../../src/app/api/facebook/session-bridge/route";
import { FB_BRIDGE_EXTENSION_ID } from "../../src/lib/fb-bridge-config";

const page = (id: string) => `["CurrentUserInitialData",[],{"USER_ID":"${id}"}] ["DTSGInitialData",[],{"token":"fixture-token"}]`;

test("the bridge accepts only its paired account and named Facebook cookies", () => {
  assert.equal(bridgeCookies("c_user=123; xs=fixture; datr=fixture", "123"), "c_user=123; xs=fixture; datr=fixture");
  for (const raw of ["c_user=999; xs=fixture", "c_user=123", "c_user=123; xs=fixture; c_user=999", "c_user=123; xs=fixture; arbitrary=value"]) {
    assert.equal(bridgeCookies(raw, "123"), null);
  }
});

test("a fresh bridge validation requires Facebook's authenticated identity and token", () => {
  assert.equal(inspectBridgePage(page("123"), "123"), "fresh");
  assert.equal(inspectBridgePage(page("456"), "123"), "account_mismatch");
  assert.equal(inspectBridgePage(page("123").replace("DTSGInitialData", "OtherData"), "123"), "error");
});

test("unknown remote responses are not treated as a usable session", async () => {
  assert.equal(await validateBridgeCookies("fixture", "123", async () => new Response("unknown")), "error");
});

test("the local receiver rejects every origin and request that is not the fixed extension capability", async () => {
  const origin = `chrome-extension://${FB_BRIDGE_EXTENSION_ID}`;
  const request = (headers: Record<string, string>) => new Request("http://localhost:3010/api/facebook/session-bridge", { method: "POST", headers });
  assert.equal((await POST(request({ host: "localhost:3010", origin: "http://localhost:3000" }))).status, 403);
  assert.equal((await POST(request({ host: "localhost:3000", origin }))).status, 403);
  assert.equal((await POST(request({ host: "localhost:3010", origin }))).status, 401);
  assert.equal((await POST(request({ host: "localhost:3010", origin, authorization: `Bearer ${"a".repeat(64)}` }))).status, 400);
  const preflight = await OPTIONS(request({ host: "localhost:3010", origin }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
});
