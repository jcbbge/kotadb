--
-- KotaDB SurrealDB Schema
--
-- Namespace: kotadb
-- Database:  index
--
-- Design principles:
--   - SCHEMAFULL on all tables: strict typing, no surprise fields
--   - Native graph edges for code references (calls, imports, extends)
--   - Vector indexes (MTREE, 768-dim) for Ollama nomic-embed-code search
--   - BM25 full-text search on file content and symbol names
--   - Record links instead of UUID foreign keys
--   - Local-first: no auth/org/rate-limit tables
--
-- Table inventory:
--   Core:    repo, file, symbol
--   Edges:   calls, imports, extends
--   Memory:  decision, failure, pattern, insight, agent_session
-- ============================================================================

-- ============================================================================
-- ANALYZERS
-- ============================================================================
-- Shared analyzer for BM25 full-text search on source code content.
-- Uses the built-in "code" tokenizer which handles camelCase, snake_case,
-- and common identifier separators in addition to whitespace.

DEFINE ANALYZER IF NOT EXISTS code_analyzer
    TOKENIZERS class
    FILTERS lowercase, ascii;

-- Lighter analyzer for symbol names and file paths (no stemming needed).
DEFINE ANALYZER IF NOT EXISTS ident_analyzer
    TOKENIZERS class
    FILTERS lowercase;

-- Hybrid-search analyzer for code symbol names.
-- Uses both camel (splits getUserById → get/user/by/id) and blank (splits on
-- whitespace) tokenizers so that partial-name BM25 queries match reliably.
-- Paired with HNSW vector indexes for combined hybrid search scoring.
DEFINE ANALYZER IF NOT EXISTS code_search
    TOKENIZERS camel, blank
    FILTERS lowercase, ascii;

-- ============================================================================
-- TABLE: repo
-- ============================================================================
-- Dropped fields: user_id, org_id (not needed for local-first)

DEFINE TABLE IF NOT EXISTS repo SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS id             ON repo TYPE string;   -- UUID, set by application
DEFINE FIELD IF NOT EXISTS name           ON repo TYPE string;   -- Short repo name (e.g. "kotadb")
DEFINE FIELD IF NOT EXISTS full_name      ON repo TYPE string;   -- "owner/repo" format (unique)
DEFINE FIELD IF NOT EXISTS git_url        ON repo TYPE option<string>;
DEFINE FIELD IF NOT EXISTS local_path     ON repo TYPE option<string>;  -- Clone store path
DEFINE FIELD IF NOT EXISTS current_commit ON repo TYPE option<string>; -- HEAD SHA
DEFINE FIELD IF NOT EXISTS ref            ON repo TYPE option<string>; -- Current branch/tag
DEFINE FIELD IF NOT EXISTS default_branch ON repo TYPE string    DEFAULT 'main';
DEFINE FIELD IF NOT EXISTS last_indexed_at ON repo TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at     ON repo TYPE datetime  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at     ON repo TYPE datetime  DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS metadata       ON repo TYPE object    DEFAULT {};
-- Allow arbitrary nested keys in metadata (SurrealDB 3.0 SCHEMAFULL requirement).
DEFINE FIELD IF NOT EXISTS metadata[*]    ON repo TYPE any;

-- Enforce uniqueness on full_name (the primary lookup key for a repo).
DEFINE INDEX IF NOT EXISTS repo_full_name_unique
    ON repo
    FIELDS full_name
    UNIQUE;

DEFINE INDEX IF NOT EXISTS repo_last_indexed
    ON repo
    FIELDS last_indexed_at;

-- ============================================================================
-- TABLE: file
-- ============================================================================
-- Added:   embedding (768-dim vector for semantic search)
--          content_hash (deduplication / change detection)

