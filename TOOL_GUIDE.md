# KotaDB Tool Decision Guide

**When to use each tool - a decision tree for AI agents.**

## Quick Decision Tree

```
Need to find code?
├── First time searching this repo? → index_repository
├── Know the symbol name? → find_usages
├── Know the file name? → search_dependencies
├── Just exploring/natural language query? → search
├── Semantic similarity (meaning, not text)? → semantic_search
└── Exact symbol lookup? → search_symbol_exact

Planning to change code?
├── Multiple files affected? → analyze_change_impact
├── Need context before editing? → generate_task_context
├── Need to see dependencies? → search_dependencies
└── Refactoring a specific function/class? → find_usages

Want to persist knowledge?
├── Made an architectural decision? → record_decision
├── Tried something that failed? → record_failure
├── Had an insight worth remembering? → record_insight

Need repository info?
├── What's indexed? → list_repositories
├── Recent changes? → list_recent_files
├── Database stats? → get_index_statistics
└── Update to new version? → update_repository

Backup/restore data?
├── Export to JSONL? → kota_sync_export
├── Import from JSONL? → kota_sync_import
```

## Tool Selection by Scenario

### Scenario: "I need to understand the codebase"

**USE:** `search` with `scope: ["code"]` and `output: "snippet"`

Natural language query to explore code. Good for:
- "Find authentication logic"
- "Where is the database connection setup?"
- "Show me error handling patterns"

**DON'T USE:** `semantic_search` unless you need conceptual similarity, not text matching.

---

### Scenario: "I want to refactor a function"

**STEP 1:** `find_usages` on the function name

Find every call site, import, and reference before changing anything.

**STEP 2:** `analyze_change_impact` with the files you'll modify

Get the full picture: what breaks, what tests to run, risk assessment.

**STEP 3:** (Optional) `generate_task_context` for the affected files

Get dependency counts, impacted files, and test file discovery.

**DON'T USE:** `search` - it's too broad and misses indirect references.

---

### Scenario: "What breaks if I change this file?"

**USE:** `search_dependencies` on the file path

Get both directions:
- Files that depend on this one (dependents)
- Files this one depends on (dependencies)

Then `analyze_change_impact` for comprehensive analysis.

---

### Scenario: "What functions are available in module X?"

**USE:** `search` with `scope: ["symbols"]` and `filters: { repository: "X" }`

Returns all symbols (functions, classes, types, etc.) with their signatures.

Alternative: `search_symbol_exact` for fast BM25 lookup by partial name.

---

### Scenario: "Before I make this change..."

**USE:** `analyze_change_impact`

Required before any multi-file change. Takes:
- Files to modify/create/delete
- Change type (feature/refactor/fix/chore)
- Description of what you're doing

Returns:
- Affected files and why
- Test files that should be checked
- Risk assessment
- Potential conflicts

---

### Scenario: "I need to search a new repo"

**USE:** `index_repository`

One-time setup for a repository. After indexing, you can search it immediately.

**Parameters:**
- `repository`: "owner/repo" format or full git URL
- `ref`: Optional branch/tag (defaults to main/master)

**Don't use this for already-indexed repos** - that's what `update_repository` is for.

---

### Scenario: "The repo has new commits"

**USE:** `update_repository`

Wipes existing index and re-indexes from the new version. Use when:
- You need features from a newer version
- The codebase has changed significantly
- You want to analyze a specific release/tag

---

### Scenario: "I learned something important"

**USE:** `record_decision` for architectural choices

What: The decision you made
Context: Why you made it
Consequences: What this affects

**USE:** `record_failure` for failed approaches

What you tried, why it failed, what to try instead.

**USE:** `record_insight` for observations

Per-session learnings surfaced to future agents.

---

### Scenario: "I need the big picture"

**USE:** `generate_task_context` with file paths

Returns structured context:
- Dependency counts
- Impacted files
- Test files
- Recent changes

Designed for <100ms response - use freely in hooks.

---

## Anti-Patterns

### DON'T: Use `search` for refactoring

`search` finds text matches. Refactoring needs exact symbol tracking. Use `find_usages` instead.

### DON'T: Use `find_usages` for exploration

`find_usages` needs an exact symbol name. For fuzzy discovery, use `search` or `search_symbol_exact`.

### DON'T: Skip `analyze_change_impact` for multi-file changes

This is your safety net. It catches dependencies you'd miss otherwise.

### DON'T: Use `search_dependencies` for symbol-level work

It operates at file level. For symbols (functions, classes), use `find_usages`.

### DON'T: Index the same repo multiple times

`index_repository` is for first-time setup. Use `update_repository` for refreshes.

---

## Tool-Specific Trigger Phrases

Use these phrases in your thinking to trigger the right tool:

| Phrase | Tool |
|--------|------|
| "What breaks if I..." | analyze_change_impact |
| "Where is X used?" | find_usages |
| "What depends on this file?" | search_dependencies |
| "Find code about..." | search |
| "Find function/class X" | search_symbol_exact |
| "Similar to..." | semantic_search |
| "Index this repo" | index_repository |
| "Update to latest" | update_repository |
| "Context for these files" | generate_task_context |
| "We decided to..." | record_decision |
| "Don't try X because..." | record_failure |
| "Interesting that..." | record_insight |

---

## Output Mode Selection Guide

When using `search`, choose output mode based on your need:

| Output | Use When | Size |
|--------|----------|------|
| `paths` | Just need file names | ~100 bytes/result |
| `compact` | Quick overview (default for code) | ~200 bytes/result |
| `snippet` | Code exploration with context | ~2KB/result |
| `full` | Small result sets only (symbols/decisions) | ~100KB/result |

**WARNING:** `full` mode on code scope returns entire file contents. Use sparingly.

---

## Scope Selection Guide

The `search` tool supports multiple scopes. Choose based on what you're looking for:

| Scope | Contains | Use When |
|-------|----------|----------|
| `code` | File paths, content | Finding implementation |
| `symbols` | Functions, classes, types | API discovery |
| `decisions` | Architecture records | Understanding why |
| `patterns` | Code patterns | Finding examples |
| `failures` | Failed approaches | Avoiding mistakes |

---

## Example Workflows

### Workflow: Understanding a New Codebase

1. `index_repository` - Index the repo
2. `list_repositories` - Confirm it's indexed
3. `search` with `scope: ["symbols"]` - See the API surface
4. `search` with `scope: ["code"]` and natural language query - Explore key areas
5. `record_decision` - Document architectural choices you discover

### Workflow: Safe Refactoring

1. `find_usages` on the symbol to refactor
2. `analyze_change_impact` with affected files
3. Make changes
4. `search_dependencies` on modified files to verify nothing missed
5. `record_failure` if you hit issues (for future agents)

### Workflow: Debugging an Issue

1. `search` for error messages or related code
2. `find_usages` on suspect functions
3. `search_dependencies` on relevant files
4. `generate_task_context` for context on key files
5. `record_insight` on root cause when found
