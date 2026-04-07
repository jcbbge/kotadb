# KotaDB

**Local code intelligence for Claude Code.**

Index your codebase once. Search, analyze, and understand it instantly.

## What It Does

KotaDB gives Claude Code superpowers for understanding your codebase:

- **Semantic Code Search** - Find code by meaning, not just text matching
- **Dependency Analysis** - See exactly what breaks when you change a file
- **Symbol Tracking** - Find where functions, classes, and types are used
- **Change Impact Analysis** - Know the blast radius before you refactor
- **Zero Cloud** - Everything runs locally on SurrealDB

## Quick Start

### 1. Start SurrealDB

```bash
surreal start --bind 127.0.0.1:8002 --user root --pass root file://~/.kotadb/surreal.db
```

### 2. Start KotaDB

```bash
cd app
bun run src/index.ts
```

Server runs on `http://localhost:3099`

### 3. Index a Repository

```bash
curl -X POST http://localhost:3099/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "index_repository",
    "params": { "repository": "owner/repo" }
  }'
```

### 4. Search Your Code

```bash
curl -X POST http://localhost:3099/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "search",
    "params": { 
      "query": "database connection",
      "scope": ["code"],
      "output": "snippet"
    }
  }'
```

## MCP Tools (24 Total)

### Core Tools (14)
- `search` - Search code, symbols, decisions, patterns
- `index_repository` - Clone and index a repo
- `update_repository` - Update to new version
- `list_repositories` - List indexed repos
- `remove_repository` - Remove a repo
- `list_recent_files` - Recently indexed files
- `search_dependencies` - File dependency graph
- `find_usages` - Find symbol usages
- `analyze_change_impact` - Impact analysis for changes
- `get_index_statistics` - Database stats
- `validate_implementation_spec` - Validate against specs
- `generate_task_context` - Context for files
- `semantic_search` - Vector + BM25 search
- `search_symbol_exact` - Fast symbol lookup

### Data Tools (2)
- `kota_sync_export` - Export to JSONL
- `kota_sync_import` - Import from JSONL

### Memory Tools (3)
- `record_decision` - Record architectural decisions
- `record_failure` - Log failed approaches
- `record_insight` - Session observations

### Expertise Tools (5)
- `get_domain_key_files` - Domain-specific key files
- `validate_expertise` - Pattern validation
- `sync_expertise` - Sync expertise files
- `get_recent_patterns` - Recent patterns
- `search_chunks` - Chunk-level search

See [TOOLS.md](TOOLS.md) for complete reference.

## CLI Usage

```bash
# Start server
kotadb

# Custom port
kotadb --port 4000

# Query dependencies
kotadb deps --file src/db/client.ts

# Toolset selection (core, default, memory, full)
kotadb --toolset core
```

## Configuration

### Environment Variables

```bash
# SurrealDB connection
SURREAL_URL=ws://127.0.0.1:8002/rpc
SURREAL_NS=kotadb
SURREAL_DB=index
SURREAL_USER=root
SURREAL_PASS=root

# Server
PORT=3099
```

### MCP Client Setup

Add to your Claude Code MCP config (`~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "kotadb": {
      "url": "http://localhost:3099/mcp"
    }
  }
}
```

## Architecture

- **Database**: SurrealDB (local, file-backed)
- **Server**: Bun + Express HTTP API
- **Protocol**: Model Context Protocol (MCP)
- **Indexing**: Tree-sitter for AST parsing
- **Search**: BM25 + optional vector embeddings

## Project Structure

```
app/
  src/
    api/        # HTTP routes
    db/         # SurrealDB client
    indexer/    # Git + AST indexing
    mcp/        # MCP tools (24 tools)
  tests/        # Test suite
```

## Development

```bash
cd app

# Install
bun install

# Run
bun run src/index.ts

# Test
bun test

# Type check
bunx tsc --noEmit
```

## License

MIT