DEFINE TABLE IF NOT EXISTS file SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS id           ON file TYPE string;              -- UUID
DEFINE FIELD IF NOT EXISTS repo         ON file TYPE record<repo>;        -- Record link (replaces foreign key)
DEFINE FIELD IF NOT EXISTS path         ON file TYPE string;              -- Relative path from repo root
DEFINE FIELD IF NOT EXISTS content      ON file TYPE string;              -- Full source text
DEFINE FIELD IF NOT EXISTS language     ON file TYPE option<string>;      -- e.g. "typescript", "python"
DEFINE FIELD IF NOT EXISTS size_bytes   ON file TYPE option<int>;
DEFINE FIELD IF NOT EXISTS content_hash ON file TYPE option<string>;      -- SHA-256; used for skip-on-unchanged
DEFINE FIELD IF NOT EXISTS indexed_at   ON file TYPE datetime             DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS metadata     ON file TYPE object               DEFAULT {};
-- Allow arbitrary nested keys in metadata (SurrealDB 3.0 SCHEMAFULL requirement).
DEFINE FIELD IF NOT EXISTS metadata[*]  ON file TYPE any;

-- 768-dimensional embedding from nomic-embed-code via Ollama.
-- NULL until the embedding worker has processed this file.
DEFINE FIELD IF NOT EXISTS embedding    ON file TYPE option<array<float>>;

-- Prevent duplicate (repo, path) pairs — a file path is unique within a repo.
DEFINE INDEX IF NOT EXISTS file_repo_path_unique
    ON file
    FIELDS repo, path
    UNIQUE;

DEFINE INDEX IF NOT EXISTS file_language
    ON file
    FIELDS language;

DEFINE INDEX IF NOT EXISTS file_content_hash
    ON file
    FIELDS content_hash;

-- BM25 full-text search across path and content.
-- Use: SELECT * FROM file WHERE path @@ 'auth' OR content @@ 'createUser';
-- Note: SurrealDB 3.0 requires one field per FULLTEXT index.
DEFINE INDEX IF NOT EXISTS file_fts_path
    ON file
    FIELDS path
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS file_fts_content
    ON file
    FIELDS content
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

-- Vector index for semantic (embedding) search on file content.
-- Use: SELECT * FROM file WHERE embedding <|5|> $query_vec;
-- Note: SurrealDB 3.0 uses HNSW instead of MTREE for vector indexes.
DEFINE INDEX IF NOT EXISTS file_embedding_hnsw
    ON file
    FIELDS embedding
    HNSW DIMENSION 768
    DIST COSINE;

-- Hybrid-search BM25 index using code_search analyzer (camel + blank tokenizers).
-- Complements file_fts_content for camelCase-aware partial matching in hybrid search.
DEFINE INDEX IF NOT EXISTS file_fts_path_hybrid
    ON file
    FIELDS path
    FULLTEXT ANALYZER code_search
    BM25(1.2, 0.75)
    HIGHLIGHTS;

-- ============================================================================
-- TABLE: symbol
-- ============================================================================
-- Added:   embedding (768-dim vector), repo denormalization for fast filtering
DEFINE TABLE IF NOT EXISTS symbol SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS id            ON symbol TYPE string;           -- UUID
DEFINE FIELD IF NOT EXISTS file          ON symbol TYPE record<file>;     -- Record link to containing file
DEFINE FIELD IF NOT EXISTS repo          ON symbol TYPE record<repo>;     -- Denormalized for fast repo-scoped queries
DEFINE FIELD IF NOT EXISTS name          ON symbol TYPE string;           -- Symbol name (e.g. "createUser")
DEFINE FIELD IF NOT EXISTS kind          ON symbol TYPE string
    ASSERT $value IN [
        'function', 'class', 'interface', 'type',
        'variable', 'constant', 'method', 'property',
        'module', 'namespace', 'enum', 'enum_member'
    ];
DEFINE FIELD IF NOT EXISTS line_start    ON symbol TYPE int;
DEFINE FIELD IF NOT EXISTS line_end      ON symbol TYPE int;
DEFINE FIELD IF NOT EXISTS signature     ON symbol TYPE option<string>;   -- Full signature text
DEFINE FIELD IF NOT EXISTS documentation ON symbol TYPE option<string>;   -- Docstring / JSDoc
DEFINE FIELD IF NOT EXISTS metadata      ON symbol TYPE object            DEFAULT {};
-- Allow arbitrary nested keys in metadata (SurrealDB 3.0 SCHEMAFULL requirement).
DEFINE FIELD IF NOT EXISTS metadata[*]   ON symbol TYPE any;
DEFINE FIELD IF NOT EXISTS created_at    ON symbol TYPE datetime          DEFAULT time::now();

