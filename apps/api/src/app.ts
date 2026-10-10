import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { installAccessControl } from "./auth/access.js";
import { registerAuthRoutes } from "./auth/routes.js";
import type { PgBoss } from "pg-boss";
import { registerDocumentRoutes } from "./documents/routes.js";
import { registerRetrievalRoutes } from "./retrieval/routes.js";
import { registerAssessmentRoutes } from "./assessments/routes.js";

export function buildApp(boss: PgBoss) {
  const app = Fastify({
    logger: true,
  });

  app.register(cors, {
    origin: (process.env.CORS_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(","),
  });
  app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  app.register(swagger, {
    openapi: {
      info: {
        title: "RegCheck UZ API",
        description: "Document ingestion, processing, and policy evidence retrieval API.",
        version: "0.1.0",
      },
      tags: [{ name: "Documents", description: "Document ingestion and extraction status" }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "24-hour session token from organization sign-in" } },
        schemas: {
          Error: {
            type: "object",
            properties: { error: { type: "string" } },
            required: ["error"],
          },
        },
      },
    },
  });
  app.register(swaggerUi, {
    routePrefix: "/docs",
    staticCSP: true,
    uiConfig: { docExpansion: "list", deepLinking: false },
  });

  app.register(async (api) => {
    installAccessControl(api);
    registerAuthRoutes(api);
    api.get("/api/health", {
      schema: {
        tags: ["System"],
        security: [],
        summary: "Check API health",
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              service: { type: "string" },
            },
          },
        },
      },
    }, async () => ({ status: "ok", service: "regcheck-api" }));

    registerDocumentRoutes(api, boss);
    registerRetrievalRoutes(api);
    registerAssessmentRoutes(api, boss);
  });

  return app;
}
