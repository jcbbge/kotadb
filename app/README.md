# KotaDB Application

HTTP API service for code indexing and search. See [../README.md](../README.md) for full documentation.

## Quick Start

```bash
# Install dependencies
bun install

# Start server (requires SurrealDB running)
bun run src/index.ts
```

Server starts on `http://localhost:3099` by default.

## Available Tools

KotaDB exposes **24 MCP tools** across 4 tiers:

| Tier | Count | Tools |
|------|-------|-------|
| Core | 14 | search, index_repository, update_repository, list_repositories, remove_repository, list_recent_files, search_dependencies, find_usages, analyze_change_impact, get_index_statistics, validate_implementation_spec, generate_task_context, semantic_search, search_symbol_exact |
| Sync | 2 | kota_sync_export, kota_sync_import |
| Memory | 3 | record_decision, record_failure, record_insight |
| Expertise | 5 | get_domain_key_files, validate_expertise, sync_expertise, get_recent_patterns, search_chunks |

See [../TOOLS.md](../TOOLS.md) for detailed reference.

## API Endpoints

- `GET /health` - Health check
- `POST /mcp` - MCP tool execution
- `GET /search?q=term` - Quick search endpoint

## Development

```bash
# Development with watch
bun --watch src/index.ts

# Run tests
bun test

# Type check
bunx tsc --noEmit
```

## Project Structure

```
src/
  api/          # HTTP routes and handlers
  db/           # SurrealDB client and schema
  indexer/      # Repository indexing (git + AST)
  mcp/          # MCP tool definitions and implementations
  types/        # TypeScript types
  cli.ts        # CLI entry point
  index.ts      # Server entry point
```

## Configuration

Environment variables (see `.env.example`):

```bash
SURREAL_URL=ws://127.0.0.1:8002/rpc
SURREAL_NS=kotadb
SURREAL_DB=index
PORT=3099
```