-- 768-dimensional embedding from nomic-embed-code.
-- Encodes signature + documentation for semantic symbol search.
DEFINE FIELD IF NOT EXISTS embedding     ON symbol TYPE option<array<float>>;

DEFINE INDEX IF NOT EXISTS symbol_name
    ON symbol
    FIELDS name;

DEFINE INDEX IF NOT EXISTS symbol_kind
    ON symbol
    FIELDS kind;

DEFINE INDEX IF NOT EXISTS symbol_repo
    ON symbol
    FIELDS repo;

DEFINE INDEX IF NOT EXISTS symbol_file
    ON symbol
    FIELDS file;

-- Composite: fast "find all functions in repo" queries.
DEFINE INDEX IF NOT EXISTS symbol_repo_kind
    ON symbol
    FIELDS repo, kind;

-- BM25 search on symbol name, signature, and documentation.
-- Use: SELECT * FROM symbol WHERE name @@ 'create' OR documentation @@ 'authentication';
-- Note: SurrealDB 3.0 requires one field per FULLTEXT index.
DEFINE INDEX IF NOT EXISTS symbol_fts_name
    ON symbol
    FIELDS name
    FULLTEXT ANALYZER ident_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS symbol_fts_signature
    ON symbol
    FIELDS signature
    FULLTEXT ANALYZER ident_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS symbol_fts_documentation
    ON symbol
    FIELDS documentation
    FULLTEXT ANALYZER ident_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

-- Vector index for semantic symbol search.
-- Use: SELECT * FROM symbol WHERE embedding <|10|> $query_vec;
-- Note: SurrealDB 3.0 uses HNSW instead of MTREE for vector indexes.
DEFINE INDEX IF NOT EXISTS symbol_embedding_hnsw
    ON symbol
    FIELDS embedding
    HNSW DIMENSION 768
    DIST COSINE;

-- Hybrid-search BM25 indexes using code_search analyzer (camel + blank tokenizers).
-- These complement the ident_analyzer indexes above by splitting camelCase identifiers
-- into sub-tokens, making partial-name queries like "user" match "getUserById".
-- Use alongside HNSW vector search for combined hybrid scoring.
DEFINE INDEX IF NOT EXISTS symbol_fts_name_hybrid
    ON symbol
    FIELDS name
    FULLTEXT ANALYZER code_search
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS symbol_fts_description_hybrid
    ON symbol
    FIELDS documentation
    FULLTEXT ANALYZER code_search
    BM25(1.2, 0.75)
    HIGHLIGHTS;

-- ============================================================================
-- GRAPH EDGES: calls
-- ============================================================================
-- Represents: call, property_access, type_reference, variable_reference
--
-- Replaces: indexed_references rows where reference_type IN (
--   'call', 'property_access', 'type_reference', 'variable_reference'
-- )
--
-- in  → the symbol or file that contains the reference
-- out → the symbol or file being referenced
--
-- Graph queries:
--   Find everything a symbol calls:
--     SELECT ->calls->symbol FROM symbol:abc;
--   Find all callers of a symbol:
--     SELECT <-calls<-symbol FROM symbol:xyz;

DEFINE TABLE IF NOT EXISTS calls SCHEMAFULL TYPE RELATION
    IN  file | symbol
    OUT file | symbol;

-- Note: 'in' and 'out' are auto-defined by SurrealDB 3.0 on RELATION tables.
-- IF NOT EXISTS prevents errors on re-import.
DEFINE FIELD IF NOT EXISTS in            ON calls TYPE record<file | symbol>;
DEFINE FIELD IF NOT EXISTS out           ON calls TYPE record<file | symbol>;
DEFINE FIELD IF NOT EXISTS reference_type ON calls TYPE string
    ASSERT $value IN ['call', 'property_access', 'type_reference', 'variable_reference'];
DEFINE FIELD IF NOT EXISTS line_number   ON calls TYPE int;
DEFINE FIELD IF NOT EXISTS column_number ON calls TYPE option<int>;
DEFINE FIELD IF NOT EXISTS metadata      ON calls TYPE object DEFAULT {};
DEFINE FIELD IF NOT EXISTS metadata[*]   ON calls TYPE any;

