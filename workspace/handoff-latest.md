# Session Handoff
Date: 2026-04-04
Branch: develop
Mode: project (kotadb + executor infrastructure)

## Completed

- **Zig symbol extractor** (`app/src/indexer/zig-extractor.ts`) — regex-based extraction for `fn`, `struct`, `enum`, `union`, error sets, `pub const`. Wired into both `incremental.ts` and `queries.ts`. Result: 21 → 49,986 symbols indexed for ziglang/zig.

- **BM25 + repo filter fix** — SurrealDB 3.0 silently returns empty when `@@` (fulltext) is combined with non-FTS `AND` conditions. Moved repo filter to post-query application-layer filter. Fixed in both `hybridSearchSymbols` and `searchSymbolExact`.

- **`extractId()` SDK RecordId fix** — SurrealDB SDK v2 `RecordId` uses private `#id`/`#table` fields, invisible to `obj["id"]` lookups. Fixed by falling through to `String(raw)` (invokes `toString()` → `"table:⟨uuid⟩"`) then stripping prefix with regex.

- **Snippet tokenizer fix** — `extractLineSnippets` was doing literal substring match on full query. Now splits on whitespace + code delimiters (`. :: -> /`) so `heap.DebugAllocator` matches lines containing `DebugAllocator`.

- **Symbol BM25 query pre-processing** — dotted queries like `heap.DebugAllocator` now extract last token (`DebugAllocator`) for BM25 symbol search in `searchSymbols()`.

- **Executor WASM → source migration** — npm-installed executor (`/opt/homebrew/lib/node_modules/executor`) bundled WASM SurrealDB client was crashing `RuntimeError: Aborted()` against SurrealDB 3.0.4 on every query. Killed it, now runs from source (`/Users/jcbbge/executor`) on `:8788`.

- **Web UI removed** — `packages/server/src/index.ts` no longer serves UI assets. Non-API routes return `404 Not Found`.

- **`executor-start.sh` updated** — starts `__local-server` from source on `:8788`, also starts control-plane API on `:8000`, kotadb added to brain-layer sources seeded on boot.

- **AGENTS.md files updated** — `~/AGENTS.md`, `~/.pi/agent/AGENTS.md`, `~/executor/AGENTS.md`, `~/.config/opencode/AGENTS.md`, `~/.config/slate/AGENTS.md` all corrected to reflect port split (`:8788` MCP, `:8000` API), removal of web UI, and corrected restart commands.

## Commits
- `ce30377` — feat: Zig symbol extraction + BM25 repo filter + snippet tokenizer fixes

## Current State
- 2 untracked files: `history.txt`, `workspace/` — not for commit
- Branch: `develop`, 16 commits ahead of origin

## Known Issues
- `devbrain.upsert_workspace_state` failing: "table 'workspace_state' does not exist" — dev-brain schema may need migration, not urgent
- Executor `__local-server` process must be manually restarted if it dies between launchd cycles (launchd plist handles this on reboot)

## Next Steps
1. Push `develop` branch when ready: `git push origin develop`
2. Consider re-indexing ziglang/zig on `0.16.0-dev` when stable (currently on `0.15.2`)
3. Executor persistence improvements if `rows.executions.insert` errors resurface
4. Investigate `devbrain.upsert_workspace_state` schema issue
