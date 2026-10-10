import type { FastifyInstance } from "fastify";
import { EvidenceSearchError, searchPolicyEvidence, type SearchInput } from "./search.js";

export function registerRetrievalRoutes(app: FastifyInstance, search = searchPolicyEvidence) {
  app.post<{ Body: SearchInput }>("/api/policy-evidence/search", {
    schema: {
      tags: ["Retrieval"],
      summary: "Retrieve ranked policy passages with exact stored evidence references",
      description: "Search up to five selected policy/procedure snapshots in your authenticated organization workspace. Lexical search, not an AI assessment. Use synthetic demo data only.",
      body: {
        type: "object",
        additionalProperties: false,
        required: ["query", "policy_document_ids"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 4000 },
          policy_document_ids: {
            type: "array", minItems: 1, maxItems: 5, uniqueItems: true,
            items: { type: "string", format: "uuid" },
          },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 5 },
        },
      },
      response: {
        200: {
          type: "object",
          required: ["query", "retrieval_method", "passages", "limitations"],
          properties: {
            query: { type: "string" },
            retrieval_method: { type: "string", enum: ["postgresql_full_text_simple"] },
            limitations: { type: "array", items: { type: "string" } },
            passages: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  section_id: { type: "string", format: "uuid" },
                  document_id: { type: "string", format: "uuid" },
                  filename: { type: "string" },
                  version_label: { type: ["string", "null"] },
                  content_hash: { type: "string" },
                  heading: { type: ["string", "null"] },
                  content: { type: "string" },
                  source_reference: { type: ["string", "null"] },
                  page_start: { type: ["integer", "null"] },
                  page_end: { type: ["integer", "null"] },
                  score: { type: "number" },
                },
              },
            },
          },
        },
        ...Object.fromEntries([400, 404, 409].map((code) => [code, {
          type: "object", properties: { error: { type: "string" } }, required: ["error"],
        }])),
      },
    },
  }, async (request, reply) => {
    try {
      return await search({ ...request.body, organization_id: request.identity?.organization_id });
    } catch (error) {
      if (error instanceof EvidenceSearchError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