DEFINE INDEX IF NOT EXISTS calls_in       ON calls FIELDS in;
DEFINE INDEX IF NOT EXISTS calls_out      ON calls FIELDS out;
DEFINE INDEX IF NOT EXISTS calls_ref_type ON calls FIELDS reference_type;

-- ============================================================================
-- GRAPH EDGES: imports
-- ============================================================================
-- Represents: import, re_export, export_all, dynamic_import
--
-- Replaces: indexed_references rows where reference_type IN (
--   'import', 're_export', 'export_all', 'dynamic_import'
-- )
--
-- Graph queries:
--   Find all files imported by a file:
--     SELECT ->imports->file FROM file:abc;
--   Find all files that import a given file:
--     SELECT <-imports<-file FROM file:xyz;

DEFINE TABLE IF NOT EXISTS imports SCHEMAFULL TYPE RELATION
    IN  file | symbol
    OUT file | symbol;

DEFINE FIELD IF NOT EXISTS in            ON imports TYPE record<file | symbol>;
DEFINE FIELD IF NOT EXISTS out           ON imports TYPE record<file | symbol>;
DEFINE FIELD IF NOT EXISTS reference_type ON imports TYPE string
    ASSERT $value IN ['import', 're_export', 'export_all', 'dynamic_import'];
DEFINE FIELD IF NOT EXISTS line_number   ON imports TYPE int;
DEFINE FIELD IF NOT EXISTS column_number ON imports TYPE option<int>;
DEFINE FIELD IF NOT EXISTS metadata      ON imports TYPE object DEFAULT {};
DEFINE FIELD IF NOT EXISTS metadata[*]   ON imports TYPE any;

DEFINE INDEX IF NOT EXISTS imports_in       ON imports FIELDS in;
DEFINE INDEX IF NOT EXISTS imports_out      ON imports FIELDS out;
DEFINE INDEX IF NOT EXISTS imports_ref_type ON imports FIELDS reference_type;

-- ============================================================================
-- GRAPH EDGES: extends
-- ============================================================================
-- Represents: extends, implements
--
-- Replaces: indexed_references rows where reference_type IN (
--   'extends', 'implements'
-- )
--
-- Graph queries:
--   Inheritance chain:
--     SELECT ->extends->symbol FROM symbol:MyClass;
--   All implementors of an interface:
--     SELECT <-extends<-symbol FROM symbol:IAuthProvider;

DEFINE TABLE IF NOT EXISTS extends SCHEMAFULL TYPE RELATION
    IN  file | symbol
    OUT file | symbol;

DEFINE FIELD IF NOT EXISTS in            ON extends TYPE record<file | symbol>;
DEFINE FIELD IF NOT EXISTS out           ON extends TYPE record<file | symbol>;
DEFINE FIELD IF NOT EXISTS reference_type ON extends TYPE string
    ASSERT $value IN ['extends', 'implements'];
DEFINE FIELD IF NOT EXISTS line_number   ON extends TYPE int;
DEFINE FIELD IF NOT EXISTS column_number ON extends TYPE option<int>;
DEFINE FIELD IF NOT EXISTS metadata      ON extends TYPE object DEFAULT {};
DEFINE FIELD IF NOT EXISTS metadata[*]   ON extends TYPE any;

DEFINE INDEX IF NOT EXISTS extends_in       ON extends FIELDS in;
DEFINE INDEX IF NOT EXISTS extends_out      ON extends FIELDS out;
DEFINE INDEX IF NOT EXISTS extends_ref_type ON extends FIELDS reference_type;

-- ============================================================================
-- TABLE: decision
-- ============================================================================
-- Renamed singular to match SurrealDB conventions.

DEFINE TABLE IF NOT EXISTS decision SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS id            ON decision TYPE string;          -- UUID
DEFINE FIELD IF NOT EXISTS repo          ON decision TYPE option<record<repo>>;  -- nullable (global decisions)
DEFINE FIELD IF NOT EXISTS title         ON decision TYPE string;
DEFINE FIELD IF NOT EXISTS context       ON decision TYPE string;          -- Background / why this came up
DEFINE FIELD IF NOT EXISTS decision      ON decision TYPE string;          -- The actual decision text
DEFINE FIELD IF NOT EXISTS scope         ON decision TYPE string
    ASSERT $value IN ['architecture', 'pattern', 'convention', 'workaround'];
