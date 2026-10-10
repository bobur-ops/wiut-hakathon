# RegCheck UZ

Starter monorepo for the RegCheck UZ frontend and backend. This setup contains
only the application foundation; regulatory monitoring and compliance workflows
are not implemented yet.

## Stack

- Frontend: React, TypeScript, Vite, Ant Design
- Backend: Node.js, TypeScript, Fastify
- Database service: PostgreSQL (provisioned in Compose; application persistence
  is not wired up yet)
- Local containers: Docker Compose

## Run locally with Docker

```sh
cp .env.example .env
docker compose up --build
```

- Web: http://localhost:5173
- API health check: http://localhost:3000/api/health
- PostgreSQL: localhost:5432

## Run the apps without Docker

Requires Node.js 22 or newer.

```sh
npm install
npm run dev
```

The frontend runs on port 5173 and the API on port 3000. PostgreSQL can be
started separately with `docker compose up db`.

## Checks

```sh
npm run typecheck
npm run build
```
