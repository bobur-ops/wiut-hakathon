import assert from "node:assert/strict";
import test from "node:test";
import { configuredRecipientAllowlist, isAllowedNotificationRecipient } from "../src/notifications/recipients.js";

test("configured notification allowlist normalizes addresses and blocks other recipients",()=>{
  assert.deepEqual(configuredRecipientAllowlist(" BoburKomilovv@gmail.com, other@example.com, boburkomilovv@gmail.com "),
    ["boburkomilovv@gmail.com","other@example.com"]);
  assert.equal(isAllowedNotificationRecipient("BOBURKOMILOVV@gmail.com","boburkomilovv@gmail.com"),true);
  assert.equal(isAllowedNotificationRecipient("other@example.com","boburkomilovv@gmail.com"),false);
  assert.equal(isAllowedNotificationRecipient("other@example.com",""),true);
});