DEFINE FIELD IF NOT EXISTS rationale     ON decision TYPE option<string>;
DEFINE FIELD IF NOT EXISTS alternatives  ON decision TYPE array<string>   DEFAULT [];
DEFINE FIELD IF NOT EXISTS related_files ON decision TYPE array<string>   DEFAULT [];
DEFINE FIELD IF NOT EXISTS status        ON decision TYPE string           DEFAULT 'active'
    ASSERT $value IN ['active', 'superseded', 'deprecated'];
DEFINE FIELD IF NOT EXISTS created_at    ON decision TYPE datetime         DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at    ON decision TYPE datetime         DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS decision_repo   ON decision FIELDS repo;
DEFINE INDEX IF NOT EXISTS decision_scope  ON decision FIELDS scope;
DEFINE INDEX IF NOT EXISTS decision_status ON decision FIELDS status;

-- BM25 search on decision content — used by search_decisions MCP tool.
-- Note: SurrealDB 3.0 requires one field per FULLTEXT index.
DEFINE INDEX IF NOT EXISTS decision_fts_title
    ON decision
    FIELDS title
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS decision_fts_context
    ON decision
    FIELDS context
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS decision_fts_decision
    ON decision
    FIELDS decision
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS decision_fts_rationale
    ON decision
    FIELDS rationale
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

-- ============================================================================
-- TABLE: failure
-- ============================================================================
-- Tracks failed approaches so agents don't repeat mistakes.

DEFINE TABLE IF NOT EXISTS failure SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS id             ON failure TYPE string;          -- UUID
DEFINE FIELD IF NOT EXISTS repo           ON failure TYPE option<record<repo>>;
DEFINE FIELD IF NOT EXISTS title          ON failure TYPE string;
DEFINE FIELD IF NOT EXISTS problem        ON failure TYPE string;          -- The problem being attempted
DEFINE FIELD IF NOT EXISTS approach       ON failure TYPE string;          -- What was tried
DEFINE FIELD IF NOT EXISTS failure_reason ON failure TYPE string;          -- Why it failed
DEFINE FIELD IF NOT EXISTS related_files  ON failure TYPE array<string>   DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at     ON failure TYPE datetime         DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS metadata       ON failure TYPE object           DEFAULT {};
DEFINE FIELD IF NOT EXISTS metadata[*]    ON failure TYPE any;

DEFINE INDEX IF NOT EXISTS failure_repo       ON failure FIELDS repo;
DEFINE INDEX IF NOT EXISTS failure_created_at ON failure FIELDS created_at;

-- BM25 search — used by search_failures MCP tool.
-- Note: SurrealDB 3.0 requires one field per FULLTEXT index.
DEFINE INDEX IF NOT EXISTS failure_fts_title
    ON failure
    FIELDS title
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS failure_fts_problem
    ON failure
    FIELDS problem
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS failure_fts_approach
    ON failure
    FIELDS approach
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS failure_fts_reason
    ON failure
    FIELDS failure_reason
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

-- ============================================================================
-- TABLE: pattern
-- ============================================================================
-- Captures recurring code patterns observed in the codebase.

DEFINE TABLE IF NOT EXISTS pattern SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS id           ON pattern TYPE string;            -- UUID
DEFINE FIELD IF NOT EXISTS repo         ON pattern TYPE option<record<repo>>;
DEFINE FIELD IF NOT EXISTS pattern_type ON pattern TYPE string;            -- e.g. 'error-handling', 'api-call'
DEFINE FIELD IF NOT EXISTS file_path    ON pattern TYPE option<string>;    -- File where pattern was observed
DEFINE FIELD IF NOT EXISTS description  ON pattern TYPE string;
DEFINE FIELD IF NOT EXISTS example      ON pattern TYPE option<string>;    -- Code snippet example
DEFINE FIELD IF NOT EXISTS created_at   ON pattern TYPE datetime           DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS metadata     ON pattern TYPE object             DEFAULT {};
DEFINE FIELD IF NOT EXISTS metadata[*]  ON pattern TYPE any;

