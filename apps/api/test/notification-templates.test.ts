import assert from "node:assert/strict";
import test from "node:test";
import { renderNotificationEmail } from "../src/notifications/templates.js";

test("assessment email template is branded, event-specific, and retains a plain-text fallback", () => {
  const result=renderNotificationEmail({type:"ASSESSMENT_COMPLETED",subject:"Assessment ready",body:"12 findings; 3 need attention.\nOpen: https://example.test/assessments/123"});
  assert.match(result.html,/REGCHECK/);
  assert.match(result.html,/Your assessment is ready/);
  assert.match(result.html,/Human review required/);
  assert.match(result.html,/Open RegCheck workspace/);
  assert.match(result.html,/https:\/\/example\.test\/assessments\/123/);
  assert.match(result.text,/12 findings/);
});

test("dynamic notification content is escaped and preliminary legislation keeps its triage warning", () => {
  const result=renderNotificationEmail({type:"LIKELY_RELEVANT_LEGISLATION",subject:"<script>bad</script>",body:"Act: <img src=x onerror=alert(1)>"});
  assert.match(result.html,/PRELIMINARY TRIAGE/);
  assert.match(result.html,/&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(result.html,/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(result.html,/<script>|<img/);
});
