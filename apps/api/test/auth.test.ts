import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import test from "node:test";
import type { PgBoss } from "pg-boss";
import { hashPassword, hashToken, sessionCookie, sessionTokenFromHeaders, verifyPassword } from "../src/auth/security.js";
import { buildApp } from "../src/app.js";
import { migrate, pool } from "../src/db.js";
import { getStoredFilePath } from "../src/documents/storage.js";

test("passwords are salted and sessions are hashed", async () => {
  const first = await hashPassword("synthetic-password-123");
  const second = await hashPassword("synthetic-password-123");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("synthetic-password-123", first), true);
  assert.equal(await verifyPassword("wrong-password", first), false);
  assert.equal(await verifyPassword("anything", "broken"), false);
  assert.equal(hashToken("token").length, 64);
  assert.notEqual(hashToken("token"), "token");
});

test("session credentials can be read from HttpOnly cookie headers with bearer compatibility",()=>{
  const token="a".repeat(64);
  assert.equal(sessionTokenFromHeaders(undefined,`theme=dark; regcheck_session=${token}; path=/`),token);
  assert.equal(sessionTokenFromHeaders(`Bearer ${token}`,`regcheck_session=${"b".repeat(64)}`),token);
  assert.equal(sessionTokenFromHeaders(undefined,"regcheck_session=not-a-token"),null);
  assert.match(sessionCookie(token),/HttpOnly/);
  assert.match(sessionCookie(token),/SameSite=Lax/);
  assert.match(sessionCookie(null),/Max-Age=0/);
});