DEFINE INDEX IF NOT EXISTS pattern_repo         ON pattern FIELDS repo;
DEFINE INDEX IF NOT EXISTS pattern_type         ON pattern FIELDS pattern_type;
DEFINE INDEX IF NOT EXISTS pattern_file_path    ON pattern FIELDS file_path;
DEFINE INDEX IF NOT EXISTS pattern_created_at   ON pattern FIELDS created_at;

-- BM25 search — used by search_patterns MCP tool.
-- Note: SurrealDB 3.0 requires one field per FULLTEXT index.
DEFINE INDEX IF NOT EXISTS pattern_fts_type
    ON pattern
    FIELDS pattern_type
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS pattern_fts_description
    ON pattern
    FIELDS description
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS pattern_fts_example
    ON pattern
    FIELDS example
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

-- ============================================================================
-- TABLE: insight
-- ============================================================================
-- Per-session observations surfaced to future agents.

DEFINE TABLE IF NOT EXISTS insight SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS id           ON insight TYPE string;            -- UUID
DEFINE FIELD IF NOT EXISTS session_id   ON insight TYPE option<string>;    -- Agent session identifier
DEFINE FIELD IF NOT EXISTS content      ON insight TYPE string;
DEFINE FIELD IF NOT EXISTS insight_type ON insight TYPE string
    ASSERT $value IN ['discovery', 'failure', 'workaround'];
DEFINE FIELD IF NOT EXISTS related_file ON insight TYPE option<string>;    -- File path (not a record link; may be external)
DEFINE FIELD IF NOT EXISTS created_at   ON insight TYPE datetime           DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS metadata     ON insight TYPE object             DEFAULT {};
DEFINE FIELD IF NOT EXISTS metadata[*]  ON insight TYPE any;

DEFINE INDEX IF NOT EXISTS insight_session_id   ON insight FIELDS session_id;
DEFINE INDEX IF NOT EXISTS insight_type         ON insight FIELDS insight_type;
DEFINE INDEX IF NOT EXISTS insight_related_file ON insight FIELDS related_file;
DEFINE INDEX IF NOT EXISTS insight_created_at   ON insight FIELDS created_at;

-- BM25 search on insight content.
DEFINE INDEX IF NOT EXISTS insight_fts
    ON insight
    FIELDS content
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

-- ============================================================================
-- TABLE: agent_session
-- ============================================================================
-- Tracks agent work sessions for learning and post-hoc analysis.

DEFINE TABLE IF NOT EXISTS agent_session SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS id             ON agent_session TYPE string;    -- UUID
DEFINE FIELD IF NOT EXISTS repo           ON agent_session TYPE record<repo>;
DEFINE FIELD IF NOT EXISTS agent_type     ON agent_session TYPE option<string>;   -- e.g. 'claude-code', 'opencode'
DEFINE FIELD IF NOT EXISTS task_summary   ON agent_session TYPE option<string>;
DEFINE FIELD IF NOT EXISTS outcome        ON agent_session TYPE option<string>
    ASSERT $value = NONE OR $value IN ['success', 'failure', 'partial'];
DEFINE FIELD IF NOT EXISTS files_modified ON agent_session TYPE array<string>     DEFAULT [];
DEFINE FIELD IF NOT EXISTS started_at     ON agent_session TYPE datetime           DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS ended_at       ON agent_session TYPE option<datetime>;

DEFINE INDEX IF NOT EXISTS agent_session_repo       ON agent_session FIELDS repo;
DEFINE INDEX IF NOT EXISTS agent_session_agent_type ON agent_session FIELDS agent_type;
DEFINE INDEX IF NOT EXISTS agent_session_outcome    ON agent_session FIELDS outcome;
DEFINE INDEX IF NOT EXISTS agent_session_started_at ON agent_session FIELDS started_at;
-- Index for finding in-progress sessions (ended_at IS NONE).
DEFINE INDEX IF NOT EXISTS agent_session_ongoing    ON agent_session FIELDS repo, ended_at;

-- ============================================================================
-- TABLE: chunk
-- ============================================================================
-- Sub-file segments for large-file agent navigation and retrieval.

DEFINE TABLE IF NOT EXISTS chunk SCHEMAFULL;

