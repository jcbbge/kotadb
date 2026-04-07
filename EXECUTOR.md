# KotaDB MCP Executor Integration

This document describes how the MCP executor (Claude Code, Oh My Pi, etc.) discovers and uses KotaDB tools.

## Tool Discovery

KotaDB exposes tools via the Model Context Protocol (MCP). The executor discovers tools dynamically by calling the `/mcp` endpoint with a `list_tools` request.

### HTTP Endpoint

```
POST http://localhost:3099/mcp
Content-Type: application/json
```

### List Tools Request

```json
{
  "method": "list_tools"
}
```

### Response Format

```json
{
  "tools": [
    {
      "name": "search",
      "description": "Search indexed code, symbols, decisions...",
      "inputSchema": { ... }
    },
    {
      "name": "index_repository",
      "description": "Clone and index a git repository...",
      "inputSchema": { ... }
    }
    // ... 24 total tools
  ]
}
```

## Tool Tiers

Tools are organized into 4 tiers. The executor can request different tiers via the `--toolset` flag when starting KotaDB:

| Toolset | Tools | Description |
|---------|-------|-------------|
| `core` | 14 | Essential code intelligence |
| `default` | 16 | Core + data sync |
| `memory` | 19 | Core + sync + agent memory |
| `full` | 24 | All tools including expertise |

## Available Tools (24 Total)

### Core Tier

1. **search** - Unified search across code, symbols, decisions, patterns, failures
2. **index_repository** - Clone and index a git repository
3. **update_repository** - Update indexed repo to new version
4. **list_repositories** - List all indexed repositories
5. **remove_repository** - Remove a repository and its data
6. **list_recent_files** - List recently indexed files
7. **search_dependencies** - Find file dependencies
8. **find_usages** - Find symbol usages across codebase
9. **analyze_change_impact** - Impact analysis for changes
10. **get_index_statistics** - Database statistics
11. **validate_implementation_spec** - Validate against specs
12. **generate_task_context** - Generate file context with dependencies
13. **semantic_search** - Vector + BM25 search
14. **search_symbol_exact** - Fast BM25 symbol lookup

### Sync Tier

15. **kota_sync_export** - Export SurrealDB to JSONL
16. **kota_sync_import** - Import JSONL to SurrealDB

### Memory Tier

17. **record_decision** - Record architectural decisions
18. **record_failure** - Record failed approaches
19. **record_insight** - Record session observations

### Expertise Tier

20. **get_domain_key_files** - Identify domain key files
21. **validate_expertise** - Validate code patterns
22. **sync_expertise** - Sync expertise files
23. **get_recent_patterns** - Get recent patterns
24. **search_chunks** - Search within chunks

## Tool Execution

### Request Format

```json
{
  "method": "execute_tool",
  "params": {
    "name": "search",
    "arguments": {
      "query": "database connection",
      "scope": ["code"],
      "output": "snippet"
    }
  }
}
```

### Response Format

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"results\": {\"code\": [...]}}"
    }
  ]
}
```

## Error Handling

Tools return errors in the response:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"error\": \"Repository not found\"}"
    }
  ],
  "isError": true
}
```

## Health Check

Before executing tools, verify the server is healthy:

```bash
curl http://localhost:3099/health
```

Expected response:
```json
{"status":"healthy","database":"connected","version":"2.2.0"}
```

## Configuration

### Environment Variables

```bash
# Required
SURREAL_URL=ws://127.0.0.1:8002/rpc
SURREAL_NS=kotadb
SURREAL_DB=index

# Optional
PORT=3099
SURREAL_USER=root
SURREAL_PASS=root
```

### MCP Client Configuration

Add to `~/.claude/mcp.json`:

```json
{
  "mcpServers": {
    "kotadb": {
      "type": "http",
      "url": "http://localhost:3099/"
    }
  }
}
```

## Startup Sequence

1. Start SurrealDB:
   ```bash
   surreal start --bind 127.0.0.1:8002 --user root --pass root file://~/.kotadb/surreal.db
   ```

2. Start KotaDB:
   ```bash
   cd /Users/jcbbge/kotadb/app
   bun run src/index.ts
   ```

3. Verify health:
   ```bash
   curl http://localhost:3099/health
   ```

4. Executor discovers tools automatically via MCP protocol

## Tool Schema

Each tool has an input schema defining its parameters. The executor can retrieve schemas via the `list_tools` method and use them to validate tool calls.

Example schema for `search`:

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string" },
    "scope": { 
      "type": "array",
      "items": { "enum": ["code", "symbols", "decisions", "patterns", "failures"] }
    },
    "filters": { "type": "object" },
    "limit": { "type": "number" },
    "output": { "enum": ["paths", "compact", "snippet", "full"] }
  }
}
```

See [TOOLS.md](TOOLS.md) for detailed usage examples.
