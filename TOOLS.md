# KotaDB MCP Tools Reference

Complete reference for all Model Context Protocol (MCP) tools exposed by KotaDB.

## Quick Start

KotaDB exposes 24 tools across 4 tiers:
- **Core (14 tools)**: Essential code intelligence
- **Sync (2 tools)**: Import/export functionality  
- **Memory (3 tools)**: Agent learning and recall
- **Expertise (5 tools)**: Advanced analysis features

## Tool Tiers

### Core Tier (14 tools)

These are the essential tools for code search and repository management:

| Tool | Description |
|------|-------------|
| `search` | Unified search across code, symbols, decisions, patterns, and failures. Supports multiple output modes: paths, compact, snippet, full. |
| `index_repository` | Clone and index a git repository for searching. Supports GitHub repos or local paths. |
| `update_repository` | Update an indexed repository to a new version (tag, branch, or commit). |
| `list_repositories` | List all indexed repositories with metadata. |
| `remove_repository` | Remove a repository and all its indexed data from the database. |
| `list_recent_files` | List recently indexed files across all repositories. |
| `search_dependencies` | Find files that depend on or are depended on by a target file. |
| `find_usages` | Find all usages of a specific symbol (function, class, type, etc.) across the codebase. |
| `analyze_change_impact` | Analyze the impact of proposed code changes - shows affected files, test recommendations, and risk assessment. |
| `get_index_statistics` | Get statistics about indexed data: files, symbols, references, decisions, patterns, failures. |
| `validate_implementation_spec` | Validate that implementation matches a specification document. |
| `generate_task_context` | Generate structured context for files including dependencies, impacted files, and test files. |
| `semantic_search` | Semantic/hybrid search using vector embeddings via Ollama + BM25. |
| `search_symbol_exact` | Fast BM25-only exact symbol lookup. |

### Sync Tier (2 tools)

Data import/export tools:

| Tool | Description |
|------|-------------|
| `kota_sync_export` | Export SurrealDB data to JSONL files for git sync. Supports force export and custom export directory. |
| `kota_sync_import` | Import JSONL files into SurrealDB. Supports custom import directory. |

### Memory Tier (3 tools)

Agent learning and knowledge persistence:

| Tool | Description |
|------|-------------|
| `record_decision` | Record architectural decisions, patterns, or workarounds for future agents. |
| `record_failure` | Record failed approaches so agents don't repeat mistakes. |
| `record_insight` | Record per-session observations surfaced to future agents. |

### Expertise Tier (5 tools)

Advanced analysis and validation:

| Tool | Description |
|------|-------------|
| `get_domain_key_files` | Identify key files in a domain (e.g., 'auth', 'database', 'api'). |
| `validate_expertise` | Validate that code follows established patterns and best practices. |
| `sync_expertise` | Synchronize expertise files with the database. |
| `get_recent_patterns` | Get recently observed patterns from agent sessions. |
| `search_chunks` | Search within specific code chunks or sections. |

## Usage Examples

### Search Code

```json
{
  "tool": "search",
  "params": {
    "query": "authentication middleware",
    "scope": ["code"],
    "filters": {
      "language": "typescript",
      "repository": "owner/repo"
    },
    "output": "snippet",
    "context_lines": 3
  }
}
```

### Index a Repository

```json
{
  "tool": "index_repository",
  "params": {
    "repository": "jayminwest/kotadb",
    "ref": "main"
  }
}
```

### Find Symbol Usages

```json
{
  "tool": "find_usages",
  "params": {
    "symbol": "executeSearch",
    "repository": "owner/repo"
  }
}
```

### Analyze Change Impact

```json
{
  "tool": "analyze_change_impact",
  "params": {
    "files": ["src/db/client.ts"],
    "change_type": "refactor",
    "description": "Update database connection logic"
  }
}
```

### Export Data

```json
{
  "tool": "kota_sync_export",
  "params": {
    "export_dir": ".kotadb/export",
    "force": false
  }
}
```

### Record a Decision

```json
{
  "tool": "record_decision",
  "params": {
    "title": "Use SurrealDB over SQLite",
    "context": "Need graph relationships and vector search",
    "decision": "Migrate to SurrealDB for native vector support",
    "consequences": ["Requires SurrealDB daemon", "Better semantic search"]
  }
}
```

## CLI Commands

KotaDB also provides CLI commands:

```bash
# Start the MCP server
kotadb

# Start on custom port
kotadb --port 4000

# Query dependencies for a file
kotadb deps --file src/db/client.ts

# Get expertise analysis
kotadb expertise --domain auth

# Show help
kotadb --help
```

## Toolset Selection

Control which tools are exposed via the `--toolset` flag:

- `--toolset core` - Core tools only (14 tools)
- `--toolset default` - Core + Sync tools (16 tools)
- `--toolset memory` - Core + Sync + Memory tools (19 tools)
- `--toolset full` - All tools (24 tools)

## HTTP API

MCP tools are accessible via HTTP POST to `/mcp`:

```bash
curl -X POST http://localhost:3099/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "tool": "search",
    "params": {
      "query": "database connection",
      "scope": ["code"]
    }
  }'
```

## Health Check

```bash
curl http://localhost:3099/health
```

Returns: `{"status":"healthy","database":"connected","version":"2.2.0"}`

## Database

KotaDB uses SurrealDB:
- **URL**: `ws://127.0.0.1:8002/rpc`
- **Namespace**: `kotadb`
- **Database**: `index`

Start SurrealDB:
```bash
surreal start --bind 127.0.0.1:8002 --user root --pass root file://~/.kotadb/surreal.db
```