DEFINE FIELD IF NOT EXISTS file             ON chunk TYPE record<file>;
DEFINE FIELD IF NOT EXISTS chunk_index      ON chunk TYPE int;                 -- 0-based ordering
DEFINE FIELD IF NOT EXISTS start_line       ON chunk TYPE int;                 -- 1-indexed, inclusive
DEFINE FIELD IF NOT EXISTS end_line         ON chunk TYPE int;                 -- 1-indexed, inclusive
DEFINE FIELD IF NOT EXISTS content          ON chunk TYPE string;
DEFINE FIELD IF NOT EXISTS embedding        ON chunk TYPE array<float>;        -- 768-dim vector
DEFINE FIELD IF NOT EXISTS chunk_type       ON chunk TYPE string
    ASSERT $value IN [
        'function', 'class', 'trait', 'interface',
        'method', 'block', 'top_level', 'config'
    ];
DEFINE FIELD IF NOT EXISTS language         ON chunk TYPE string;
DEFINE FIELD IF NOT EXISTS token_estimate   ON chunk TYPE int;
DEFINE FIELD IF NOT EXISTS symbol_name      ON chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS parent_scope     ON chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS visibility       ON chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS leading_context  ON chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS imports_snapshot ON chunk TYPE option<string>;
DEFINE FIELD IF NOT EXISTS indexed_at       ON chunk TYPE datetime             DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at       ON chunk TYPE datetime             DEFAULT time::now();

-- BM25 full-text search on chunk content and context fields.
-- Note: SurrealDB 3.0 requires one field per FULLTEXT index.
DEFINE INDEX IF NOT EXISTS chunk_fts_content
    ON chunk
    FIELDS content
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS chunk_fts_symbol_name
    ON chunk
    FIELDS symbol_name
    FULLTEXT ANALYZER ident_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

DEFINE INDEX IF NOT EXISTS chunk_fts_leading_context
    ON chunk
    FIELDS leading_context
    FULLTEXT ANALYZER code_analyzer
    BM25(1.2, 0.75)
    HIGHLIGHTS;

-- HNSW vector index on chunk embeddings.
DEFINE INDEX IF NOT EXISTS chunk_embedding_hnsw
    ON chunk
    FIELDS embedding
    HNSW DIMENSION 768
    DIST COSINE
    EFC 256
    M 16;

-- Common filtering / ordering indexes.
DEFINE INDEX IF NOT EXISTS chunk_file_order
    ON chunk
    FIELDS file, chunk_index;

DEFINE INDEX IF NOT EXISTS chunk_type_language
    ON chunk
    FIELDS chunk_type, language;

-- ============================================================================
-- GRAPH EDGE: file_chunk
-- ============================================================================
-- Ordered relation from file -> chunk with coverage metadata.

DEFINE TABLE IF NOT EXISTS file_chunk SCHEMAFULL TYPE RELATION
    IN  file
    OUT chunk;

DEFINE FIELD IF NOT EXISTS in           ON file_chunk TYPE record<file>;
DEFINE FIELD IF NOT EXISTS out          ON file_chunk TYPE record<chunk>;
DEFINE FIELD IF NOT EXISTS chunk_index  ON file_chunk TYPE int;
DEFINE FIELD IF NOT EXISTS is_primary   ON file_chunk TYPE bool  DEFAULT false;
DEFINE FIELD IF NOT EXISTS coverage_pct ON file_chunk TYPE float DEFAULT 0.0;

DEFINE INDEX IF NOT EXISTS file_chunk_in
    ON file_chunk
    FIELDS in;

DEFINE INDEX IF NOT EXISTS file_chunk_in_chunk_index
    ON file_chunk
    FIELDS in, chunk_index;

-- ============================================================================
-- TABLE: file (chunking extensions)
-- ============================================================================
-- Additive field definitions for chunking pipeline metadata.

-- Make file content optional to support chunk-first retrieval.
DEFINE FIELD IF NOT EXISTS content ON file TYPE option<string>;

DEFINE FIELD IF NOT EXISTS chunk_count     ON file TYPE int              DEFAULT 0;
DEFINE FIELD IF NOT EXISTS chunking_status ON file TYPE string           DEFAULT 'pending';
DEFINE FIELD IF NOT EXISTS line_count      ON file TYPE option<int>;
DEFINE FIELD IF NOT EXISTS byte_size       ON file TYPE option<int>;
DEFINE FIELD IF NOT EXISTS last_chunked    ON file TYPE option<datetime>;