test("organization API enforces authentication, document/assessment isolation, grouping, and logout", {
  skip: process.env.RUN_DB_TESTS !== "1",
}, async () => {
  await migrate();
  const boss = { send: async () => randomUUID() } as unknown as PgBoss;
  const app = buildApp(boss);
  const orgIds: string[] = [];
  const tokens: string[] = [];
  const cookies: string[] = [];
  const emails: string[] = [];
  const documentIds: string[] = [];
  const assessmentId = randomUUID();
  let groupId: string | undefined;
  try {
    const unauthenticated = await app.inject({ method: "GET", url: "/api/documents" });
    assert.equal(unauthenticated.statusCode, 401);
    for (const suffix of ["a", "b"]) {
      const email = `${randomUUID()}-${suffix}@example.com`;
      emails.push(email);
      const register = await app.inject({ method: "POST", url: "/api/auth/register", payload: {
        email, password: "test-only-password-123", name: `Test Bank ${suffix}`, organization_type: "commercial_bank",
      } });
      assert.equal(register.statusCode, 201, register.body);
      orgIds.push(register.json().identity.organization_id);
      const setCookie=register.headers["set-cookie"];
      assert.equal(typeof setCookie,"string");
      assert.match(setCookie as string,/HttpOnly/);
      cookies.push((setCookie as string).split(";",1)[0]!);
      tokens.push(cookies.at(-1)!.split("=",2)[1]!);
    }
    const authA = { authorization: `Bearer ${tokens[0]}` };
    const authB = { authorization: `Bearer ${tokens[1]}` };
    for (let reload = 0; reload < 2; reload++) {
      const restored = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie:cookies[0]! } });
      assert.equal(restored.statusCode, 200, restored.body);
      assert.equal(restored.json().identity.organization_id, orgIds[0]);
    }
    const wrongLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: emails[0], password: "wrong-password-123" } });
    assert.equal(wrongLogin.statusCode, 401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: emails[0]!.toUpperCase(), password: "test-only-password-123" } });
    assert.equal(login.statusCode, 200);
    assert.equal(login.json().identity.organization_id, orgIds[0]);
    const loginCookie=String(login.headers["set-cookie"]).split(";",1)[0]!;
    const loginToken=loginCookie.split("=",2)[1]!;
    await pool.query("UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE token_hash = $1", [hashToken(loginToken)]);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie:loginCookie } })).statusCode, 401);
    const boundary = "regcheck-test-boundary";
    const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="synthetic-test.txt"\r\nContent-Type: text/plain\r\n\r\nSynthetic policy: retain customer records.\r\n--${boundary}\r\nContent-Disposition: form-data; name="document_type"\r\n\r\npolicy\r\n--${boundary}--\r\n`;
    const uploaded = await app.inject({ method: "POST", url: "/api/documents", headers: { ...authA, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: multipart });
    assert.equal(uploaded.statusCode, 202, uploaded.body);
    const docId = uploaded.json().document_id as string;
    documentIds.push(docId); groupId = uploaded.json().document_group_id;
    const listA = await app.inject({ method: "GET", url: "/api/documents?document_type=policy", headers: authA });
    assert.equal(listA.statusCode, 200);
    assert.ok(listA.json().documents.some((item: { id: string }) => item.id === docId));
    const listB = await app.inject({ method: "GET", url: "/api/documents?document_type=policy", headers: authB });
    assert.deepEqual(listB.json().documents, []);
    const groupsB = await app.inject({ method: "GET", url: "/api/document-groups", headers: authB });
    assert.ok(!groupsB.json().documents.some((item: { id: string }) => item.id === groupId));
    for (const url of [`/api/documents/${docId}`, `/api/documents/${docId}/sections`, `/api/document-groups/${groupId}/versions`]) {
      const foreign = await app.inject({ method: "GET", url, headers: authB });
      assert.equal(foreign.statusCode, 404, url);
    }
    const search = await app.inject({ method: "POST", url: "/api/policy-evidence/search", headers: authB, payload: { query: "customer records", policy_document_ids: [docId] } });
    assert.equal(search.statusCode, 404);
    const foreignAssessment = await app.inject({ method: "POST", url: "/api/assessments", headers: authB, payload: { policy_document_ids: [docId] } });
    assert.equal(foreignAssessment.statusCode, 404);
    for (const [type, owner, allowedB] of [["regulation", null, true], ["regulation", orgIds[0], false], ["policy", null, false]] as const) {
      const id = randomUUID(); documentIds.push(id);
      await pool.query(`INSERT INTO documents (id, filename, mime_type, file_size_bytes, storage_key, content_hash, document_type, processing_status, organization_id)
        VALUES ($1, 'synthetic-visibility.txt', 'text/plain', 10, $2, 'test-hash', $3, 'COMPLETED', $4)`, [id, `test-${id}.txt`, type, owner]);
      const visible = await app.inject({ method: "GET", url: `/api/documents/${id}`, headers: authB });
      assert.equal(visible.statusCode, allowedB ? 200 : 404);
    }
    const updateMultipart = multipart.replace(`--${boundary}--`, `--${boundary}\r\nContent-Disposition: form-data; name="document_group_id"\r\n\r\n${groupId}\r\n--${boundary}--`);
    const foreignGroup = await app.inject({ method: "POST", url: "/api/documents", headers: { ...authB, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: updateMultipart });
    assert.equal(foreignGroup.statusCode, 400);
    await pool.query(`INSERT INTO assessments (id, status, assessment_date, policy_document_ids, obligations, organization_id)
      VALUES ($1, 'COMPLETED', CURRENT_DATE, $2, '[]', $3)`, [assessmentId, [docId], orgIds[0]]);
    assert.equal((await app.inject({ method: "GET", url: `/api/assessments/${assessmentId}`, headers: authA })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: `/api/assessments/${assessmentId}`, headers: authB })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/assessments/${assessmentId}/cancel`, headers: authB, payload: {} })).statusCode, 404);
    const runsB = await app.inject({ method: "GET", url: "/api/assessments", headers: authB });
    assert.deepEqual(runsB.json().assessments, []);
    const findingId = randomUUID();
    await pool.query(`INSERT INTO findings (id, assessment_id, obligation_id, classification, applicability, explanation, proposed_action)
      VALUES ($1, $2, 'synthetic', 'REQUIRES_REVIEW', 'UNCERTAIN', 'Test finding', 'Review it')`, [findingId, assessmentId]);
    const reviewBody = { decision: "NEEDS_EVIDENCE", reviewer_identifier: "spoofed-reviewer", comment: "Synthetic test" };
    assert.equal((await app.inject({ method: "POST", url: `/api/findings/${findingId}/review`, headers: authB, payload: reviewBody })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/api/findings/${findingId}/review`, headers: authA, payload: reviewBody })).statusCode, 200);
    const savedReviews = await app.inject({ method: "GET", url: `/api/findings/${findingId}/reviews`, headers: authA });
    assert.notEqual(savedReviews.json().reviews[0].reviewer_identifier, "spoofed-reviewer");
    assert.equal((await app.inject({ method: "GET", url: `/api/findings/${findingId}/reviews`, headers: authB })).statusCode, 404);
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie:cookies[0]! } });
    assert.equal(logout.statusCode, 204);
    assert.match(String(logout.headers["set-cookie"]),/Max-Age=0/);
    assert.equal((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie:cookies[0]! } })).statusCode, 401);
  } finally {
    await app.close();
    const files = await pool.query("SELECT storage_key FROM documents WHERE id = ANY($1::uuid[])", [documentIds]);
    for (const row of files.rows) await unlink(getStoredFilePath(row.storage_key)).catch(() => undefined);
    await pool.query("DELETE FROM assessments WHERE id = $1", [assessmentId]);
    await pool.query("DELETE FROM documents WHERE id = ANY($1::uuid[])", [documentIds]);
    if (groupId) await pool.query("DELETE FROM document_groups WHERE id = $1", [groupId]);
    await pool.query("DELETE FROM users WHERE organization_id = ANY($1::uuid[])", [orgIds]);
    await pool.query("DELETE FROM organizations WHERE id = ANY($1::uuid[])", [orgIds]);
    await pool.end();
  }
});
