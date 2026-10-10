import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import type { PgBoss } from "pg-boss";
import { registerDocumentRoutes } from "./documents/routes.js";

export function buildApp(boss: PgBoss) {
  const app = Fastify({
    logger: true,
  });

  app.register(cors, {
    origin: true,
  });
  app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  app.register(swagger, {
    openapi: {
      info: {
        title: "RegCheck UZ API",
        description: "Document ingestion and processing API.",
        version: "0.1.0",
      },
      tags: [{ name: "Documents", description: "Document ingestion and extraction status" }],
      components: {
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
    api.get("/api/health", {
      schema: {
        tags: ["System"],
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
  });

  return app;
}
