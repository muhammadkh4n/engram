# openclaw-memory

OpenClaw Context Engine plugin — three-tier memory with automatic ingestion and semantic retrieval via pgvector.

## Architecture

- **Episodes** — Raw conversation turns with embeddings
- **Digests** — Session summaries with key topics
- **Knowledge** — Distilled facts, preferences, and rules

## Setup

```bash
npm install
npm test
npm run build
```

### Database Migrations

```bash
psql $DATABASE_URL < migrations/001_initial_schema.sql
psql $DATABASE_URL < migrations/002_search_functions.sql
```

## License

MIT
