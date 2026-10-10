import { buildApp } from "./app.js";
import { migrate, pool } from "./db.js";
import { createJobQueue, DOCUMENT_QUEUE } from "./documents/queue.js";

const boss = createJobQueue();
const port = Number(process.env.API_PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
let app: ReturnType<typeof buildApp> | undefined;

try {
  await migrate();
  boss.on("error", (error) => console.error("pg-boss error", error));
  await boss.start();
  await boss.createQueue(DOCUMENT_QUEUE);
  app = buildApp(boss);
  await app.listen({ port, host });
} catch (error) {
  console.error(error);
  process.exit(1);
}

async function shutdown() {
  await app?.close();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await pool.end();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
