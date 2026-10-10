import cors from "@fastify/cors";
import Fastify from "fastify";

export function buildApp() {
  const app = Fastify({
    logger: true,
  });

  app.register(cors, {
    origin: true,
  });

  app.get("/api/health", async () => ({
    status: "ok",
    service: "regcheck-api",
  }));

  return app;
}
