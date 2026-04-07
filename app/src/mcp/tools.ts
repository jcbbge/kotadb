/**
 * MCP tool definitions and execution adapters
 *
 * Local-only v2.0.0: SurrealDB-backed operation
 * Cloud-only tools (projects, get_index_job_status) have been removed.
 */

import {
	getIndexStatistics,
	listRecentFiles,
	queryDependencies,
	queryDependents,
	resolveFilePath,
	runIndexingWorkflow,
	searchFiles,
	hybridSearchFiles,
	hybridSearchSymbols,
	searchSymbolExact,
	extractLineSnippets,
	findSymbolUsages,
	type HybridSymbolResult,
} from "@api/queries";
import { getDomainKeyFiles } from "@api/expertise-queries.js";
import { getDb } from "@db/client.js";
import { generateEmbedding } from "@indexer/embeddings.js";
import { randomUUID } from "node:crypto";
import { buildSnippet } from "@indexer/extractors";
import { createLogger } from "@logging/logger.js";
import type { ChangeImpactRequest, ImplementationSpec, IndexRequest } from "@shared/types";
import { Sentry } from "../instrument.js";
import { analyzeChangeImpact } from "./impact-analysis";
import { invalidParams } from "./jsonrpc";
import { validateImplementationSpec } from "./spec-validation";
import { resolveRepositoryIdentifierWithError } from "./repository-resolver";
import { ensureRepositoryIndexed, type AutoIndexResult } from "./auto-index";
import { startWatching } from "@sync/source-watcher.js";

// ---------------------------------------------------------------------------
// In-process job registry for async indexing
// ---------------------------------------------------------------------------
interface IndexJob {
	status: "running" | "completed" | "failed";
	repository: string;
	startedAt: string;
	completedAt?: string;
	result?: { files_indexed: number; symbols_extracted: number; references_extracted: number };
	error?: string;
}
const indexJobs = new Map<string, IndexJob>();
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { RecordId } from "surrealdb";

const logger = createLogger({ module: "mcp-tools" });

/**
 * MCP Tool Definition
 */
/**
 * Tool tier for categorizing tools by feature set
 */
export type ToolTier = "core" | "sync" | "memory" | "expertise";

export interface ToolDefinition {
	name: string;
	tier: ToolTier;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
	};
}

/**
 * Toolset tier for CLI selection (maps to tool tiers)
 */
export type ToolsetTier = "default" | "core" | "memory" | "full";

/**
 * Filter tools by the requested toolset tier
 *
 * Tier mapping:
 * - core: 6 tools (core tier only)
 * - default: 8 tools (core + sync tiers)
 * - memory: 14 tools (core + sync + memory tiers)
 * - full: all tools
 *
 * @param tier - The toolset tier to filter by
 * @param tools - Optional array of tools (defaults to all tool definitions)
 */
export function filterToolsByTier(tier: ToolsetTier, tools?: ToolDefinition[]): ToolDefinition[] {
	const allTools = tools ?? getToolDefinitions();
	switch (tier) {
		case "core":
			return allTools.filter((t) => t.tier === "core");
		case "default":
			return allTools.filter((t) => t.tier === "core" || t.tier === "sync");
		case "memory":
			return allTools.filter((t) => t.tier === "core" || t.tier === "sync" || t.tier === "memory");
		case "full":
			return allTools;
		default:
			// Default to "default" tier if unknown
			return allTools.filter((t) => t.tier === "core" || t.tier === "sync");
	}
}

/**
 * Alias for filterToolsByTier - get tool definitions filtered by toolset
 *
 * @param toolset - The toolset tier to filter by
 */
export function getToolsByTier(toolset: ToolsetTier): ToolDefinition[] {
	return filterToolsByTier(toolset);
}

/**
 * Validate if a string is a valid toolset tier
 */
export function isValidToolset(value: string): value is ToolsetTier {
	return value === "default" || value === "core" || value === "memory" || value === "full";
}

// ============================================================================
// UNIFIED SEARCH TOOL - Replaces search_code, search_symbols, search_decisions, search_patterns, search_failures  
// Issue: #143
// ============================================================================

/**
 * Tool: search (unified)
 */
export const SEARCH_TOOL: ToolDefinition = {
	tier: "core",
	name: "search",
	description: `USE THIS WHEN you need to find code by natural language query or keyword search.

Search indexed code, symbols, decisions, patterns, and failures.
- 'paths': File paths only (~100 bytes/result)
- 'compact': Summary info (~200 bytes/result) - DEFAULT for code scope
- 'snippet': Matching lines with context (~2KB/result)
- 'full': Complete content (~100KB/result) - Use with caution for code scope

TIPS:
- Use 'snippet' for code exploration (shows matches in context)
- Use 'compact' for quick file discovery
- Use 'full' only for small result sets (symbols, decisions, etc.)

Supports multiple search scopes simultaneously with scope-specific filters.`,
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Search query term or phrase",
			},
			scope: {
				type: "array",
				items: {
					type: "string",
					enum: ["code", "symbols", "decisions", "patterns", "failures"],
				},
				description: "Search scopes to query (default: ['code'])",
			},
			filters: {
				type: "object",
				description: "Scope-specific filters (invalid filters ignored)",
				properties: {
					// Code scope filters
					glob: {
						type: "string",
						description: "File path glob pattern (code scope only)",
					},
					exclude: {
						type: "array",
						items: { type: "string" },
						description: "Exclude patterns (code scope only)",
					},
					language: {
						type: "string",
						description: "Programming language filter (code scope only)",
					},
					// Symbol scope filters
					symbol_kind: {
						type: "array",
						items: {
							type: "string",
							enum: [
								"function",
								"class",
								"interface",
								"type",
								"variable",
								"constant",
								"method",
								"property",
								"module",
								"namespace",
								"enum",
								"enum_member",
							],
						},
						description: "Symbol kinds to include (symbols scope only)",
					},
					exported_only: {
						type: "boolean",
						description: "Only exported symbols (symbols scope only)",
					},
					// Decision scope filters
					decision_scope: {
						type: "string",
						enum: ["architecture", "pattern", "convention", "workaround"],
						description: "Decision category (decisions scope only)",
					},
					// Pattern scope filters
					pattern_type: {
						type: "string",
						description: "Pattern type filter (patterns scope only)",
					},
					// Common filters
					repository: {
						type: "string",
						description: "Repository ID or full_name filter (all scopes)",
					},
				},
			},
			limit: {
				type: "number",
				description: "Max results per scope (default: 20, max: 100)",
			},
			output: {
				type: "string",
				enum: ["full", "paths", "compact", "snippet"],
				description: "Output format: 'paths' (file paths only), 'compact' (summary), 'snippet' (matches with context), 'full' (complete content). Default varies by scope: code='compact', others='full'. WARNING: 'full' + code scope = large results.",
			},
			context_lines: {
				type: "number",
				description: "Lines of context before/after matches (snippet mode only, default: 3, max: 10)",
				minimum: 0,
				maximum: 10,
			},
		},
		required: ["query"],
	},
};


/**
 * Tool: index_repository
 */
export const INDEX_REPOSITORY_TOOL: ToolDefinition = {
	tier: "core",
	name: "index_repository",
	description:
		"Index a git repository by cloning/updating it and extracting code files. Performs synchronous indexing and returns immediately with status 'completed' and full indexing stats.",
	inputSchema: {
		type: "object",
		properties: {
			repository: {
				type: "string",
				description: "Repository identifier (e.g., 'owner/repo' or full git URL)",
			},
			ref: {
				type: "string",
				description: "Optional: Git ref/branch to checkout (default: main/master)",
			},
			localPath: {
				type: "string",
				description: "Optional: Use a local directory instead of cloning from git",
			},
		},
		required: ["repository"],
	},
};

/**
 * Tool: update_repository
 */
export const UPDATE_REPOSITORY_TOOL: ToolDefinition = {
	tier: "core",
	name: "update_repository",
	description:
		"Update an indexed repository to a new version. Wipes all existing index data for the repo and re-indexes from the new ref. Use for version upgrades (e.g. v1.0 \u2192 v2.0).",
	inputSchema: {
		type: "object",
		properties: {
			repository: {
				type: "string",
				description: "Repository identifier (e.g. 'solidjs/solid')",
			},
			ref: {
				type: "string",
				description:
					"Git ref to update to: tag, branch, or commit SHA (e.g. 'v2.0.0-beta.1')",
			},
			localPath: {
				type: "string",
				description:
					"Local clone path. Required if not in default clone store (~/.kotadb/repos/owner/repo)",
			},
		},
		required: ["repository", "ref"],
	},
};

/**
 * Tool: indexing_status
 */
export const INDEXING_STATUS_TOOL: ToolDefinition = {
	tier: "core",
	name: "indexing_status",
	description: "Check the status of a background indexing job started by index_repository. Returns status (running/completed/failed), progress info, and final stats when done.",
	inputSchema: {
		type: "object",
		properties: {
			jobId: {
				type: "string",
				description: "Job ID returned by index_repository",
			},
		},
		required: ["jobId"],
	},
};

export function executeIndexingStatus(params: unknown): unknown {
	if (typeof params !== "object" || params === null) throw new Error("Parameters must be an object");
	const p = params as Record<string, unknown>;
	if (!p.jobId || typeof p.jobId !== "string") throw new Error("Missing required parameter: jobId");

	const job = indexJobs.get(p.jobId);
	if (!job) {
		return {
			content: [{ type: "text", text: JSON.stringify({ error: `No job found with id: ${p.jobId}` }) }],
		};
	}

	const response: Record<string, unknown> = {
		jobId: p.jobId,
		status: job.status,
		repository: job.repository,
		startedAt: job.startedAt,
	};
	if (job.completedAt) response.completedAt = job.completedAt;
	if (job.result) response.stats = job.result;
	if (job.error) response.error = job.error;

	return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
}

/**
 * Tool: list_repositories
 */
export const LIST_REPOSITORIES_TOOL: ToolDefinition = {
	tier: "core",
	name: "list_repositories",
	description:
		"List all indexed repositories. Returns repository metadata including name, local path, current ref, last indexed timestamp, and stats.",
	inputSchema: {
		type: "object",
		properties: {
			limit: {
				type: "number",
				description: "Optional: Maximum number of repos to return (default: 20)",
			},
		},
	},
};

/**
 * Tool: remove_repository
 */
export const REMOVE_REPOSITORY_TOOL: ToolDefinition = {
	tier: "core",
	name: "remove_repository",
	description:
		"Remove a repository from the index. Deletes all associated files, symbols, and references. Optionally removes the local clone from the clone store.",
	inputSchema: {
		type: "object",
		properties: {
			repository: {
				type: "string",
				description: "Repository identifier (full_name or UUID)",
			},
			deleteClone: {
				type: "boolean",
				description:
					"Optional: Also delete the local clone from the clone store (default: false)",
			},
		},
		required: ["repository"],
	},
};

/**
 * Tool: list_recent_files
 */
export const LIST_RECENT_FILES_TOOL: ToolDefinition = {
	tier: "core",
	name: "list_recent_files",
	description:
		"List recently indexed files, ordered by indexing timestamp. Useful for seeing what code is available.",
	inputSchema: {
		type: "object",
		properties: {
			limit: {
				type: "number",
				description: "Optional: Maximum number of files to return (default: 10)",
			},
			repository: {
				type: "string",
				description: "Optional: Filter results to a specific repository ID",
			},
		},
	},
};

/**
 * Tool: search_dependencies
 */
export const SEARCH_DEPENDENCIES_TOOL: ToolDefinition = {
	tier: "core",
	name: "search_dependencies",
	description:
		"USE THIS WHEN you need to know what files depend on a target file or what files it depends on - before refactoring or deleting. Search the dependency graph to find files that depend on (dependents) or are depended on by (dependencies) a target file. Essential for impact analysis, test scope discovery, and circular dependency detection.",
	inputSchema: {
		type: "object",
		properties: {
			file_path: {
				type: "string",
				description: "Relative file path within the repository (e.g., 'src/auth/context.ts')",
			},
			direction: {
				type: "string",
				enum: ["dependents", "dependencies", "both"],
				description:
					"Search direction: 'dependents' (files that import this file), 'dependencies' (files this file imports), or 'both' (default: 'both')",
			},
			depth: {
				type: "number",
				description:
					"Recursion depth for traversal (1-5, default: 1). Higher values find indirect relationships.",
			},
			include_tests: {
				type: "boolean",
				description:
					"Include test files in results (default: true). Set to false to filter out files with 'test' or 'spec' in path.",
			},
			reference_types: {
				type: "array",
				items: {
					type: "string",
					enum: ["import", "re_export", "export_all", "dynamic_import"],
				},
				description:
					"Filter by reference types (default: ['import', 're_export', 'export_all']). Add 'dynamic_import' to include lazy-loaded dependencies.",
			},
			repository: {
				type: "string",
				description: "Repository ID to search within. Required for multi-repository workspaces.",
			},
		},
		required: ["file_path"],
	},
};

/**
 * Tool: find_usages
 */
export const FIND_USAGES_TOOL: ToolDefinition = {
	tier: "core",
	name: "find_usages",
	description:
		"USE THIS WHEN refactoring a function, class, or type and you need to know all the places it's used so you don't break anything. Find all usages of a specific symbol across the indexed codebase. Returns call sites, imports, re-exports, and type references with file locations and context snippets. Essential for safe refactoring - operates at the symbol level unlike search_dependencies which is file-level.",
	inputSchema: {
		type: "object",
		properties: {
			symbol: {
				type: "string",
				description: "Symbol name to find usages for (e.g., 'createDatabase', 'KotaDatabase')",
			},
			file: {
				type: "string",
				description: "Optional: file path to disambiguate if the symbol exists in multiple files (e.g., 'src/db/surreal/client.ts')",
			},
			include_definitions: {
				type: "boolean",
				description: "Whether to include the symbol's own definition in results (default: false)",
			},
			include_tests: {
				type: "boolean",
				description: "Whether to include usages in test files (default: true)",
			},
			repository: {
				type: "string",
				description: "Repository ID or full_name to search within (optional, auto-detected if single repo)",
			},
		},
		required: ["symbol"],
	},
};


/**
 * Tool: analyze_change_impact
 */
export const ANALYZE_CHANGE_IMPACT_TOOL: ToolDefinition = {
	tier: "core",
	name: "analyze_change_impact",
	description:
		"USE THIS WHEN planning any code change that affects multiple files. Analyze the impact of proposed code changes by examining dependency graphs, test scope, and potential conflicts. Returns comprehensive analysis including affected files, test recommendations, architectural warnings, and risk assessment. Essential for avoiding breaking changes.",
	inputSchema: {
		type: "object",
		properties: {
			files_to_modify: {
				type: "array",
				items: { type: "string" },
				description: "List of files to be modified (relative paths)",
			},
			files_to_create: {
				type: "array",
				items: { type: "string" },
				description: "List of files to be created (relative paths)",
			},
			files_to_delete: {
				type: "array",
				items: { type: "string" },
				description: "List of files to be deleted (relative paths)",
			},
			change_type: {
				type: "string",
				enum: ["feature", "refactor", "fix", "chore"],
				description: "Type of change being made",
			},
			description: {
				type: "string",
				description: "Brief description of the proposed change",
			},
			breaking_changes: {
				type: "boolean",
				description: "Whether this change includes breaking changes (default: false)",
			},
			repository: {
				type: "string",
				description: "Repository ID to analyze (optional, uses first repository if not specified)",
			},
		},
		required: ["change_type", "description"],
	},
};

/**
 * Tool: get_index_statistics
 */
export const GET_INDEX_STATISTICS_TOOL: ToolDefinition = {
	tier: "core",
	name: "get_index_statistics",
	description:
		"Get statistics about indexed data (files, symbols, references, decisions, patterns, failures). Useful for understanding what data is available for search.",
	inputSchema: {
		type: "object",
		properties: {},
		required: [],
	},
};

/**
 * Tool: validate_implementation_spec
 */
export const VALIDATE_IMPLEMENTATION_SPEC_TOOL: ToolDefinition = {
	tier: "expertise",
	name: "validate_implementation_spec",
	description:
		"Validate an implementation specification against KotaDB conventions and repository state. Checks for file conflicts, naming conventions, path alias usage, test coverage, and dependency compatibility. Returns validation errors, warnings, and approval conditions checklist.",
	inputSchema: {
		type: "object",
		properties: {
			feature_name: {
				type: "string",
				description: "Name of the feature or change",
			},
			files_to_create: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						purpose: { type: "string" },
						estimated_lines: { type: "number" },
					},
					required: ["path", "purpose"],
				},
				description: "Files to create with their purposes",
			},
			files_to_modify: {
				type: "array",
				items: {
					type: "object",
					properties: {
						path: { type: "string" },
						purpose: { type: "string" },
						estimated_lines: { type: "number" },
					},
					required: ["path", "purpose"],
				},
				description: "Files to modify with their purposes",
			},
			migrations: {
				type: "array",
				items: {
					type: "object",
					properties: {
						filename: { type: "string" },
						description: { type: "string" },
						tables_affected: {
							type: "array",
							items: { type: "string" },
						},
					},
					required: ["filename", "description"],
				},
				description: "Database migrations to add",
			},
			dependencies_to_add: {
				type: "array",
				items: {
					type: "object",
					properties: {
						name: { type: "string" },
						version: { type: "string" },
						dev: { type: "boolean" },
					},
					required: ["name"],
				},
				description: "npm dependencies to add",
			},
			breaking_changes: {
				type: "boolean",
				description: "Whether this includes breaking changes (default: false)",
			},
			repository: {
				type: "string",
				description: "Repository ID (optional, uses first repository if not specified)",
			},
		},
		required: ["feature_name"],
	},
};

/**
 * Tool: kota_sync_export
 */
export const SYNC_EXPORT_TOOL: ToolDefinition = {
	tier: "sync",
	name: "kota_sync_export",
	description: "Export local SurrealDB data to JSONL files for git sync.",
	inputSchema: {
		type: "object",
		properties: {
			force: {
				type: "boolean",
				description: "Force export even if tables unchanged (default: false)",
			},
			export_dir: {
				type: "string",
				description: "Optional: Custom export directory path",
			},
		},
	},
};

/**
 * Tool: kota_sync_import
 */
export const SYNC_IMPORT_TOOL: ToolDefinition = {
	tier: "sync",
	name: "kota_sync_import",
	description: "Import JSONL files into local SurrealDB.",
	inputSchema: {
		type: "object",
		properties: {
			import_dir: {
				type: "string",
				description: "Optional: Custom import directory path (default: .kotadb/export)",
			},
		},
	},
};

/**
 * Tool: generate_task_context
 *
 * Generates structured context for hook-based context seeding.
 * Used by PreToolUse and SubagentStart hooks to inject dependency info.
 * Target: <100ms response time
 */
export const GENERATE_TASK_CONTEXT_TOOL: ToolDefinition = {
	tier: "core",
	name: "generate_task_context",
	description:
		"Generate structured context for a set of files including dependency counts, impacted files, test files, and recent changes. Designed for hook-based context injection with <100ms performance target.",
	inputSchema: {
		type: "object",
		properties: {
			files: {
				type: "array",
				items: { type: "string" },
				description: "List of file paths to analyze (relative to repository root)",
			},
			include_tests: {
				type: "boolean",
				description: "Include test file discovery (default: true)",
			},
			include_symbols: {
				type: "boolean",
				description: "Include symbol information for each file (default: false)",
			},
			max_impacted_files: {
				type: "number",
				description: "Maximum number of impacted files to return (default: 20)",
			},
			repository: {
				type: "string",
				description: "Repository ID or full_name (optional, uses most recent if not specified)",
			},
		},
		required: ["files"],
	},
};

// ============================================================================
// Memory Layer Tool Definitions
// ============================================================================

/**
 * Tool: record_decision
 */
export const RECORD_DECISION_TOOL: ToolDefinition = {
	tier: "memory",
	name: "record_decision",
	description:
		"Record a new architectural decision for future reference. Decisions are searchable via search_decisions.",
	inputSchema: {
		type: "object",
		properties: {
			title: {
				type: "string",
				description: "Decision title/summary",
			},
			context: {
				type: "string",
				description: "Context and background for the decision",
			},
			decision: {
				type: "string",
				description: "The actual decision made",
			},
			scope: {
				type: "string",
				enum: ["architecture", "pattern", "convention", "workaround"],
				description: "Decision scope/category (default: pattern)",
			},
			rationale: {
				type: "string",
				description: "Optional: Why this decision was made",
			},
			alternatives: {
				type: "array",
				items: { type: "string" },
				description: "Optional: Alternatives that were considered",
			},
			related_files: {
				type: "array",
				items: { type: "string" },
				description: "Optional: Related file paths",
			},
			repository: {
				type: "string",
				description: "Optional: Repository ID or full_name",
			},
		},
		required: ["title", "context", "decision"],
	},
};

/**
 * Tool: record_failure
 */
export const RECORD_FAILURE_TOOL: ToolDefinition = {
	tier: "memory",
	name: "record_failure",
	description:
		"Record a failed approach for future reference. Helps agents avoid repeating mistakes.",
	inputSchema: {
		type: "object",
		properties: {
			title: {
				type: "string",
				description: "Failure title/summary",
			},
			problem: {
				type: "string",
				description: "The problem being solved",
			},
			approach: {
				type: "string",
				description: "The approach that was tried",
			},
			failure_reason: {
				type: "string",
				description: "Why the approach failed",
			},
			related_files: {
				type: "array",
				items: { type: "string" },
				description: "Optional: Related file paths",
			},
			repository: {
				type: "string",
				description: "Optional: Repository ID or full_name",
			},
		},
		required: ["title", "problem", "approach", "failure_reason"],
	},
};

/**
 * Tool: record_insight
 */
export const RECORD_INSIGHT_TOOL: ToolDefinition = {
	tier: "memory",
	name: "record_insight",
	description:
		"Store a session insight for future agents. Insights are discoveries, failures, or workarounds.",
	inputSchema: {
		type: "object",
		properties: {
			content: {
				type: "string",
				description: "The insight content",
			},
			insight_type: {
				type: "string",
				enum: ["discovery", "failure", "workaround"],
				description: "Type of insight",
			},
			session_id: {
				type: "string",
				description: "Optional: Session identifier for grouping",
			},
			related_file: {
				type: "string",
				description: "Optional: Related file path",
			},
			repository: {
				type: "string",
				description: "Optional: Repository ID or full_name",
			},
		},
		required: ["content", "insight_type"],
	},
};


// ============================================================================
// Dynamic Expertise Tool Definitions
// ============================================================================

/**
 * Tool: get_domain_key_files
 */
export const GET_DOMAIN_KEY_FILES_TOOL: ToolDefinition = {
	tier: "expertise",
	name: "get_domain_key_files",
	description:
		"Get the most-depended-on files for a domain. Key files are core infrastructure that many other files depend on.",
	inputSchema: {
		type: "object",
		properties: {
			domain: {
				type: "string",
				description: "Domain name (e.g., 'database', 'api', 'indexer', 'testing', 'claude-config', 'agent-authoring', 'automation', 'github', 'documentation')",
			},
			limit: {
				type: "number",
				description: "Optional: Maximum number of files to return (default: 10)",
			},
			repository: {
				type: "string",
				description: "Optional: Filter to a specific repository ID",
			},
		},
		required: ["domain"],
	},
};

/**
 * Tool: validate_expertise
 */
export const VALIDATE_EXPERTISE_TOOL: ToolDefinition = {
	tier: "expertise",
	name: "validate_expertise",
	description:
		"Validate that key_files defined in expertise.yaml exist in the indexed codebase. Checks for stale or missing file references.",
	inputSchema: {
		type: "object",
		properties: {
			domain: {
				type: "string",
				description: "Domain name to validate (e.g., 'database', 'api', 'indexer')",
			},
		},
		required: ["domain"],
	},
};

/**
 * Tool: sync_expertise
 */
export const SYNC_EXPERTISE_TOOL: ToolDefinition = {
	tier: "expertise",
	name: "sync_expertise",
	description:
		"Sync patterns from expertise.yaml files to the patterns table. Extracts pattern definitions and stores them for future reference.",
	inputSchema: {
		type: "object",
		properties: {
			domain: {
				type: "string",
				description: "Optional: Specific domain to sync. If not provided, syncs all domains.",
			},
			force: {
				type: "boolean",
				description: "Optional: Force sync even if patterns already exist (default: false)",
			},
		},
	},
};

/**
 * Tool: get_recent_patterns
 */
export const GET_RECENT_PATTERNS_TOOL: ToolDefinition = {
	tier: "expertise",
	name: "get_recent_patterns",
	description:
		"Get recently observed patterns from the patterns table. Useful for understanding codebase conventions.",
	inputSchema: {
		type: "object",
		properties: {
			domain: {
				type: "string",
				description: "Optional: Filter patterns by domain",
			},
			days: {
				type: "number",
				description: "Optional: Only return patterns from the last N days (default: 30)",
			},
			limit: {
				type: "number",
				description: "Optional: Maximum number of patterns to return (default: 20)",
			},
			repository: {
				type: "string",
				description: "Optional: Filter to a specific repository ID",
			},
		},
	},
};


// ============================================================================
// SEMANTIC SEARCH TOOL — vector similarity search via Ollama embeddings
// ============================================================================

/**
 * Tool: semantic_search
 */
export const SEMANTIC_SEARCH_TOOL: ToolDefinition = {
	tier: "core",
	name: "semantic_search",
	description:
		"Search indexed files using semantic vector similarity. Returns files ranked by conceptual relevance to the query rather than exact keyword matches. Requires Ollama (nomic-embed-text) and embeddings to have been generated for the repository (run index_repository first).",
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Natural-language search query describing the code you are looking for",
			},
			repository: {
				type: "string",
				description: "Optional: Repository ID or full_name to scope the search to a single repo",
			},
			limit: {
				type: "number",
				description: "Optional: Maximum number of results to return (default: 10)",
			},
		},
		required: ["query"],
	},
};

/**
 * Tool: search_symbol_exact
 *
 * BM25-only symbol search — no embedding required.
 * Best for: exact symbol name lookup, partial-name matching, quick symbol
 * discovery when you know what you're looking for.
 * The code_search analyzer splits camelCase (getUserById → get/user/by/id)
 * so partial queries like "getUser" still find "getUserById".
 */
export const SEARCH_SYMBOL_EXACT_TOOL: ToolDefinition = {
	tier: "core",
	name: "search_symbol_exact",
	description: `Find symbols by exact or partial name using BM25 full-text search (no embedding required).

Best for:
- Exact symbol lookup: "getUserById", "AuthContext"
- Partial name match: "getUser" finds "getUserById", "getUserByEmail"
- Fast discovery when you know the symbol name or a fragment of it

Uses the code_search analyzer (camelCase-aware) which splits identifiers into
sub-tokens, so camelCase, snake_case, and PascalCase all match correctly.

Returns results sorted by BM25 relevance score.`,
	inputSchema: {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Symbol name or partial name to search for",
			},
			symbol_kind: {
				type: "array",
				items: {
					type: "string",
					enum: [
						"function", "class", "interface", "type",
						"variable", "constant", "method", "property",
						"module", "namespace", "enum", "enum_member",
					],
				},
				description: "Optional: Filter by symbol kind(s)",
			},
			exported_only: {
				type: "boolean",
				description: "Optional: Only return exported symbols (default: false)",
			},
			repository: {
				type: "string",
				description: "Optional: Repository ID or full_name to scope the search",
			},
			limit: {
				type: "number",
				description: "Optional: Maximum number of results (default: 20, max: 100)",
			},
		},
		required: ["query"],
	},
};

/**
 * Get all available tool definitions
 */
export function getToolDefinitions(): ToolDefinition[] {
	return [
		SEARCH_TOOL,
		INDEX_REPOSITORY_TOOL,
		INDEXING_STATUS_TOOL,
		UPDATE_REPOSITORY_TOOL,
		LIST_RECENT_FILES_TOOL,
		SEARCH_DEPENDENCIES_TOOL,
		FIND_USAGES_TOOL,
		ANALYZE_CHANGE_IMPACT_TOOL,
		GET_INDEX_STATISTICS_TOOL,
		VALIDATE_IMPLEMENTATION_SPEC_TOOL,
		SYNC_EXPORT_TOOL,
		SYNC_IMPORT_TOOL,
		GENERATE_TASK_CONTEXT_TOOL,
		// Semantic/hybrid search (vector embeddings via Ollama + BM25)
		SEMANTIC_SEARCH_TOOL,
		// Fast BM25-only exact symbol lookup
		SEARCH_SYMBOL_EXACT_TOOL,
SEARCH_CHUNKS_TOOL,
GET_FILE_CHUNKS_TOOL,
GET_CHUNK_CONTEXT_TOOL,
		// Memory Layer tools
		RECORD_DECISION_TOOL,
		RECORD_FAILURE_TOOL,
		RECORD_INSIGHT_TOOL,
		// Dynamic Expertise tools
		GET_DOMAIN_KEY_FILES_TOOL,
		VALIDATE_EXPERTISE_TOOL,
		SYNC_EXPERTISE_TOOL,
		GET_RECENT_PATTERNS_TOOL,
	];
}
/**

/**
 * Type guard for list_recent_files params
 */
function isListRecentParams(params: unknown): params is { limit?: number; repository?: string } | undefined {
	if (params === undefined) return true;
	if (typeof params !== "object" || params === null) return false;
	const p = params as Record<string, unknown>;
	if (p.limit !== undefined && typeof p.limit !== "number") return false;
	if (p.repository !== undefined && typeof p.repository !== "string") return false;
	return true;
}

// ============================================================================
// UNIFIED SEARCH - Helper Functions and Types
// ============================================================================

interface NormalizedFilters {
	// Common
	repositoryId?: string;
	// Code
	glob?: string;
	exclude?: string[];
	language?: string;
	// Symbols
	symbol_kind?: string[];
	exported_only?: boolean;
	// Decisions
	decision_scope?: string;
	// Patterns
	pattern_type?: string;
}

async function normalizeFilters(filters: unknown): Promise<NormalizedFilters> {
	if (!filters || typeof filters !== "object") {
		return {};
	}

	const f = filters as Record<string, unknown>;
	const normalized: NormalizedFilters = {};

	// Resolve repository (UUID or full_name)
	if (f.repository && typeof f.repository === "string") {
		const resolved = await resolveRepositoryIdentifierWithError(f.repository);
		if (!("error" in resolved)) {
			normalized.repositoryId = resolved.id;
		}
	}
	
	// Extract typed filters (silently ignore invalid)
	if (f.glob && typeof f.glob === "string") {
		normalized.glob = f.glob;
	}
	
	if (Array.isArray(f.exclude)) {
		normalized.exclude = f.exclude.filter(e => typeof e === "string");
	}
	
	if (f.language && typeof f.language === "string") {
		normalized.language = f.language;
	}
	
	if (Array.isArray(f.symbol_kind)) {
		normalized.symbol_kind = f.symbol_kind.filter(k => typeof k === "string");
	}
	
	if (typeof f.exported_only === "boolean") {
		normalized.exported_only = f.exported_only;
	}
	
	if (f.decision_scope && typeof f.decision_scope === "string") {
		normalized.decision_scope = f.decision_scope;
	}
	
	if (f.pattern_type && typeof f.pattern_type === "string") {
		normalized.pattern_type = f.pattern_type;
	}
	
	return normalized;
}

interface SymbolResult {
	id: string;
	name: string;
	kind: string;
	signature: string | null;
	documentation: string | null;
	location: {
		file: string;
		line_start: number;
		line_end: number;
	};
	repository_id: string;
	is_exported: boolean;
}

async function searchSymbols(
	query: string,
	filters: NormalizedFilters,
	limit: number
): Promise<SymbolResult[]> {
	// Normalize dotted/scoped queries: "heap.DebugAllocator" → "DebugAllocator"
	// Take the last segment of dot/colon/slash-delimited paths for BM25 symbol search.
	const lastToken = query.trim().split(/[.:\s/]+/).filter(Boolean).at(-1) ?? query;
	const bm25Query = lastToken.length > 1 ? lastToken : query;

	// Generate query embedding for hybrid search.
	// Falls back to pure BM25 when Ollama is unavailable (queryVector = null).
	const queryVector = await generateEmbedding(query);

	const hybridResults = await hybridSearchSymbols(bm25Query, queryVector, {
		repositoryId: filters.repositoryId,
		symbolKinds: filters.symbol_kind,
		exportedOnly: filters.exported_only,
		limit,
	});

	return hybridResults.map((r: HybridSymbolResult) => ({
		id: r.id,
		name: r.name,
		kind: r.kind,
		signature: r.signature,
		documentation: r.documentation,
		location: {
			file: r.filePath,
			line_start: r.lineStart,
			line_end: r.lineEnd,
		},
		repository_id: r.repositoryId,
		is_exported: r.isExported,
	}));
}

/**
 * Internal interface for ranking search tips by priority.
 * Not exported — the public API still returns string[].
 */
interface SearchTip {
	category: 'scope' | 'filter' | 'format' | 'tool';
	message: string;
	priority: 'high' | 'medium' | 'low';
}

/** Map priority to numeric value for sorting (higher = first). */
const PRIORITY_ORDER: Record<SearchTip['priority'], number> = {
	high: 3,
	medium: 2,
	low: 1,
};

/** Maximum number of tips returned per search. */
const MAX_TIPS = 2;

/**
 * Generate contextual tips based on search query and parameters.
 * Uses static pattern matching (no NLP) to detect suboptimal usage patterns.
 * 
 * Tips are ranked by priority (high > medium > low) and capped at MAX_TIPS.
 * Previously shown tips can be suppressed via seenTips.
 * 
 * @param query - Search query string
 * @param scopes - Search scopes used
 * @param filters - Normalized filters applied
 * @param scopeResults - Results by scope
 * @param seenTips - Optional array of previously shown tip messages to suppress
 * @returns Array of tip strings (empty if search is optimal)
 */
function generateSearchTips(
	query: string,
	scopes: string[],
	filters: NormalizedFilters,
	scopeResults: Record<string, unknown[]>,
	seenTips?: string[]
): string[] {
	const tips: SearchTip[] = [];
	const queryLower = query.toLowerCase();
	const totalResults = Object.values(scopeResults).reduce((sum, arr) => sum + arr.length, 0);

	// --- Empty Results Tips (checked first, highest priority) ---
	if (totalResults === 0) {
		tips.push({
			category: 'scope',
			message: 'No results found. Try broader search terms or fewer filters.',
			priority: 'high',
		});
		const hasActiveFilters = !!(filters.glob || filters.language || filters.repositoryId || filters.symbol_kind || filters.exported_only !== undefined || filters.decision_scope || filters.pattern_type || filters.exclude?.length);
		if (hasActiveFilters) {
			tips.push({
				category: 'filter',
				message: 'Your search has active filters. Try removing some to broaden results.',
				priority: 'high',
			});
		}
	}
	
	// Pattern 1: Query contains structural keywords but not using symbols scope
	const structuralKeywords = ['function', 'class', 'interface', 'type', 'method', 'component'];
	const hasStructuralKeyword = structuralKeywords.some(kw => queryLower.includes(kw));
	
	if (hasStructuralKeyword && !scopes.includes('symbols')) {
		const matchedKeyword = structuralKeywords.find(kw => queryLower.includes(kw)) || 'function';
		tips.push({
			category: 'scope',
			message: `You searched for "${query}" in code. Try scope: ['symbols'] with filters: {symbol_kind: ['${matchedKeyword}']} for precise structural discovery.`,
			priority: 'high',
		});
	}
	
	// Pattern 2: Query looks like a file path but using code search
	const looksLikeFilePath = /^[\w\-./]+\.(ts|tsx|js|jsx|py|rs|go|java)$/i.test(query);
	if (looksLikeFilePath && scopes.includes('code')) {
		tips.push({
			category: 'tool',
			message: `Query "${query}" looks like a file path. Consider using search_dependencies tool to find files that depend on this file or its dependencies.`,
			priority: 'high',
		});
	}
	
	// Pattern 3: Symbol search without exported_only filter
	if (scopes.includes('symbols') && filters.exported_only === undefined) {
		const symbolCount = scopeResults['symbols']?.length || 0;
		if (symbolCount > 10) {
			tips.push({
				category: 'filter',
				message: `Found ${symbolCount} symbols. Add filters: {exported_only: true} to narrow to public API only.`,
				priority: 'medium',
			});
		}
	}
	
	// Pattern 4: No repository filter with large result set
	// Suppressed when repositoryId is already set (user intentionally filtered)
	if (!filters.repositoryId) {
		if (totalResults > 20) {
			tips.push({
				category: 'filter',
				message: `Found ${totalResults} results across all repositories. Add filters: {repository: "owner/repo"} to narrow to a specific repository.`,
				priority: 'medium',
			});
		}
	}
	
	// Pattern 5: Code search without glob/language filters
	// Suppressed when glob OR language is already set (user intentionally filtered)
	if (scopes.includes('code') && !filters.glob && !filters.language) {
		const codeCount = scopeResults['code']?.length || 0;
		if (codeCount > 15) {
			tips.push({
				category: 'filter',
				message: `Found ${codeCount} code results. Try filters: {glob: "**/*.ts"} or {language: "typescript"} to narrow file types.`,
				priority: 'medium',
			});
		}
	}
	
	// Pattern 6: Suggest decisions scope for "why" questions
	if (/\b(why|reason|decision|chose|choice)\b/i.test(query) && !scopes.includes('decisions')) {
		tips.push({
			category: 'scope',
			message: 'Query contains "why/reason/decision". Try scope: [\'decisions\'] to search architectural decisions and rationale.',
			priority: 'high',
		});
	}
	
	// Pattern 7: Suggest patterns scope for "how" questions
	if (/\b(how|pattern|best practice|convention)\b/i.test(query) && !scopes.includes('patterns')) {
		tips.push({
			category: 'scope',
			message: 'Query asks "how to". Try scope: [\'patterns\'] to search coding patterns and conventions from this codebase.',
			priority: 'high',
		});
	}
	
	// Pattern 8: Suggest failures scope for error-related queries
	if (/\b(error|bug|fail|issue|problem|fix)\b/i.test(query) && !scopes.includes('failures')) {
		tips.push({
			category: 'scope',
			message: 'Query mentions errors/issues. Try scope: [\'failures\'] to learn from past mistakes and avoid repeated failures.',
			priority: 'high',
		});
	}
	
	// Pattern 9: Single scope when multi-scope could be useful
	// Suppressed when user already uses multiple scopes
	if (scopes.length === 1 && scopes[0] === 'code') {
		tips.push({
			category: 'scope',
			message: "Tip: You can search multiple scopes simultaneously. Try scope: ['code', 'symbols'] for broader discovery.",
			priority: 'low',
		});
	}
	
	// Pattern 10: Suggest compact format for large result sets
	if (totalResults > 30 && !tips.some(t => t.message.includes('output: "compact"'))) {
		tips.push({
			category: 'format',
			message: `Returning ${totalResults} full results. Use output: "compact" for summary view or output: "paths" for file paths only.`,
			priority: 'low',
		});
	}
	
	// --- Final ranking and filtering ---
	// Sort by priority: high > medium > low
	tips.sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]);

	// Slice to max tips
	const ranked = tips.slice(0, MAX_TIPS);

	// Filter out previously seen tips
	const seen = seenTips ? new Set(seenTips) : null;
	const filtered = seen ? ranked.filter(t => !seen.has(t.message)) : ranked;

	// Return plain strings for backward compatibility
	return filtered.map(t => t.message);
}

function formatSearchResults(
	query: string,
	scopes: string[],
	scopeResults: Record<string, unknown[]>,
	format: string,
	filters: NormalizedFilters,
	contextLines?: number,
	seenTips?: string[]
): Record<string, unknown> {
	const response: Record<string, unknown> = {
		query,
		scopes,
		results: {} as Record<string, unknown>,
		counts: { total: 0 } as Record<string, unknown>,
	};

	for (const scope of scopes) {
		const items = scopeResults[scope] || [];
		
		if (format === "paths") {
			// Extract file paths only
			(response.results as Record<string, unknown>)[scope] = items.map((item: any) => {
				if (item.path) return item.path;
				if (item.file_path) return item.file_path;
				if (item.location?.file) return item.location.file;
				return "unknown";
			});
		} else if (format === "compact") {
			// Summary info only
			(response.results as Record<string, unknown>)[scope] = items.map((item: any) => {
				if (scope === "code") {
					return { path: item.path, match_count: 1 };
				} else if (scope === "symbols") {
					return { name: item.name, kind: item.kind, file: item.location.file };
				} else if (scope === "decisions") {
					return { title: item.title, scope: item.scope };
				} else if (scope === "patterns") {
					return { pattern_type: item.pattern_type, file_path: item.file_path };
				} else if (scope === "failures") {
					return { title: item.title, problem: item.problem };
				}
				return item;
			});
		} else if (format === "snippet") {
			// Snippet extraction with context
			if (scope === "code") {
				(response.results as Record<string, unknown>)[scope] = items.map((item: any) => {
					const matches = extractLineSnippets(
						item.content || "",
						query,
						contextLines || 3
					);
					return {
						path: item.path,
						matches: matches
					};
				});
			} else {
				// For non-code scopes, fall back to compact format
				// (snippets only meaningful for code files)
				(response.results as Record<string, unknown>)[scope] = items.map((item: any) => {
					if (scope === "symbols") {
						return { name: item.name, kind: item.kind, file: item.location.file };
					} else if (scope === "decisions") {
						return { title: item.title, scope: item.scope };
					} else if (scope === "patterns") {
						return { pattern_type: item.pattern_type, file_path: item.file_path };
					} else if (scope === "failures") {
						return { title: item.title, problem: item.problem };
					}
					return item;
				});
			}
		} else {
			// Full details
			(response.results as Record<string, unknown>)[scope] = items;
		}
		
		(response.counts as Record<string, unknown>)[scope] = items.length;
		(response.counts as Record<string, unknown>).total = ((response.counts as Record<string, unknown>).total as number) + items.length;
	}

	
	// Generate and add tips if applicable
	const tips = generateSearchTips(query, scopes, filters, scopeResults, seenTips);
	if (tips.length > 0) {
		response.tips = tips;
	}
	
	return response;
}


// ============================================================================
// UNIFIED SEARCH - Execute Function
// ============================================================================

/**
 * Execute search tool (unified search across multiple scopes)
 */
export async function executeSearch(
	params: unknown,
	requestId: string | number,
	userId: string,
): Promise<unknown> {
	// Validate params structure
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	// Check required parameter: query
	if (p.query === undefined) {
		throw new Error("Missing required parameter: query");
	}
	if (typeof p.query !== "string") {
		throw new Error("Parameter 'query' must be a string");
	}

	// Validate optional parameters
	let scopes: string[] = ["code"]; // Default scope
	if (p.scope !== undefined) {
		if (!Array.isArray(p.scope)) {
			throw new Error("Parameter 'scope' must be an array");
		}
		const validScopes = ["code", "symbols", "decisions", "patterns", "failures"];
		for (const s of p.scope) {
			if (typeof s !== "string" || !validScopes.includes(s)) {
				throw new Error(`Invalid scope: ${s}. Must be one of: ${validScopes.join(", ")}`);
			}
		}
		scopes = p.scope as string[];
	}

	if (p.limit !== undefined && typeof p.limit !== "number") {
		throw new Error("Parameter 'limit' must be a number");
	}

	if (p.output !== undefined) {
		if (typeof p.output !== "string" || !["full", "paths", "compact", "snippet"].includes(p.output)) {
			throw new Error("Parameter 'output' must be one of: full, paths, compact, snippet");
		}
	}

	if (p.context_lines !== undefined && typeof p.context_lines !== "number") {
		throw new Error("Parameter 'context_lines' must be a number");
	}

	if (p.context_lines !== undefined && (p.context_lines < 0 || p.context_lines > 10)) {
		throw new Error("Parameter 'context_lines' must be between 0 and 10");
	}

	const limit = Math.min(Math.max((p.limit as number) || 20, 1), 100);
	// Determine default output based on scopes
	let defaultOutput = "full";
	if (scopes.length === 1 && scopes[0] === "code") {
		defaultOutput = "compact";  // Code-only searches default to compact
	} else if (scopes.includes("code") && scopes.length > 1) {
		defaultOutput = "compact";  // Multi-scope including code defaults to compact
	}

	const output = (p.output as string) || defaultOutput;
	const contextLines = Math.min(Math.max((p.context_lines as number) || 3, 0), 10);
	// Merge top-level `repository` param into filters so callers don't need nested syntax
	const rawFilters = typeof p.filters === "object" && p.filters !== null
		? { ...(p.filters as Record<string, unknown>), ...(p.repository ? { repository: p.repository } : {}) }
		: (p.repository ? { repository: p.repository } : p.filters);
	const filters = await normalizeFilters(rawFilters);

	// Route to scope handlers in parallel
	const results: Record<string, unknown[]> = {};
	const searchPromises: Promise<void>[] = [];

	if (scopes.includes("code")) {
		searchPromises.push(
			(async () => {
				// searchFiles is now async (SurrealDB)
				const codeResults = await searchFiles(p.query as string, {
					repositoryId: filters.repositoryId,
					limit,
				});
				results.code = codeResults;
			})()
		);
	}

	if (scopes.includes("symbols")) {
		searchPromises.push(
			(async () => {
				const symbolResults = await searchSymbols(p.query as string, filters, limit);
				results.symbols = symbolResults;
			})()
		);
	}

	if (scopes.includes("decisions")) {
		searchPromises.push(
			(async () => {
				// Reuse existing executeSearchDecisions logic
				const decisionParams = {
					query: p.query,
					scope: filters.decision_scope,
					repository: filters.repositoryId,
					limit,
				};
				const decisionResults = await executeSearchDecisions(decisionParams, requestId, userId);
				results.decisions = (decisionResults as { results: unknown[] }).results;
			})()
		);
	}

	if (scopes.includes("patterns")) {
		searchPromises.push(
			(async () => {
				// Reuse existing executeSearchPatterns logic
				const patternParams = {
					query: p.query,
					pattern_type: filters.pattern_type,
					repository: filters.repositoryId,
					limit,
				};
				const patternResults = await executeSearchPatterns(patternParams, requestId, userId);
				results.patterns = (patternResults as { results: unknown[] }).results;
			})()
		);
	}

	if (scopes.includes("failures")) {
		searchPromises.push(
			(async () => {
				// Reuse existing executeSearchFailures logic
				const failureParams = {
					query: p.query,
					repository: filters.repositoryId,
					limit,
				};
				const failureResults = await executeSearchFailures(failureParams, requestId, userId);
				results.failures = (failureResults as { results: unknown[] }).results;
			})()
		);
	}

	await Promise.all(searchPromises);

	// Format output
	const response = formatSearchResults(p.query as string, scopes, results, output, filters, contextLines);

	logger.info("Unified search completed", {
		query: p.query,
		scopes,
		total_results: (response.counts as Record<string, unknown>).total,
		user_id: userId,
	});

	return response;
}

/**
 * Execute search_code tool
 *
 * AUTO-INDEX: If no repository is indexed, automatically indexes the cwd.
 */
export async function executeSearchCode(
	params: unknown,
	requestId: string | number,
	userId: string,
): Promise<unknown> {
	// Validate params structure
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	// Check required parameter: term
	if (p.term === undefined) {
		throw new Error("Missing required parameter: term");
	}
	if (typeof p.term !== "string") {
		throw new Error("Parameter 'term' must be a string");
	}

	// Validate optional parameters
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}
	if (p.limit !== undefined && typeof p.limit !== "number") {
		throw new Error("Parameter 'limit' must be a number");
	}

	const validatedParams = p as {
		term: string;
		repository?: string;
		limit?: number;
	};

	// AUTO-INDEX: Ensure repository is indexed before searching
	let autoIndexResult: AutoIndexResult | null = null;
	let repositoryId = validatedParams.repository;

	try {
		autoIndexResult = await ensureRepositoryIndexed(validatedParams.repository);
		repositoryId = autoIndexResult.repositoryId;
		
		if (autoIndexResult.wasIndexed) {
			logger.info("Auto-indexed repository before search", {
				repositoryId,
				filesIndexed: autoIndexResult.stats?.filesIndexed,
			});
		}
	} catch (error) {
		// Log but don't fail - allow search to proceed (may return empty results)
		logger.warn("Auto-index check failed, proceeding with search", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	// Use SurrealDB via searchFiles
	const results = await searchFiles(validatedParams.term, {
		repositoryId: repositoryId,
		limit: validatedParams.limit,
	});

	const response: Record<string, unknown> = {
		results: results.map((row) => ({
			projectRoot: row.projectRoot,
			path: row.path,
			snippet: buildSnippet(row.content, validatedParams.term),
			dependencies: row.dependencies,
			indexedAt: row.indexedAt.toISOString(),
		})),
	};

	// Include auto-index info if indexing was performed
	if (autoIndexResult?.wasIndexed) {
		response.auto_indexed = {
			message: autoIndexResult.message,
			stats: autoIndexResult.stats,
		};
	}

	return response;
}

/**
 * Execute list_repositories tool
 */
export async function executeListRepositories(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;
	const limit = typeof p.limit === "number" ? p.limit : 20;

	const { getDb } = await import("@db/client.js");

	const db = await getDb();
	const [rows] = await db.query<
		Array<
			Array<{
				id: unknown;
				name: string;
				full_name: string;
				local_path: string | null;
				current_commit: string | null;
				ref: string | null;
				default_branch: string;
				last_indexed_at: string | null;
				created_at: string;
			}>
		>
	>(
		`SELECT id, name, full_name, local_path, current_commit, ref, default_branch, last_indexed_at, created_at 
     FROM repo 
     ORDER BY last_indexed_at DESC 
     LIMIT $limit`,
		{ limit },
	);

	const repositories = (rows ?? []).map((row) => {
		let id: string;
		if (row.id instanceof RecordId) {
			id = String(row.id.id);
		} else if (typeof row.id === "string") {
			id = row.id.replace(/^repo:[<\u27e8]?(.*?)[>\u27e9]?$/, "$1").replace(/^repo:/, "");
		} else {
			id = String(row.id);
		}

		return {
			id,
			name: row.name,
			full_name: row.full_name,
			local_path: row.local_path,
			current_commit: row.current_commit,
			ref: row.ref,
			default_branch: row.default_branch,
			last_indexed_at: row.last_indexed_at,
			created_at: row.created_at,
		};
	});

	return {
		repositories,
		count: repositories.length,
	};
}

/**
 * Execute remove_repository tool
 */
export async function executeRemoveRepository(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	if (p.repository === undefined || typeof p.repository !== "string") {
		throw new Error("Missing or invalid required parameter: repository");
	}

	const repository = p.repository;
	const deleteClone = p.deleteClone === true;

	const { getDb } = await import("@db/client.js");
	const { resolveRepositoryIdentifier } = await import("./repository-resolver.js");
	const { deleteClone: deleteCloneFromStore } = await import("@indexer/clone-store.js");

	// Resolve repository ID
	const repositoryId = await resolveRepositoryIdentifier(repository);
	if (!repositoryId) {
		throw new Error(`Repository not found: ${repository}`);
	}

	const db = await getDb();

	// Helper to create record ID (SurrealDB format)
	const rid = (table: string, id: string): string => `${table}:\u27E8${id}\u27E9`;

	// Get repo info for clone deletion
	const repoRecordId = rid("repo", repositoryId);
	const [repoRows] = await db.query<
		Array<Array<{ full_name: string; local_path: string | null }>>
	>(`SELECT full_name, local_path FROM ${repoRecordId}`);

	const repoInfo = repoRows?.[0];

	// Delete associated data first (cascade should handle this, but being explicit)
	logger.info("Deleting repository index data", { repositoryId, repository });

	// Delete files
	await db.query(`DELETE FROM file WHERE repo = ${repoRecordId}`);
	// Delete symbols (they should cascade from files, but being explicit)
	await db.query(`DELETE FROM symbol WHERE repo = ${repoRecordId}`);
	// Delete edges
	await db.query(`DELETE FROM calls WHERE in.file IN (SELECT id FROM file WHERE repo = ${repoRecordId})`);
	await db.query(`DELETE FROM imports WHERE in IN (SELECT id FROM file WHERE repo = ${repoRecordId})`);
	await db.query(`DELETE FROM extends WHERE in IN (SELECT id FROM symbol WHERE repo = ${repoRecordId})`);

	// Delete the repo record
	await db.query(`DELETE FROM ${repoRecordId}`);

	logger.info("Repository removed from index", { repositoryId, repository });

	let cloneDeleted = false;
	if (deleteClone && repoInfo?.local_path) {
		try {
			await deleteCloneFromStore(repoInfo.full_name);
			cloneDeleted = true;
			logger.info("Clone deleted from clone store", { full_name: repoInfo.full_name });
		} catch (err) {
			logger.warn("Failed to delete clone", { full_name: repoInfo.full_name, error: err });
		}
	}

	return {
		status: "removed",
		repository,
		repositoryId,
		cloneDeleted,
		message: `Repository '${repository}' removed from index${cloneDeleted ? " and clone deleted" : ""}`,
	};
}

/**
 * Execute index_repository tool
 */
export async function executeIndexRepository(
	params: unknown,
	requestId: string | number,
	userId: string,
): Promise<unknown> {
	// Validate params structure
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	// Check required parameter: repository
	if (p.repository === undefined) {
		throw new Error("Missing required parameter: repository");
	}
	if (typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	// Validate optional parameters
	if (p.ref !== undefined && typeof p.ref !== "string") {
		throw new Error("Parameter 'ref' must be a string");
	}
	if (p.localPath !== undefined && typeof p.localPath !== "string") {
		throw new Error("Parameter 'localPath' must be a string");
	}

	const validatedParams = p as {
		repository: string;
		ref?: string;
		localPath?: string;
	};

	const indexRequest: IndexRequest = {
		repository: validatedParams.repository,
		ref: validatedParams.ref ?? "main", // Default to 'main' if not provided
		localPath: validatedParams.localPath,
	};

	// LOCAL MODE: Fire-and-forget indexing — return immediately, run in background
	const jobId = randomUUID();
	const job: IndexJob = {
		status: "running",
		repository: indexRequest.repository,
		startedAt: new Date().toISOString(),
	};
	indexJobs.set(jobId, job);

	logger.info("Starting local mode indexing (async)", {
		repository: indexRequest.repository,
		localPath: indexRequest.localPath,
		jobId,
	});

	(async () => {
		try {
			const result = await runIndexingWorkflow(indexRequest);

			// Start watching for file changes after successful indexing
			const watchPath = indexRequest.localPath || process.cwd();
			try {
				startWatching(watchPath, result.repositoryId);
			} catch (watchError) {
				logger.warn("Failed to start source watcher", {
					error: watchError instanceof Error ? watchError.message : String(watchError),
					path: watchPath,
				});
			}

			// Embedding backfill — also async
			(async () => {
				try {
					const { embedRepository } = await import("@indexer/embeddings.js");
					await embedRepository(result.repositoryId);
				} catch (embedErr) {
					logger.warn("Background embedding backfill failed", {
						repositoryId: result.repositoryId,
						error: embedErr instanceof Error ? embedErr.message : String(embedErr),
					});
				}
			})();

			job.status = "completed";
			job.completedAt = new Date().toISOString();
			job.result = {
				files_indexed: result.filesIndexed,
				symbols_extracted: result.symbolsExtracted,
				references_extracted: result.referencesExtracted,
			};
			logger.info("Indexing job completed", { jobId, repository: indexRequest.repository, ...job.result });
		} catch (error) {
			job.status = "failed";
			job.completedAt = new Date().toISOString();
			job.error = error instanceof Error ? error.message : String(error);
			logger.error("Indexing job failed", error instanceof Error ? error : undefined, { jobId });
			Sentry.captureException(error, {
				tags: { mode: "local", repository: indexRequest.repository },
			});
		}
	})();

	return {
		jobId,
		repositoryId: jobId,
		status: "started",
		message: `Indexing started in background. Use indexing_status tool with jobId "${jobId}" to check progress.`,
	};
}

/**
 * Execute update_repository tool
 */
export async function executeUpdateRepository(
	params: unknown,
	requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}
	const p = params as Record<string, unknown>;

	if (p.repository === undefined || typeof p.repository !== "string") {
		throw new Error("Missing or invalid required parameter: repository");
	}
	if (p.ref === undefined || typeof p.ref !== "string") {
		throw new Error("Missing or invalid required parameter: ref");
	}
	if (p.localPath !== undefined && typeof p.localPath !== "string") {
		throw new Error("Parameter 'localPath' must be a string");
	}

	const repository = p.repository;
	const ref = p.ref;

	// Resolve default localPath: ~/.kotadb/repos/<owner>/<repo>
	const { homedir } = await import("node:os");
	const { join, resolve, normalize, isAbsolute } = await import("node:path");
	const { existsSync: fsExistsSync } = await import("node:fs");

	let localPath: string;
	if (p.localPath) {
		localPath = resolve(p.localPath as string);
	} else {
		const parts = repository.split("/");
		if (parts.length !== 2) {
			throw new Error(
				`Cannot resolve default localPath: repository must be 'owner/repo' format, got '${repository}'`,
			);
		}
		localPath = join(homedir(), ".kotadb", "repos", parts[0]!, parts[1]!);
	}

	// Security: no path traversal
	if (normalize(localPath) !== localPath) {
		throw new Error(`Path contains traversal characters: ${localPath}`);
	}
	if (!isAbsolute(localPath)) {
		throw new Error(`Resolved path is not absolute: ${localPath}`);
	}

	if (!fsExistsSync(localPath)) {
		throw new Error(`Local path does not exist: ${localPath}`);
	}

	// Step 1: verify the repo is already indexed in SurrealDB
	const db = await getDb();
	const [repoRows] = await db.query<Array<Array<{ id: unknown; metadata: Record<string, unknown> }>>>(
		"SELECT id, metadata FROM repo WHERE full_name = $fullName LIMIT 1",
		{ fullName: repository },
	);
	if (!repoRows || repoRows.length === 0) {
		throw new Error(
			`Repository '${repository}' is not indexed. Use index_repository first.`,
		);
	}

	// Extract repo UUID from SurrealDB record ID
	const rawId = repoRows[0]!.id;
	let repositoryId: string;
	if (rawId instanceof RecordId) {
		repositoryId = String(rawId.id);
	} else if (typeof rawId === "string") {
		// "repo:<uuid>" or bare uuid
		repositoryId = rawId.replace(/^repo:[<\u27e8]?(.*?)[>\u27e9]?$/, "$1").replace(/^repo:/, "");
	} else if (rawId !== null && typeof rawId === "object" && "id" in (rawId as object)) {
		repositoryId = String((rawId as { id: unknown }).id);
	} else {
		repositoryId = String(rawId);
	}

	const previousRef = (repoRows[0]!.metadata?.ref as string | undefined) ?? null;

	// Step 2: git fetch origin
	// Use --unshallow only for shallow clones (complete repos reject that flag)
	logger.info("update_repository: fetching origin", { repository, localPath });
	const isShallowProc = Bun.spawn({
		cmd: ["git", "-C", localPath, "rev-parse", "--is-shallow-repository"],
		stdout: "pipe",
		stderr: "pipe",
	});
	const isShallowOut = (await new Response(isShallowProc.stdout).text()).trim();
	await isShallowProc.exited;
	const fetchCmd = isShallowOut === "true"
		? ["git", "-C", localPath, "fetch", "--tags", "--unshallow", "origin"]
		: ["git", "-C", localPath, "fetch", "--tags", "origin"];
	const fetchProc = Bun.spawn({ cmd: fetchCmd, stdout: "pipe", stderr: "pipe" });
	const fetchStderr = await new Response(fetchProc.stderr).text();
	const fetchExit = await fetchProc.exited;
	if (fetchExit !== 0) {
		throw new Error(`git fetch origin failed (exit ${fetchExit}): ${fetchStderr.trim()}`);
	}

	// Step 3: git checkout <ref>
	logger.info("update_repository: checking out ref", { repository, ref });
	const checkoutProc = Bun.spawn({
		cmd: ["git", "-C", localPath, "checkout", ref],
		stdout: "pipe",
		stderr: "pipe",
	});
	const checkoutStderr = await new Response(checkoutProc.stderr).text();
	const checkoutExit = await checkoutProc.exited;
	if (checkoutExit !== 0) {
		throw new Error(
			`git checkout ${ref} failed (exit ${checkoutExit}): ${checkoutStderr.trim()}`,
		);
	}

	// Step 4: wipe all existing index data for this repo
	logger.info("update_repository: deleting existing index data", { repositoryId });
	const repoRecordId = new RecordId("repo", repositoryId);
	try {
		// Delete edges first (referential integrity), then nodes
		await db.query(
			"DELETE imports WHERE in.repo = $repoId OR out.repo = $repoId",
			{ repoId: repoRecordId },
		);
		await db.query(
			"DELETE calls WHERE in.repo = $repoId OR out.repo = $repoId",
			{ repoId: repoRecordId },
		);
		await db.query(
			"DELETE extends WHERE in.repo = $repoId OR out.repo = $repoId",
			{ repoId: repoRecordId },
		);
		await db.query("DELETE symbol WHERE repo = $repoId", { repoId: repoRecordId });
		await db.query("DELETE file WHERE repo = $repoId", { repoId: repoRecordId });
	} catch (deleteError) {
		throw new Error(
			`Failed to wipe existing index data for '${repository}': ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`,
		);
	}
	logger.info("update_repository: existing index data deleted", { repositoryId });

	// Steps 5+6: re-index and update metadata — fire in background, return immediately
	const jobId = randomUUID();
	const job: IndexJob = {
		status: "running",
		repository,
		startedAt: new Date().toISOString(),
	};
	indexJobs.set(jobId, job);

	logger.info("update_repository: starting re-indexing (async)", { repository, ref, localPath, jobId });

	(async () => {
		try {
			const result = await runIndexingWorkflow({ repository, ref, localPath });

			// Update repo metadata with current commit
			const revParseProc = Bun.spawn({
				cmd: ["git", "-C", localPath, "rev-parse", "HEAD"],
				stdout: "pipe",
				stderr: "pipe",
			});
			const currentCommit = (await new Response(revParseProc.stdout).text()).trim();
			await revParseProc.exited;

			await db.query(
				`UPDATE ${`repo:\u27E8${repositoryId}\u27E9`} SET metadata.ref = $ref, metadata.current_commit = $currentCommit, last_indexed_at = time::now(), updated_at = time::now()`,
				{ ref, currentCommit },
			);

			try {
				startWatching(localPath, result.repositoryId);
			} catch (watchError) {
				logger.warn("update_repository: failed to start source watcher", {
					error: watchError instanceof Error ? watchError.message : String(watchError),
				});
			}

			(async () => {
				try {
					const { embedRepository } = await import("@indexer/embeddings.js");
					await embedRepository(result.repositoryId);
				} catch (embedErr) {
					logger.warn("update_repository: background embedding backfill failed", {
						error: embedErr instanceof Error ? embedErr.message : String(embedErr),
					});
				}
			})();

			job.status = "completed";
			job.completedAt = new Date().toISOString();
			job.result = {
				files_indexed: result.filesIndexed,
				symbols_extracted: result.symbolsExtracted,
				references_extracted: result.referencesExtracted,
			};
			logger.info("update_repository: job completed", { jobId, repository, ...job.result });
		} catch (error) {
			job.status = "failed";
			job.completedAt = new Date().toISOString();
			job.error = error instanceof Error ? error.message : String(error);
			logger.error("update_repository: job failed", error instanceof Error ? error : undefined, { jobId });
			Sentry.captureException(error, {
				tags: { mode: "local", repository, operation: "update_repository" },
			});
		}
	})();

	return {
		jobId,
		repositoryId,
		status: "started",
		previousRef,
		message: `Re-indexing started in background (index wiped, ref checked out to ${ref}). Use indexing_status with jobId "${jobId}" to check progress.`,
	};
}

/**

/**
 * Execute list_recent_files tool
 */
export async function executeListRecentFiles(
	params: unknown,
	requestId: string | number,
	userId: string,
): Promise<unknown> {
	if (!isListRecentParams(params)) {
		throw invalidParams(requestId, "Invalid parameters for list_recent_files tool");
	}

	const limit =
		params && typeof params === "object" && "limit" in params ? (params.limit as number) : 10;
	
	const repository =
		params && typeof params === "object" && "repository" in params 
			? (params.repository as string | undefined) 
			: undefined;

	// Resolve repository ID (supports UUID or full_name)
	let repositoryId = repository;
	if (repositoryId) {
		const repoResult = await resolveRepositoryIdentifierWithError(repositoryId);
		if ("error" in repoResult) {
			return { results: [], message: repoResult.error };
		}
		repositoryId = repoResult.id;
	}

	// Use SurrealDB via listRecentFiles with optional repository filter
	const files = await listRecentFiles(limit, repositoryId);

	return {
		results: files.map((file) => ({
			projectRoot: file.projectRoot,
			path: file.path,
			dependencies: file.dependencies,
			indexedAt: file.indexedAt.toISOString(),
		})),
	};
}

/**
 * Execute search_dependencies tool
 */
export async function executeSearchDependencies(
	params: unknown,
	requestId: string | number,
	userId: string,
): Promise<unknown> {
	// Validate params structure
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	// Check required parameter: file_path
	if (p.file_path === undefined) {
		throw new Error("Missing required parameter: file_path");
	}
	if (typeof p.file_path !== "string") {
		throw new Error("Parameter 'file_path' must be a string");
	}

	// Validate optional parameters
	if (
		p.direction !== undefined &&
		typeof p.direction === "string" &&
		!["dependents", "dependencies", "both"].includes(p.direction)
	) {
		throw new Error("Parameter 'direction' must be one of: dependents, dependencies, both");
	}

	if (p.depth !== undefined) {
		if (typeof p.depth !== "number") {
			throw new Error("Parameter 'depth' must be a number");
		}
		if (p.depth < 1 || p.depth > 5) {
			throw new Error("Parameter 'depth' must be between 1 and 5");
		}
	}

	if (p.include_tests !== undefined && typeof p.include_tests !== "boolean") {
		throw new Error("Parameter 'include_tests' must be a boolean");
	}

	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	// Validate reference_types parameter
	if (p.reference_types !== undefined) {
		if (!Array.isArray(p.reference_types)) {
			throw new Error("Parameter 'reference_types' must be an array");
		}
		const validTypes = ["import", "re_export", "export_all", "dynamic_import"];
		for (const t of p.reference_types) {
			if (typeof t !== "string" || !validTypes.includes(t)) {
				throw new Error(`Invalid reference type: ${t}. Must be one of: ${validTypes.join(", ")}`);
			}
		}
	}

	const validatedParams = {
		file_path: p.file_path as string,
		direction: (p.direction as string | undefined) ?? "both",
		depth: (p.depth as number | undefined) ?? 1,
		include_tests: (p.include_tests as boolean | undefined) ?? true,
		reference_types: (p.reference_types as string[] | undefined) ?? ["import", "re_export", "export_all"],
		repository: p.repository as string | undefined,
	};



	// AUTO-INDEX: Ensure repository is indexed before dependency search
	let autoIndexResult: AutoIndexResult | null = null;
	try {
		autoIndexResult = await ensureRepositoryIndexed(validatedParams.repository);
		// Use auto-indexed repository ID if available
		if (autoIndexResult.wasIndexed) {
			logger.info("Auto-indexed repository before dependency search", {
				repositoryId: autoIndexResult.repositoryId,
				filesIndexed: autoIndexResult.stats?.filesIndexed,
			});
		}
		// Override repository param with resolved ID
		validatedParams.repository = autoIndexResult.repositoryId;
	} catch (error) {
		logger.warn("Auto-index check failed, proceeding with search", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	// Resolve repository ID (supports UUID or full_name)
	const repoResult = await resolveRepositoryIdentifierWithError(validatedParams.repository);
	if ("error" in repoResult) {
		return {
			file_path: validatedParams.file_path,
			message: repoResult.error,
			dependents: { direct: [], indirect: {}, cycles: [] },
			dependencies: { direct: [], indirect: {}, cycles: [] },
		};
	}
	const repositoryId = repoResult.id;

	// Resolve file path to file ID
	const fileId = await resolveFilePath(validatedParams.file_path, repositoryId);

	if (!fileId) {
		return {
			file_path: validatedParams.file_path,
			message:
				"File not found: " + validatedParams.file_path + ". Make sure the repository is indexed.",
			dependents: { direct: [], indirect: {}, cycles: [] },
			dependencies: { direct: [], indirect: {}, cycles: [] },
		};
	}

	// Query dependents and/or dependencies based on direction
	let dependents: {
		direct: string[];
		indirect: Record<string, string[]>;
		cycles: string[][];
	} | null = null;
	let dependencies: {
		direct: string[];
		indirect: Record<string, string[]>;
		cycles: string[][];
	} | null = null;

	if (validatedParams.direction === "dependents" || validatedParams.direction === "both") {
		dependents = await queryDependents(fileId, validatedParams.depth, validatedParams.include_tests, validatedParams.reference_types);
	}

	if (validatedParams.direction === "dependencies" || validatedParams.direction === "both") {
		dependencies = await queryDependencies(fileId, validatedParams.depth, validatedParams.reference_types);
	}

	// Build response
	const result: Record<string, unknown> = {
		file_path: validatedParams.file_path,
		direction: validatedParams.direction,
		depth: validatedParams.depth,
	};

	if (dependents) {
		result.dependents = {
			direct: dependents.direct,
			indirect: dependents.indirect,
			cycles: dependents.cycles,
			count:
				dependents.direct.length +
				Object.values(dependents.indirect).reduce((sum, arr) => sum + arr.length, 0),
		};
	}

	if (dependencies) {
		result.dependencies = {
			direct: dependencies.direct,
			indirect: dependencies.indirect,
			cycles: dependencies.cycles,
			count:
				dependencies.direct.length +
				Object.values(dependencies.indirect).reduce((sum, arr) => sum + arr.length, 0),
		};
	}

	// Query unresolved imports for this file:
	// In SurrealDB, unresolved imports are stored in file.metadata.dependencies
	// but were not resolved into imports edges. We find them by taking the
	// declared dependency list and subtracting the resolved edge targets.
	const surrealDb = await getDb();
	const [fileMetaRows] = await surrealDb.query<Array<Array<{ dependencies: string[] | null }>>>(
		`SELECT metadata.dependencies AS dependencies FROM file:\u27E8${fileId}\u27E9`,
	);
	const declaredDeps: string[] = fileMetaRows?.[0]?.dependencies ?? [];

	// Collect resolved targets from imports edges
	const [resolvedRows] = await surrealDb.query<Array<Array<{ import_source: string | null }>>>(
		`SELECT metadata.importSource AS import_source FROM imports WHERE in = file:\u27E8${fileId}\u27E9`,
	);
	const resolvedSources = new Set(
		(resolvedRows ?? []).map((r) => r.import_source).filter(Boolean) as string[],
	);

	result.unresolved_imports = declaredDeps.filter((dep) => !resolvedSources.has(dep));

	return result;
}

/**
 * Execute find_usages tool
 */
export async function executeFindUsages(
	params: unknown,
	requestId: string | number,
	userId: string,
): Promise<unknown> {
	// Validate params structure
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	// Check required parameter: symbol
	if (p.symbol === undefined) {
		throw new Error("Missing required parameter: symbol");
	}
	if (typeof p.symbol !== "string") {
		throw new Error("Parameter 'symbol' must be a string");
	}

	// Validate optional parameters
	if (p.file !== undefined && typeof p.file !== "string") {
		throw new Error("Parameter 'file' must be a string");
	}

	if (p.include_definitions !== undefined && typeof p.include_definitions !== "boolean") {
		throw new Error("Parameter 'include_definitions' must be a boolean");
	}

	if (p.include_tests !== undefined && typeof p.include_tests !== "boolean") {
		throw new Error("Parameter 'include_tests' must be a boolean");
	}

	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	const validatedParams = {
		symbolName: p.symbol as string,
		filePath: p.file as string | undefined,
		includeDefinitions: (p.include_definitions as boolean | undefined) ?? false,
		includeTests: (p.include_tests as boolean | undefined) ?? true,
		repository: p.repository as string | undefined,
	};

	// AUTO-INDEX: Ensure repository is indexed before find_usages
	let autoIndexResult: AutoIndexResult | null = null;
	try {
		autoIndexResult = await ensureRepositoryIndexed(validatedParams.repository);
		if (autoIndexResult.wasIndexed) {
			logger.info("Auto-indexed repository before find_usages", {
				repositoryId: autoIndexResult.repositoryId,
				filesIndexed: autoIndexResult.stats?.filesIndexed,
			});
		}
		// Override repository param with resolved ID
		validatedParams.repository = autoIndexResult.repositoryId;
	} catch (error) {
		logger.warn("Auto-index check failed, proceeding with find_usages", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	// Resolve repository ID (supports UUID or full_name)
	const repoResult = await resolveRepositoryIdentifierWithError(validatedParams.repository);
	if ("error" in repoResult) {
		return {
			symbol: validatedParams.symbolName,
			message: repoResult.error,
			defined_in: "",
			kind: "",
			usages: [],
			total_usages: 0,
			files_with_usages: 0,
		};
	}
	const repositoryId = repoResult.id;

	// Call findSymbolUsages from @api/queries (now async)
	const result = await findSymbolUsages({
		symbolName: validatedParams.symbolName,
		filePath: validatedParams.filePath,
		repositoryId,
		includeDefinitions: validatedParams.includeDefinitions,
		includeTests: validatedParams.includeTests,
	});

	return result;
}

/**

/**
 * Execute analyze_change_impact tool
 */
export async function executeAnalyzeChangeImpact(
	params: unknown,
	requestId: string | number,
	userId: string,
): Promise<unknown> {
	// Validate params structure
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	// Check required parameters
	if (p.change_type === undefined) {
		throw new Error("Missing required parameter: change_type");
	}
	if (typeof p.change_type !== "string") {
		throw new Error("Parameter 'change_type' must be a string");
	}
	if (!["feature", "refactor", "fix", "chore"].includes(p.change_type)) {
		throw new Error("Parameter 'change_type' must be one of: feature, refactor, fix, chore");
	}

	if (p.description === undefined) {
		throw new Error("Missing required parameter: description");
	}
	if (typeof p.description !== "string") {
		throw new Error("Parameter 'description' must be a string");
	}

	// Validate optional parameters
	if (p.files_to_modify !== undefined && !Array.isArray(p.files_to_modify)) {
		throw new Error("Parameter 'files_to_modify' must be an array");
	}
	if (p.files_to_create !== undefined && !Array.isArray(p.files_to_create)) {
		throw new Error("Parameter 'files_to_create' must be an array");
	}
	if (p.files_to_delete !== undefined && !Array.isArray(p.files_to_delete)) {
		throw new Error("Parameter 'files_to_delete' must be an array");
	}
	if (p.breaking_changes !== undefined && typeof p.breaking_changes !== "boolean") {
		throw new Error("Parameter 'breaking_changes' must be a boolean");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	const validatedParams: ChangeImpactRequest = {
		files_to_modify: p.files_to_modify as string[] | undefined,
		files_to_create: p.files_to_create as string[] | undefined,
		files_to_delete: p.files_to_delete as string[] | undefined,
		change_type: p.change_type as "feature" | "refactor" | "fix" | "chore",
		description: p.description as string,
		breaking_changes: p.breaking_changes as boolean | undefined,
		repository: p.repository as string | undefined,
	};


	// AUTO-INDEX: Ensure repository is indexed before change impact analysis
	try {
		const autoIndexResult = await ensureRepositoryIndexed(validatedParams.repository);
		if (autoIndexResult.wasIndexed) {
			logger.info("Auto-indexed repository before change impact analysis", {
				repositoryId: autoIndexResult.repositoryId,
				filesIndexed: autoIndexResult.stats?.filesIndexed,
			});
		}
		// Override repository param with resolved ID
		validatedParams.repository = autoIndexResult.repositoryId;
	} catch (error) {
		logger.warn("Auto-index check failed, proceeding with analysis", {
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const result = await analyzeChangeImpact(validatedParams, userId);

	return result;
}

/**
 * Execute get_index_statistics tool
 */
export async function executeGetIndexStatistics(
	params: unknown,
	requestId: string | number,
	userId: string,
): Promise<unknown> {
	// No parameters to validate
	
	logger.info("Getting index statistics", { request_id: String(requestId), user_id: userId });
	
	const stats = await getIndexStatistics();

	return {
		...stats,
		summary: `${stats.symbols.toLocaleString()} symbols, ${stats.files.toLocaleString()} files, ${stats.repositories} repositories indexed`,
	};
}

/**

/**
 * Execute validate_implementation_spec tool
 */
export async function executeValidateImplementationSpec(
	params: unknown,
	requestId: string | number,
	userId: string,
): Promise<unknown> {
	// Validate params structure
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	// Check required parameters
	if (p.feature_name === undefined) {
		throw new Error("Missing required parameter: feature_name");
	}
	if (typeof p.feature_name !== "string") {
		throw new Error("Parameter 'feature_name' must be a string");
	}

	// Validate optional parameters
	if (p.files_to_create !== undefined && !Array.isArray(p.files_to_create)) {
		throw new Error("Parameter 'files_to_create' must be an array");
	}
	if (p.files_to_modify !== undefined && !Array.isArray(p.files_to_modify)) {
		throw new Error("Parameter 'files_to_modify' must be an array");
	}
	if (p.migrations !== undefined && !Array.isArray(p.migrations)) {
		throw new Error("Parameter 'migrations' must be an array");
	}
	if (p.dependencies_to_add !== undefined && !Array.isArray(p.dependencies_to_add)) {
		throw new Error("Parameter 'dependencies_to_add' must be an array");
	}
	if (p.breaking_changes !== undefined && typeof p.breaking_changes !== "boolean") {
		throw new Error("Parameter 'breaking_changes' must be a boolean");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	const validatedParams: ImplementationSpec = {
		feature_name: p.feature_name as string,
		files_to_create: p.files_to_create as any,
		files_to_modify: p.files_to_modify as any,
		migrations: p.migrations as any,
		dependencies_to_add: p.dependencies_to_add as any,
		breaking_changes: p.breaking_changes as boolean | undefined,
		repository: p.repository as string | undefined,
	};

	const result = await validateImplementationSpec(validatedParams, userId);

	return result;
}

/**

/**
 * Execute kota_sync_export tool
 * Exports SurrealDB tables to JSONL files for git sync.
 */
export async function executeSyncExport(
	params: unknown,
	_requestId: string | number,
): Promise<unknown> {
	const { force = false, export_dir } = params as { force?: boolean; export_dir?: string };
	const exportDir = export_dir ?? ".kotadb/export";
	const startTime = Date.now();

	try {
		const db = await getDb();
		const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
		const { join } = await import("node:path");

		// Ensure export directory exists
		if (!existsSync(exportDir)) {
			mkdirSync(exportDir, { recursive: true });
		}

		// Tables to export
		const tables = ["repo", "file", "symbol", "reference", "extends", "decision", "failure", "insight", "pattern", "agent_session"];
		let tablesExported = 0;
		let totalRows = 0;
		const exportedFiles: string[] = [];

		for (const table of tables) {
			try {
				// Query all records from table
				const result = await db.query<[unknown[]]>(`SELECT * FROM ${table}`);
				const records = result[0] ?? [];

				if (records.length === 0 && !force) {
					continue; // Skip empty tables unless force is true
				}

				// Convert to JSONL format
				const jsonlLines = records.map((r) => JSON.stringify(r)).join("\\n");
				const filePath = join(exportDir, `${table}.jsonl`);
				writeFileSync(filePath, jsonlLines + (jsonlLines ? "\\n" : ""));

				tablesExported++;
				totalRows += records.length;
				exportedFiles.push(filePath);
			} catch (err) {
				// Table might not exist or be empty, skip
				console.error(`Export warning: could not export table ${table}:`, err);
			}
		}

		const durationMs = Date.now() - startTime;

		return {
			success: true,
			tables_exported: tablesExported,
			rows_exported: totalRows,
			export_dir: exportDir,
			files: exportedFiles,
			duration_ms: durationMs,
		};
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		return {
			success: false,
			error: `Export failed: ${errorMsg}`,
		};
	}
}

/**
 * Execute kota_sync_import tool
 * Imports JSONL files into SurrealDB.
 */
export async function executeSyncImport(
	params: unknown,
	_requestId: string | number,
): Promise<unknown> {
	// Validate params is an object
	if (params === null || params === undefined) {
		return {
			success: true,
			tables_imported: 0,
			rows_imported: 0,
			import_dir: ".kotadb/export",
			duration_ms: 0,
			message: "No parameters provided, using defaults",
		};
	}
	if (typeof params !== "object") {
		throw new Error("Parameters must be an object");
	}
	const { import_dir } = params as { import_dir?: string };
	const importDir = import_dir ?? ".kotadb/export";
	const startTime = Date.now();

	try {
		const db = await getDb();
		const { readFileSync, existsSync, readdirSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { randomUUID } = await import("node:crypto");

		// Check if import directory exists
		if (!existsSync(importDir)) {
			return {
				success: true,
				tables_imported: 0,
				rows_imported: 0,
				import_dir: importDir,
				duration_ms: Date.now() - startTime,
				message: "Import directory does not exist, nothing to import",
			};
		}

		// Get all JSONL files
		const files = readdirSync(importDir).filter((f) => f.endsWith(".jsonl"));

		if (files.length === 0) {
			return {
				success: true,
				tables_imported: 0,
				rows_imported: 0,
				import_dir: importDir,
				duration_ms: Date.now() - startTime,
				message: "No JSONL files found to import",
			};
		}

		let tablesImported = 0;
		let totalRows = 0;
		const errors: string[] = [];

		for (const file of files) {
			try {
				const filePath = join(importDir, file);
				const content = readFileSync(filePath, "utf-8");
				const lines = content.split("\\n").filter((line) => line.trim());

				if (lines.length === 0) {
					continue;
				}

				// Get table name from filename (e.g., repo.jsonl -> repo)
				const tableName = file.replace(".jsonl", "");

				// Import each record
				for (const line of lines) {
					try {
						const record = JSON.parse(line);
						// Use CREATE statement to insert record
						const id = record.id ?? randomUUID();
						await db.query(`CREATE ${tableName}:${id} CONTENT $record`, { record });
						totalRows++;
					} catch (err) {
						const errorMsg = err instanceof Error ? err.message : String(err);
						errors.push(`Failed to import record in ${file}: ${errorMsg}`);
					}
				}

				tablesImported++;
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				errors.push(`Failed to import file ${file}: ${errorMsg}`);
			}
		}

		const durationMs = Date.now() - startTime;

		return {
			success: errors.length === 0,
			tables_imported: tablesImported,
			rows_imported: totalRows,
			import_dir: importDir,
			duration_ms: durationMs,
			errors: errors.length > 0 ? errors : undefined,
		};
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		return {
			success: false,
			error: `Import failed: ${errorMsg}`,
		};
	}
}

/**


/**
 * Execute generate_task_context tool
 *
 * Generates structured context for hook-based context seeding.
 * Performance target: <100ms
 */
export async function executeGenerateTaskContext(
	params: unknown,
	_requestId: string | number,
	userId: string,
): Promise<unknown> {
	const startTime = performance.now();

	// Validate params structure
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	// Check required parameter: files
	if (p.files === undefined) {
		throw new Error("Missing required parameter: files");
	}
	if (!Array.isArray(p.files)) {
		throw new Error("Parameter 'files' must be an array");
	}
	for (const file of p.files) {
		if (typeof file !== "string") {
			throw new Error("Each file in 'files' must be a string");
		}
	}

	// Validate optional parameters
	if (p.include_tests !== undefined && typeof p.include_tests !== "boolean") {
		throw new Error("Parameter 'include_tests' must be a boolean");
	}
	if (p.include_symbols !== undefined && typeof p.include_symbols !== "boolean") {
		throw new Error("Parameter 'include_symbols' must be a boolean");
	}
	if (p.max_impacted_files !== undefined && typeof p.max_impacted_files !== "number") {
		throw new Error("Parameter 'max_impacted_files' must be a number");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	const validatedParams = {
		files: p.files as string[],
		include_tests: (p.include_tests as boolean | undefined) ?? true,
		include_symbols: (p.include_symbols as boolean | undefined) ?? false,
		max_impacted_files: Math.min(Math.max((p.max_impacted_files as number | undefined) ?? 20, 1), 50),
		repository: p.repository as string | undefined,
	};

	// Resolve repository ID
	const repoResult = await resolveRepositoryIdentifierWithError(validatedParams.repository);
	if ("error" in repoResult) {
		return {
			targetFiles: [],
			impactedFiles: [],
			testFiles: [],
			recentChanges: [],
			indexStale: true,
			staleReason: repoResult.error,
			durationMs: Math.round(performance.now() - startTime),
		};
	}
	const repositoryId = repoResult.id;

	const surrealDb = await getDb();

	// Check index freshness
	const [lastIndexedRows] = await surrealDb.query<Array<Array<{ last_indexed_at: string | null }>>>(
		`SELECT last_indexed_at FROM repo WHERE id = repo:\u27E8${repositoryId}\u27E9 LIMIT 1`,
	);
	const indexStale = !lastIndexedRows?.[0]?.last_indexed_at;

	// Process each target file
	interface TargetFileInfo {
		path: string;
		dependentCount: number;
		symbols: Array<{ name: string; kind: string; line: number }>;
	}
	const targetFiles: TargetFileInfo[] = [];
	const allImpactedFiles = new Set<string>();
	const allTestFiles = new Set<string>();

	for (const filePath of validatedParams.files) {
		// Resolve file ID
		const fileId = await resolveFilePath(filePath, repositoryId);

		if (!fileId) {
			// File not indexed yet - add with zero dependents
			targetFiles.push({
				path: filePath,
				dependentCount: 0,
				symbols: [],
			});
			continue;
		}

		// Query dependents (depth 1 for performance)
		const dependents = await queryDependents(fileId, 1, validatedParams.include_tests);

		// Add target file info
		const fileInfo: TargetFileInfo = {
			path: filePath,
			dependentCount: dependents.direct.length,
			symbols: [],
		};

		// Optionally include symbols
		if (validatedParams.include_symbols) {
			const [symbolRows] = await surrealDb.query<Array<Array<{ name: string; kind: string; line_start: number }>>>(
				`SELECT name, kind, line_start FROM symbol WHERE file = file:\u27E8${fileId}\u27E9 ORDER BY line_start LIMIT 20`,
			);
			fileInfo.symbols = (symbolRows ?? []).map((s) => ({
				name: s.name,
				kind: s.kind,
				line: s.line_start,
			}));
		}

		targetFiles.push(fileInfo);

		// Collect impacted files (direct dependents only for speed)
		for (const dep of dependents.direct) {
			if (allImpactedFiles.size < validatedParams.max_impacted_files) {
				allImpactedFiles.add(dep);
			}
		}

		// Discover test files for this file
		if (validatedParams.include_tests) {
			const testPatterns = generateTestFilePatterns(filePath);
			for (const pattern of testPatterns) {
				const testFileId = await resolveFilePath(pattern, repositoryId);
				if (testFileId) {
					allTestFiles.add(pattern);
				}
			}
		}
	}

	// Query recent changes (files modified in last 7 days based on indexed_at)
	const [recentRows] = await surrealDb.query<Array<Array<{ path: string; indexed_at: string }>>>(
		`SELECT path, indexed_at
		 FROM file
		 WHERE repo = repo:\u27E8${repositoryId}\u27E9
		 AND indexed_at > time::now() - 7d
		 ORDER BY indexed_at DESC
		 LIMIT 10`,
	);
	const recentChanges = recentRows ?? [];

	const durationMs = Math.round(performance.now() - startTime);

	logger.debug("generate_task_context completed", {
		user_id: userId,
		files_requested: validatedParams.files.length,
		impacted_count: allImpactedFiles.size,
		test_count: allTestFiles.size,
		duration_ms: durationMs,
	});

	return {
		targetFiles,
		impactedFiles: Array.from(allImpactedFiles),
		testFiles: Array.from(allTestFiles),
		recentChanges: recentChanges.map((r) => ({
			path: r.path,
			indexedAt: r.indexed_at,
		})),
		indexStale,
		staleReason: indexStale ? "Repository has not been indexed" : undefined,
		durationMs,
	};
}

/**

/**
 * Generate potential test file patterns for a source file
 */
function generateTestFilePatterns(sourcePath: string): string[] {
	const patterns: string[] = [];
	const withoutExt = sourcePath.replace(/\.(ts|tsx|js|jsx)$/, "");
	
	// Common test file naming conventions
	patterns.push(withoutExt + ".test.ts");
	patterns.push(withoutExt + ".spec.ts");
	patterns.push(withoutExt + ".test.tsx");
	patterns.push(withoutExt + ".spec.tsx");
	
	// Tests in __tests__ or tests directory
	const fileName = sourcePath.split("/").pop();
	if (fileName) {
		const fileNameWithoutExt = fileName.replace(/\.(ts|tsx|js|jsx)$/, "");
		const dirPath = sourcePath.substring(0, sourcePath.lastIndexOf("/"));
		patterns.push(dirPath + "/__tests__/" + fileNameWithoutExt + ".test.ts");
		patterns.push("tests/" + sourcePath.replace(/\.(ts|tsx)$/, ".test.ts"));
	}
	
	return patterns;
}

/**



// ============================================================================
// Memory Layer Tool Executors
// ============================================================================


/**

/**
 * Execute search_decisions tool
 */
export async function executeSearchDecisions(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	if (p.query === undefined) {
		throw new Error("Missing required parameter: query");
	}
	if (typeof p.query !== "string") {
		throw new Error("Parameter 'query' must be a string");
	}

	if (p.scope !== undefined && typeof p.scope !== "string") {
		throw new Error("Parameter 'scope' must be a string");
	}
	if (p.scope !== undefined && !["architecture", "pattern", "convention", "workaround"].includes(p.scope as string)) {
		throw new Error("Parameter 'scope' must be one of: architecture, pattern, convention, workaround");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}
	if (p.limit !== undefined && typeof p.limit !== "number") {
		throw new Error("Parameter 'limit' must be a number");
	}

	const db = await getDb();
	const limit = Math.min(Math.max((p.limit as number) || 20, 1), 100);

	// NOTE: In SurrealDB 3.0, use @@ for parameterized FTS queries via the SDK.
	// search::score() does not work with $params through the WebSocket RPC in v3.
	const conditions: string[] = [`title @@ $term OR context @@ $term OR decision @@ $term OR rationale @@ $term`];
	const queryParams: Record<string, unknown> = { term: p.query as string, limit };

	if (p.scope) {
		conditions.push(`scope = $scope`);
		queryParams.scope = p.scope as string;
	}

	if (p.repository) {
		const repoResult = await resolveRepositoryIdentifierWithError(p.repository as string);
		if (!("error" in repoResult)) {
			conditions.push(`repo = repo:\u27E8${repoResult.id}\u27E9`);
		}
	}

	const whereClause = conditions.join(" AND ");
	const [rows] = await db.query<Array<Array<{
		id: string;
		title: string;
		context: string;
		decision: string;
		scope: string;
		rationale: string | null;
		alternatives: string[];
		related_files: string[];
		repo: unknown;
		created_at: string;
	}>>>(`SELECT id, title, context, decision, scope, rationale, alternatives, related_files, repo, created_at FROM decision WHERE ${whereClause} LIMIT $limit`, queryParams);

	return {
		results: (rows ?? []).map((row) => ({
			id: row.id,
			title: row.title,
			context: row.context,
			decision: row.decision,
			scope: row.scope,
			rationale: row.rationale,
			alternatives: Array.isArray(row.alternatives) ? row.alternatives : [],
			related_files: Array.isArray(row.related_files) ? row.related_files : [],
			repository_id: row.repo ? String(row.repo) : null,
			created_at: row.created_at,
		})),
		count: (rows ?? []).length,
	};
}

/**

/**
 * Execute record_decision tool
 */
export async function executeRecordDecision(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	if (p.title === undefined || typeof p.title !== "string") {
		throw new Error("Missing or invalid required parameter: title");
	}
	if (p.context === undefined || typeof p.context !== "string") {
		throw new Error("Missing or invalid required parameter: context");
	}
	if (p.decision === undefined || typeof p.decision !== "string") {
		throw new Error("Missing or invalid required parameter: decision");
	}

	const scope = (p.scope as string) || "pattern";
	if (!["architecture", "pattern", "convention", "workaround"].includes(scope)) {
		throw new Error("Parameter 'scope' must be one of: architecture, pattern, convention, workaround");
	}

	if (p.rationale !== undefined && typeof p.rationale !== "string") {
		throw new Error("Parameter 'rationale' must be a string");
	}
	if (p.alternatives !== undefined && !Array.isArray(p.alternatives)) {
		throw new Error("Parameter 'alternatives' must be an array");
	}
	if (p.related_files !== undefined && !Array.isArray(p.related_files)) {
		throw new Error("Parameter 'related_files' must be an array");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	const db = await getDb();
	const id = randomUUID();

	let repoRecordLink: string | null = null;
	if (p.repository) {
		const repoResult = await resolveRepositoryIdentifierWithError(p.repository as string);
		if (!("error" in repoResult)) {
			repoRecordLink = `repo:\u27E8${repoResult.id}\u27E9`;
		}
	}

	await db.query(
		`INSERT INTO decision (id, repo, title, context, decision, scope, rationale, alternatives, related_files) VALUES ($id, $repo, $title, $ctx, $dec, $scope, $rationale, $alternatives, $relFiles)`,
		{
			id,
			repo: repoRecordLink,
			title: p.title as string,
			ctx: p.context as string,
			dec: p.decision as string,
			scope,
			rationale: (p.rationale as string) || null,
			alternatives: (p.alternatives as string[]) || [],
			relFiles: (p.related_files as string[]) || [],
		},
	);

	logger.info("Decision recorded", { id, title: p.title, scope });

	return {
		success: true,
		id,
		message: "Decision recorded successfully",
	};
}

/**

/**
 * Execute search_failures tool
 */
export async function executeSearchFailures(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	if (p.query === undefined) {
		throw new Error("Missing required parameter: query");
	}
	if (typeof p.query !== "string") {
		throw new Error("Parameter 'query' must be a string");
	}

	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}
	if (p.limit !== undefined && typeof p.limit !== "number") {
		throw new Error("Parameter 'limit' must be a number");
	}

	const db = await getDb();
	const limit = Math.min(Math.max((p.limit as number) || 20, 1), 100);

	// NOTE: In SurrealDB 3.0, use @@ for parameterized FTS queries via the SDK.
	// search::score() does not work with $params through the WebSocket RPC in v3.
	const conditions: string[] = [`title @@ $term OR problem @@ $term OR approach @@ $term OR failure_reason @@ $term`];
	const queryParams: Record<string, unknown> = { term: p.query as string, limit };

	if (p.repository) {
		const repoResult = await resolveRepositoryIdentifierWithError(p.repository as string);
		if (!("error" in repoResult)) {
			conditions.push(`repo = repo:\u27E8${repoResult.id}\u27E9`);
		}
	}

	const whereClause = conditions.join(" AND ");
	const [rows] = await db.query<Array<Array<{
		id: string;
		title: string;
		problem: string;
		approach: string;
		failure_reason: string;
		related_files: string[];
		repo: unknown;
		created_at: string;
	}>>>(`SELECT id, title, problem, approach, failure_reason, related_files, repo, created_at FROM failure WHERE ${whereClause} LIMIT $limit`, queryParams);

	return {
		results: (rows ?? []).map((row) => ({
			id: row.id,
			title: row.title,
			problem: row.problem,
			approach: row.approach,
			failure_reason: row.failure_reason,
			related_files: Array.isArray(row.related_files) ? row.related_files : [],
			repository_id: row.repo ? String(row.repo) : null,
			created_at: row.created_at,
		})),
		count: (rows ?? []).length,
	};
}

/**

/**
 * Execute record_failure tool
 */
export async function executeRecordFailure(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	if (p.title === undefined || typeof p.title !== "string") {
		throw new Error("Missing or invalid required parameter: title");
	}
	if (p.problem === undefined || typeof p.problem !== "string") {
		throw new Error("Missing or invalid required parameter: problem");
	}
	if (p.approach === undefined || typeof p.approach !== "string") {
		throw new Error("Missing or invalid required parameter: approach");
	}
	if (p.failure_reason === undefined || typeof p.failure_reason !== "string") {
		throw new Error("Missing or invalid required parameter: failure_reason");
	}

	if (p.related_files !== undefined && !Array.isArray(p.related_files)) {
		throw new Error("Parameter 'related_files' must be an array");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	const db = await getDb();
	const id = randomUUID();

	let repoRecordLink: string | null = null;
	if (p.repository) {
		const repoResult = await resolveRepositoryIdentifierWithError(p.repository as string);
		if (!("error" in repoResult)) {
			repoRecordLink = `repo:\u27E8${repoResult.id}\u27E9`;
		}
	}

	await db.query(
		`INSERT INTO failure (id, repo, title, problem, approach, failure_reason, related_files) VALUES ($id, $repo, $title, $problem, $approach, $failureReason, $relFiles)`,
		{
			id,
			repo: repoRecordLink,
			title: p.title as string,
			problem: p.problem as string,
			approach: p.approach as string,
			failureReason: p.failure_reason as string,
			relFiles: (p.related_files as string[]) || [],
		},
	);

	logger.info("Failure recorded", { id, title: p.title });

	return {
		success: true,
		id,
		message: "Failure recorded successfully",
	};
}

/**

/**
 * Execute search_patterns tool
 */
export async function executeSearchPatterns(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (params !== undefined && (typeof params !== "object" || params === null)) {
		throw new Error("Parameters must be an object");
	}

	const p = (params as Record<string, unknown>) || {};

	if (p.query !== undefined && typeof p.query !== "string") {
		throw new Error("Parameter 'query' must be a string");
	}
	if (p.pattern_type !== undefined && typeof p.pattern_type !== "string") {
		throw new Error("Parameter 'pattern_type' must be a string");
	}
	if (p.file !== undefined && typeof p.file !== "string") {
		throw new Error("Parameter 'file' must be a string");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}
	if (p.limit !== undefined && typeof p.limit !== "number") {
		throw new Error("Parameter 'limit' must be a number");
	}

	const db = await getDb();
	const limit = Math.min(Math.max((p.limit as number) || 20, 1), 100);

	const conditions: string[] = [];
	const queryParams: Record<string, unknown> = { limit };

	if (p.pattern_type) {
		conditions.push(`pattern_type = $patternType`);
		queryParams.patternType = p.pattern_type as string;
	}

	if (p.file) {
		conditions.push(`file_path = $filePath`);
		queryParams.filePath = p.file as string;
	}

	if (p.query) {
		conditions.push(`description @@ $term`);
		queryParams.term = p.query as string;
	}

	if (p.repository) {
		const repoResult = await resolveRepositoryIdentifierWithError(p.repository as string);
		if (!("error" in repoResult)) {
			conditions.push(`repo = repo:\u27E8${repoResult.id}\u27E9`);
		}
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
	const [rows] = await db.query<Array<Array<{
		id: string;
		repo: unknown;
		pattern_type: string;
		file_path: string | null;
		description: string;
		example: string | null;
		created_at: string;
	}>>>(`SELECT id, repo, pattern_type, file_path, description, example, created_at FROM pattern ${whereClause} ORDER BY created_at DESC LIMIT $limit`, queryParams);

	return {
		results: (rows ?? []).map((row) => ({
			id: row.id,
			repository_id: row.repo ? String(row.repo) : null,
			pattern_type: row.pattern_type,
			file_path: row.file_path,
			description: row.description,
			example: row.example,
			created_at: row.created_at,
		})),
		count: (rows ?? []).length,
	};
}

/**

/**
 * Execute record_insight tool
 */
export async function executeRecordInsight(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	if (p.content === undefined || typeof p.content !== "string") {
		throw new Error("Missing or invalid required parameter: content");
	}
	if (p.insight_type === undefined || typeof p.insight_type !== "string") {
		throw new Error("Missing or invalid required parameter: insight_type");
	}
	if (!["discovery", "failure", "workaround"].includes(p.insight_type as string)) {
		throw new Error("Parameter 'insight_type' must be one of: discovery, failure, workaround");
	}

	if (p.session_id !== undefined && typeof p.session_id !== "string") {
		throw new Error("Parameter 'session_id' must be a string");
	}
	if (p.related_file !== undefined && typeof p.related_file !== "string") {
		throw new Error("Parameter 'related_file' must be a string");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	const db = await getDb();
	const id = randomUUID();

	await db.query(
		`INSERT INTO insight (id, session_id, content, insight_type, related_file) VALUES ($id, $sessionId, $content, $insightType, $relFile)`,
		{
			id,
			sessionId: (p.session_id as string) || null,
			content: p.content as string,
			insightType: p.insight_type as string,
			relFile: (p.related_file as string) || null,
		},
	);

	logger.info("Insight recorded", { id, insight_type: p.insight_type });

	return {
		success: true,
		id,
		message: "Insight recorded successfully",
	};
}

/**


// ============================================================================
// Expertise Layer Tool Executors
// ============================================================================

/**
 * Execute get_domain_key_files tool
 * Returns files with highest dependent counts for a domain
 */
export async function executeGetDomainKeyFiles(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	if (p.domain === undefined || typeof p.domain !== "string") {
		throw new Error("Missing or invalid required parameter: domain");
	}
	if (p.limit !== undefined && typeof p.limit !== "number") {
		throw new Error("Parameter 'limit' must be a number");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	const domain = p.domain as string;
	const limit = Math.min(Math.max((p.limit as number) || 10, 1), 50);

	// Resolve repository if provided
	let repositoryId: string | undefined;
	if (p.repository) {
		const repoResult = await resolveRepositoryIdentifierWithError(p.repository as string);
		if (!("error" in repoResult)) {
			repositoryId = repoResult.id;
		}
	}

	// Use getDomainKeyFiles from expertise-queries (now async)
	const keyFiles = await getDomainKeyFiles(domain, limit, repositoryId);

	// Transform to expected output format with purpose field
	const results = keyFiles.map((file) => {
		const pathParts = file.path.split("/");
		const fileName = pathParts.pop() || "";
		const directory = pathParts.pop() || "";
		const purpose = directory ? directory + "/" + fileName : fileName;
		
		return {
			path: file.path,
			dependent_count: file.dependentCount,
			purpose,
		};
	});

	logger.debug("get_domain_key_files completed", {
		domain,
		files_found: results.length,
	});

	return {
		domain,
		key_files: results,
	};
}

/**

/**
 * Execute validate_expertise tool
 * Validates expertise.yaml patterns against indexed code
 */
export async function executeValidateExpertise(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	if (p.domain === undefined || typeof p.domain !== "string") {
		throw new Error("Missing or invalid required parameter: domain");
	}
	if (p.expertise_path !== undefined && typeof p.expertise_path !== "string") {
		throw new Error("Parameter 'expertise_path' must be a string");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	const domain = p.domain as string;
	const defaultPath = ".claude/agents/experts/" + domain + "/expertise.yaml";
	const expertisePath = (p.expertise_path as string) || defaultPath;

	// Check if expertise file exists
	if (!existsSync(expertisePath)) {
		return {
			domain,
			valid: false,
			error: "Expertise file not found: " + expertisePath,
			valid_patterns: [],
			stale_patterns: [],
			missing_key_files: [],
			summary: { total: 0, valid: 0, stale: 0 },
		};
	}

	// Read and parse expertise.yaml
	let expertise: Record<string, unknown>;
	try {
		const content = readFileSync(expertisePath, "utf-8");
		expertise = parseYaml(content) as Record<string, unknown>;
	} catch (error) {
		return {
			domain,
			valid: false,
			error: "Failed to parse expertise.yaml: " + (error instanceof Error ? error.message : String(error)),
			valid_patterns: [],
			stale_patterns: [],
			missing_key_files: [],
			summary: { total: 0, valid: 0, stale: 0 },
		};
	}

	const db = await getDb();

	// Resolve repository if provided
	let repositoryId: string | null = null;
	if (p.repository) {
		const repoResult = await resolveRepositoryIdentifierWithError(p.repository as string);
		if (!("error" in repoResult)) {
			repositoryId = repoResult.id;
		}
	}

	const validPatterns: Array<{ name: string; file_path?: string }> = [];
	const stalePatterns: Array<{ name: string; reason: string }> = [];
	const missingKeyFiles: string[] = [];

	// Helper: check if a file path exists in indexed files
	async function fileExists(filePath: string): Promise<boolean> {
		const repoFilter = repositoryId ? ` AND repo = repo:\u27E8${repositoryId}\u27E9` : "";
		const [rows] = await db.query<Array<Array<{ id: string }>>>(
			`SELECT id FROM file WHERE path LIKE $pattern${repoFilter} LIMIT 1`,
			{ pattern: "%" + filePath },
		);
		return (rows ?? []).length > 0;
	}

	// Extract patterns from expertise.yaml
	const patterns = (expertise.patterns as Record<string, unknown>) || {};
	for (const [patternName, patternData] of Object.entries(patterns)) {
		const pattern = patternData as Record<string, unknown>;
		const filePath = pattern.file_path as string | undefined;

		if (filePath) {
			if (await fileExists(filePath)) {
				validPatterns.push({ name: patternName, file_path: filePath });
			} else {
				stalePatterns.push({ name: patternName, reason: "File not found: " + filePath });
			}
		} else {
			// Pattern without file path - consider valid
			validPatterns.push({ name: patternName });
		}
	}

	// Check key_files from core_implementation
	const coreImpl = (expertise.core_implementation as Record<string, unknown>) || {};
	const keyFiles = (coreImpl.key_files as Array<{ path?: string }>) || [];

	for (const keyFile of keyFiles) {
		const filePath = keyFile.path;
		if (filePath) {
			if (!(await fileExists(filePath))) {
				missingKeyFiles.push(filePath);
			}
		}
	}

	const total = validPatterns.length + stalePatterns.length;
	
	logger.debug("validate_expertise completed", {
		domain,
		valid_count: validPatterns.length,
		stale_count: stalePatterns.length,
		missing_key_files: missingKeyFiles.length,
	});

	return {
		domain,
		valid: stalePatterns.length === 0 && missingKeyFiles.length === 0,
		valid_patterns: validPatterns,
		stale_patterns: stalePatterns,
		missing_key_files: missingKeyFiles,
		summary: {
			total,
			valid: validPatterns.length,
			stale: stalePatterns.length,
		},
	};
}

/**

/**
 * Execute sync_expertise tool
 * Extracts patterns from expertise.yaml and stores in patterns table
 */
export async function executeSyncExpertise(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	if (p.domain === undefined || typeof p.domain !== "string") {
		throw new Error("Missing or invalid required parameter: domain");
	}
	if (p.expertise_path !== undefined && typeof p.expertise_path !== "string") {
		throw new Error("Parameter 'expertise_path' must be a string");
	}
	if (p.dry_run !== undefined && typeof p.dry_run !== "boolean") {
		throw new Error("Parameter 'dry_run' must be a boolean");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	const domain = p.domain as string;
	const defaultPath = ".claude/agents/experts/" + domain + "/expertise.yaml";
	const expertisePath = (p.expertise_path as string) || defaultPath;
	const dryRun = (p.dry_run as boolean) || false;

	// Check if expertise file exists
	if (!existsSync(expertisePath)) {
		return {
			success: false,
			error: "Expertise file not found: " + expertisePath,
			patterns_synced: 0,
			patterns_skipped: 0,
		};
	}

	// Read and parse expertise.yaml
	let expertise: Record<string, unknown>;
	try {
		const content = readFileSync(expertisePath, "utf-8");
		expertise = parseYaml(content) as Record<string, unknown>;
	} catch (error) {
		return {
			success: false,
			error: "Failed to parse expertise.yaml: " + (error instanceof Error ? error.message : String(error)),
			patterns_synced: 0,
			patterns_skipped: 0,
		};
	}

	// Resolve repository if provided
	let repoRecordLink: string | null = null;
	if (p.repository) {
		const repoResult = await resolveRepositoryIdentifierWithError(p.repository as string);
		if (!("error" in repoResult)) {
			repoRecordLink = `repo:\u27E8${repoResult.id}\u27E9`;
		}
	}

	const db = await getDb();

	let patternsSynced = 0;
	let patternsSkipped = 0;
	const syncedPatterns: Array<{ name: string; type: string }> = [];

	// Extract patterns from expertise.yaml
	const patterns = (expertise.patterns as Record<string, unknown>) || {};

	for (const [patternName, patternData] of Object.entries(patterns)) {
		const pattern = patternData as Record<string, unknown>;
		const patternType = domain + ":" + patternName;
		const filePath = (pattern.file_path as string) || null;
		const description = (pattern.description as string) || (pattern.structure as string) || patternName;
		const example = (pattern.example as string) || (pattern.notes as string) || null;

		// Check if pattern already exists
		const [existingRows] = await db.query<Array<Array<{ id: string }>>>(
			`SELECT id FROM pattern WHERE pattern_type = $patternType LIMIT 1`,
			{ patternType },
		);

		if (existingRows && existingRows.length > 0) {
			patternsSkipped++;
			continue;
		}

		if (!dryRun) {
			const id = randomUUID();
			await db.query(
				`INSERT INTO pattern (id, repo, pattern_type, file_path, description, example) VALUES ($id, $repo, $patternType, $filePath, $description, $example)`,
				{ id, repo: repoRecordLink, patternType, filePath, description, example },
			);
		}

		patternsSynced++;
		syncedPatterns.push({ name: patternName, type: patternType });
	}

	logger.info("sync_expertise completed", {
		domain,
		patterns_synced: patternsSynced,
		patterns_skipped: patternsSkipped,
		dry_run: dryRun,
	});

	return {
		success: true,
		dry_run: dryRun,
		patterns_synced: patternsSynced,
		patterns_skipped: patternsSkipped,
		synced_patterns: syncedPatterns,
	};
}

/**

/**
 * Execute get_recent_patterns tool
 * Returns recently observed patterns from the patterns table
 */
export async function executeGetRecentPatterns(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (params !== undefined && (typeof params !== "object" || params === null)) {
		throw new Error("Parameters must be an object");
	}

	const p = (params as Record<string, unknown>) || {};

	if (p.domain !== undefined && typeof p.domain !== "string") {
		throw new Error("Parameter 'domain' must be a string");
	}
	if (p.days !== undefined && typeof p.days !== "number") {
		throw new Error("Parameter 'days' must be a number");
	}
	if (p.limit !== undefined && typeof p.limit !== "number") {
		throw new Error("Parameter 'limit' must be a number");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}

	const db = await getDb();
	const domain = p.domain as string | undefined;
	const days = Math.min(Math.max((p.days as number) || 30, 1), 365);
	const limit = Math.min(Math.max((p.limit as number) || 20, 1), 100);

	const conditions: string[] = [`created_at > time::now() - ${days}d`];
	const queryParams: Record<string, unknown> = { limit };

	// Filter by domain prefix if provided
	if (domain) {
		conditions.push(`pattern_type LIKE $domainPrefix`);
		queryParams.domainPrefix = domain + ":%";
	}

	// Filter by repository if provided
	if (p.repository) {
		const repoResult = await resolveRepositoryIdentifierWithError(p.repository as string);
		if (!("error" in repoResult)) {
			conditions.push(`repo = repo:\u27E8${repoResult.id}\u27E9`);
		}
	}

	const whereClause = `WHERE ${conditions.join(" AND ")}`;
	const [rows] = await db.query<Array<Array<{
		id: string;
		repo: unknown;
		pattern_type: string;
		file_path: string | null;
		description: string;
		example: string | null;
		created_at: string;
	}>>>(`SELECT id, repo, pattern_type, file_path, description, example, created_at FROM pattern ${whereClause} ORDER BY created_at DESC LIMIT $limit`, queryParams);

	logger.debug("get_recent_patterns completed", {
		domain,
		days,
		patterns_found: (rows ?? []).length,
	});

	return {
		patterns: (rows ?? []).map((row) => ({
			id: row.id,
			pattern_type: row.pattern_type,
			file_path: row.file_path,
			description: row.description,
			example: row.example,
			created_at: row.created_at,
		})),
		count: (rows ?? []).length,
		filter: {
			domain: domain || null,
			days,
		},
	};
}

/**

// ============================================================================
// SEMANTIC SEARCH — execute function
// ============================================================================

/**
 * Execute semantic_search tool
 */
export async function executeSemanticSearch(
	params: unknown,
	requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	if (p.query === undefined) {
		throw new Error("Missing required parameter: query");
	}
	if (typeof p.query !== "string") {
		throw new Error("Parameter 'query' must be a string");
	}
	if (p.repository !== undefined && typeof p.repository !== "string") {
		throw new Error("Parameter 'repository' must be a string");
	}
	if (p.limit !== undefined && typeof p.limit !== "number") {
		throw new Error("Parameter 'limit' must be a number");
	}

	const query = p.query as string;
	const repository = p.repository as string | undefined;
	const limit = typeof p.limit === "number" ? Math.min(Math.max(1, p.limit), 100) : 10;

	// Resolve a repository identifier (full_name or UUID) to the raw UUID used
	// in SurrealDB record IDs, if provided.
	let repoId: string | undefined;
	if (repository) {
		const resolved = await resolveRepositoryIdentifierWithError(repository);
		if ("id" in resolved) {
			repoId = resolved.id;
		} else {
			// Could not resolve — search all repos and let SurrealDB return empty
			logger.warn("semantic_search: could not resolve repository, searching all repos", {
				repository,
				reason: resolved.error,
			});
		}
	}

	// Generate query embedding for HNSW vector search.
	// Falls back to pure BM25 if Ollama is unavailable (queryVector = null).
	const queryVector = await generateEmbedding(query);

	if (!queryVector) {
		logger.warn("semantic_search: Ollama unavailable, falling back to BM25-only", { query });
	}

	const rawResults = await hybridSearchFiles(query, queryVector, {
		repositoryId: repoId,
		limit,
	});

	return {
		query,
		repository: repository ?? null,
		search_mode: queryVector ? "hybrid" : "bm25_fallback",
		results: rawResults.map((r) => ({
			id: r.id,
			path: r.path,
			score: r.combinedScore,
			semantic_score: r.semanticScore,
			bm25_score: r.bm25Score,
			// Truncate content to a reasonable preview size
			content_preview: r.content.slice(0, 500),
		})),
		count: rawResults.length,
	};
}

// ============================================================================
// SEARCH_SYMBOL_EXACT — execute function
// ============================================================================

/**
 * Execute search_symbol_exact tool.
 *
 * BM25-only symbol name search — no embedding required, faster than hybrid.
 * Uses the code_search analyzer (camel + blank tokenizers) to split camelCase
 * identifiers into sub-tokens so partial-name queries work reliably.
 */
export async function executeSearchSymbolExact(
	params: unknown,
	_requestId: string | number,
	_userId: string,
): Promise<unknown> {
	if (typeof params !== "object" || params === null) {
		throw new Error("Parameters must be an object");
	}

	const p = params as Record<string, unknown>;

	if (p.query === undefined) {
		throw new Error("Missing required parameter: query");
	}
	if (typeof p.query !== "string") {
		throw new Error("Parameter 'query' must be a string");
	}

	const query = p.query as string;
	const limit = typeof p.limit === "number" ? Math.min(Math.max(1, p.limit), 100) : 20;

	let symbolKinds: string[] | undefined;
	if (Array.isArray(p.symbol_kind)) {
		symbolKinds = p.symbol_kind.filter((k): k is string => typeof k === "string");
	}

	const exportedOnly = typeof p.exported_only === "boolean" ? p.exported_only : false;

	let repoId: string | undefined;
	if (typeof p.repository === "string") {
		const resolved = await resolveRepositoryIdentifierWithError(p.repository);
		if ("id" in resolved) {
			repoId = resolved.id;
		} else {
			logger.warn("search_symbol_exact: could not resolve repository, searching all repos", {
				repository: p.repository,
				reason: resolved.error,
			});
		}
	}

	const results = await searchSymbolExact(query, {
		repositoryId: repoId,
		symbolKinds,
		exportedOnly,
		limit,
	});

	return {
		query,
		search_mode: "bm25_exact",
		results: results.map((r) => ({
			id: r.id,
			name: r.name,
			kind: r.kind,
			signature: r.signature,
			documentation: r.documentation,
			location: {
				file: r.filePath,
				line_start: r.lineStart,
				line_end: r.lineEnd,
			},
			repository_id: r.repositoryId,
			is_exported: r.isExported,
			bm25_score: r.bm25Score,
		})),
		count: results.length,
	};
}

/**
 * Main tool call dispatcher
 */
export async function handleToolCall(
	toolName: string,
	params: unknown,
	requestId: string | number,
	userId: string,
): Promise<unknown> {
	switch (toolName) {
		case "search":
			return await executeSearch(params, requestId, userId);
		case "index_repository":
			return await executeIndexRepository(params, requestId, userId);
		case "update_repository":
			return await executeUpdateRepository(params, requestId, userId);
		case "list_recent_files":
			return await executeListRecentFiles(params, requestId, userId);
		case "search_dependencies":
			return await executeSearchDependencies(params, requestId, userId);
		case "find_usages":
			return await executeFindUsages(params, requestId, userId);
		case "analyze_change_impact":
			return await executeAnalyzeChangeImpact(params, requestId, userId);
		case "validate_implementation_spec":
			return await executeValidateImplementationSpec(params, requestId, userId);
		case "kota_sync_export":
			return await executeSyncExport(params, requestId);
		case "kota_sync_import":
			return await executeSyncImport(params, requestId);
		case "generate_task_context":
			return await executeGenerateTaskContext(params, requestId, userId);
		// Semantic/hybrid search (HNSW + BM25)
		case "semantic_search":
			return await executeSemanticSearch(params, requestId, userId);
		// Fast BM25-only exact symbol lookup
		case "search_symbol_exact":
			return await executeSearchSymbolExact(params, requestId, userId);
case "search_chunks":
return await executeSearchChunks(params, requestId, userId);
case "get_file_chunks":
return await executeGetFileChunks(params, requestId, userId);
case "get_chunk_context":
return await executeGetChunkContext(params, requestId, userId);
		// Memory Layer tools
		case "record_decision":
			return await executeRecordDecision(params, requestId, userId);
		case "record_failure":
			return await executeRecordFailure(params, requestId, userId);
		case "record_insight":
			return await executeRecordInsight(params, requestId, userId);
		// Expertise Layer tools
		case "get_domain_key_files":
			return await executeGetDomainKeyFiles(params, requestId, userId);
		case "validate_expertise":
			return await executeValidateExpertise(params, requestId, userId);
		case "sync_expertise":
			return await executeSyncExpertise(params, requestId, userId);
		case "get_recent_patterns":
			return await executeGetRecentPatterns(params, requestId, userId);
		default:
			throw invalidParams(requestId, "Unknown tool: " + toolName);
	}
}


// ============================================================================
// CHUNK TOOLS — chunk-level retrieval and hybrid search
// ============================================================================

/**
 * Tool: search_chunks
 */
export const SEARCH_CHUNKS_TOOL: ToolDefinition = {
  tier: "core",
  name: "search_chunks",
  description:
    "Search code chunks using hybrid BM25 + semantic ranking. Returns chunk matches with file path, line range, content preview, and relevance score.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language or keyword query for chunk content",
      },
      language: {
        type: "string",
        description: "Optional language filter (e.g. 'php', 'javascript', 'typescript')",
      },
      chunk_type: {
        type: "string",
        description: "Optional chunk type filter (e.g. 'function', 'class', 'method', 'top_level')",
      },
      repository: {
        type: "string",
        description: "Optional repository ID or full_name to scope results",
      },
      limit: {
        type: "number",
        description: "Optional: Maximum number of results (default: 10, max: 100)",
      },
    },
    required: ["query"],
  },
};

/**
 * Tool: get_file_chunks
 */
export const GET_FILE_CHUNKS_TOOL: ToolDefinition = {
  tier: "core",
  name: "get_file_chunks",
  description:
    "Get all chunks for a specific file, ordered by chunk index and line range.",
  inputSchema: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Repository-relative file path (e.g. 'src/api/queries.ts')",
      },
      repo_id: {
        type: "string",
        description: "Repository ID or full_name",
      },
    },
    required: ["file_path", "repo_id"],
  },
};

/**
 * Tool: get_chunk_context
 */
export const GET_CHUNK_CONTEXT_TOOL: ToolDefinition = {
  tier: "core",
  name: "get_chunk_context",
  description:
    "Get a chunk with adjacent previous/next chunks and parent file metadata.",
  inputSchema: {
    type: "object",
    properties: {
      chunk_id: {
        type: "string",
        description: "Chunk record id (UUID or Surreal record id)",
      },
    },
    required: ["chunk_id"],
  },
};

function normalizeRecordId(value: unknown, table?: string): string {
  if (value instanceof RecordId) {
    return String(value.id);
  }

  if (typeof value === "string") {
    if (table) {
      const tablePrefix = `${table}:`;
      if (value.startsWith(tablePrefix)) {
        return value
          .replace(new RegExp(`^${table}:[<\\u27e8]?`), "")
          .replace(/[>\\u27e9]$/, "");
      }
    }

    return value
      .replace(/^[a-z_]+:[<\u27e8]?/i, "")
      .replace(/[>\u27e9]$/, "");
  }

  if (value !== null && typeof value === "object" && "id" in (value as Record<string, unknown>)) {
    return String((value as { id: unknown }).id);
  }

  return String(value);
}

function getFetchedFilePath(file: unknown): string | null {
  if (file && typeof file === "object" && "path" in (file as Record<string, unknown>)) {
    return String((file as { path: unknown }).path);
  }
  return null;
}

function getFetchedFileMeta(file: unknown): {
  id: string;
  path: string;
  language: string;
  chunkCount: number;
  chunkingStatus: string;
  lastChunked: string | null;
  repositoryId: string | null;
} | null {
  if (!file || typeof file !== "object") return null;
  const f = file as Record<string, unknown>;
  return {
    id: normalizeRecordId(f.id, "file"),
    path: typeof f.path === "string" ? f.path : "",
    language: typeof f.language === "string" ? f.language : "unknown",
    chunkCount: typeof f.chunk_count === "number" ? f.chunk_count : 0,
    chunkingStatus: typeof f.chunking_status === "string" ? f.chunking_status : "unknown",
    lastChunked: typeof f.last_chunked === "string" ? f.last_chunked : null,
    repositoryId: f.repo ? normalizeRecordId(f.repo, "repo") : null,
  };
}

/**
 * Execute search_chunks tool
 */
export async function executeSearchChunks(
  params: unknown,
  _requestId: string | number,
  _userId: string,
): Promise<unknown> {
  if (typeof params !== "object" || params === null) {
    throw new Error("Parameters must be an object");
  }

  const p = params as Record<string, unknown>;

  if (p.query === undefined || typeof p.query !== "string") {
    throw new Error("Missing or invalid required parameter: query");
  }
  if (p.language !== undefined && typeof p.language !== "string") {
    throw new Error("Parameter 'language' must be a string");
  }
  if (p.chunk_type !== undefined && typeof p.chunk_type !== "string") {
    throw new Error("Parameter 'chunk_type' must be a string");
  }
  if (p.repository !== undefined && typeof p.repository !== "string") {
    throw new Error("Parameter 'repository' must be a string");
  }
  if (p.limit !== undefined && typeof p.limit !== "number") {
    throw new Error("Parameter 'limit' must be a number");
  }

  const query = p.query as string;
  const language = p.language as string | undefined;
  const chunkType = p.chunk_type as string | undefined;
  const limit = typeof p.limit === "number" ? Math.min(Math.max(1, p.limit), 100) : 10;
  const candidateLimit = Math.min(Math.max(limit * 3, 20), 300);

  let repositoryId: string | undefined;
  if (typeof p.repository === "string") {
    const resolved = await resolveRepositoryIdentifierWithError(p.repository);
    if ("id" in resolved) {
      repositoryId = resolved.id;
    } else {
      logger.warn("search_chunks: could not resolve repository, searching all repos", {
        repository: p.repository,
        reason: resolved.error,
      });
    }
  }

  const db = await getDb();

  type ChunkRow = {
    id: unknown;
    file: unknown;
    chunk_index: number;
    start_line: number;
    end_line: number;
    content: string;
    chunk_type: string;
    language: string;
    bm25_score?: number;
    semantic_score?: number;
  };

  const [bm25Rows] = await db.query<Array<ChunkRow[]>>(
    `SELECT id, file, chunk_index, start_line, end_line, content, chunk_type, language,
            search::score(0) AS bm25_score
       FROM chunk
      WHERE content @0@ $query
        AND ($language = NONE OR language = $language)
        AND ($chunkType = NONE OR chunk_type = $chunkType)
        AND ($repoId = NONE OR file IN (SELECT id FROM file WHERE repo = type::thing('repo', $repoId)))
      ORDER BY bm25_score DESC
      LIMIT $candidateLimit
      FETCH file`,
    {
      query,
      language: language ?? null,
      chunkType: chunkType ?? null,
      repoId: repositoryId ?? null,
      candidateLimit,
    },
  );

  const queryVector = await generateEmbedding(query);

  let semanticRows: ChunkRow[] = [];
  if (queryVector) {
    const [rows] = await db.query<Array<ChunkRow[]>>(
      `SELECT id, file, chunk_index, start_line, end_line, content, chunk_type, language,
              vector::similarity::cosine(embedding, $vec) AS semantic_score
         FROM chunk
        WHERE embedding != NONE
          AND ($language = NONE OR language = $language)
          AND ($chunkType = NONE OR chunk_type = $chunkType)
          AND ($repoId = NONE OR file IN (SELECT id FROM file WHERE repo = type::thing('repo', $repoId)))
        ORDER BY semantic_score DESC
        LIMIT $candidateLimit
        FETCH file`,
      {
        vec: queryVector,
        language: language ?? null,
        chunkType: chunkType ?? null,
        repoId: repositoryId ?? null,
        candidateLimit,
      },
    );
    semanticRows = rows ?? [];
  }

  const bm25Max = Math.max(1e-9, ...(bm25Rows ?? []).map((r) => r.bm25_score ?? 0));
  const semanticMax = Math.max(1e-9, ...semanticRows.map((r) => r.semantic_score ?? 0));

  const merged = new Map<string, {
    id: string;
    file_id: string;
    file_path: string;
    start_line: number;
    end_line: number;
    content_preview: string;
    chunk_type: string;
    language: string;
    bm25_score: number;
    semantic_score: number;
  }>();

  for (const row of bm25Rows ?? []) {
    const id = normalizeRecordId(row.id, "chunk");
    const fileId = normalizeRecordId(row.file, "file");
    const filePath = getFetchedFilePath(row.file) ?? "";

    merged.set(id, {
      id,
      file_id: fileId,
      file_path: filePath,
      start_line: row.start_line,
      end_line: row.end_line,
      content_preview: row.content.slice(0, 500),
      chunk_type: row.chunk_type,
      language: row.language,
      bm25_score: row.bm25_score ?? 0,
      semantic_score: 0,
    });
  }

  for (const row of semanticRows) {
    const id = normalizeRecordId(row.id, "chunk");
    const existing = merged.get(id);

    if (existing) {
      existing.semantic_score = row.semantic_score ?? 0;
      if (!existing.file_path) {
        existing.file_path = getFetchedFilePath(row.file) ?? "";
      }
    } else {
      const fileId = normalizeRecordId(row.file, "file");
      merged.set(id, {
        id,
        file_id: fileId,
        file_path: getFetchedFilePath(row.file) ?? "",
        start_line: row.start_line,
        end_line: row.end_line,
        content_preview: row.content.slice(0, 500),
        chunk_type: row.chunk_type,
        language: row.language,
        bm25_score: 0,
        semantic_score: row.semantic_score ?? 0,
      });
    }
  }

  const results = Array.from(merged.values())
    .map((row) => {
      const normalizedBm25 = row.bm25_score > 0 ? row.bm25_score / bm25Max : 0;
      const normalizedSemantic = row.semantic_score > 0 ? row.semantic_score / semanticMax : 0;
      const score = queryVector
        ? normalizedSemantic * 0.6 + normalizedBm25 * 0.4
        : normalizedBm25;

      return {
        file_path: row.file_path,
        start_line: row.start_line,
        end_line: row.end_line,
        content_preview: row.content_preview,
        score,
        chunk_id: row.id,
        file_id: row.file_id,
        chunk_type: row.chunk_type,
        language: row.language,
        semantic_score: row.semantic_score,
        bm25_score: row.bm25_score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    query,
    repository: repositoryId ?? null,
    search_mode: queryVector ? "hybrid" : "bm25_fallback",
    results,
    count: results.length,
  };
}

/**
 * Execute get_file_chunks tool
 */
export async function executeGetFileChunks(
  params: unknown,
  _requestId: string | number,
  _userId: string,
): Promise<unknown> {
  if (typeof params !== "object" || params === null) {
    throw new Error("Parameters must be an object");
  }

  const p = params as Record<string, unknown>;

  if (p.file_path === undefined || typeof p.file_path !== "string") {
    throw new Error("Missing or invalid required parameter: file_path");
  }
  if (p.repo_id === undefined || typeof p.repo_id !== "string") {
    throw new Error("Missing or invalid required parameter: repo_id");
  }

  const filePath = p.file_path;
  const resolved = await resolveRepositoryIdentifierWithError(p.repo_id);
  if (!("id" in resolved)) {
    throw new Error(`Repository not found: ${p.repo_id}`);
  }
  const repositoryId = resolved.id;

  const db = await getDb();

  type FileRow = {
    id: unknown;
    path: string;
    language: string;
    chunk_count?: number;
    chunking_status?: string;
    last_chunked?: string | null;
  };

  const [fileRows] = await db.query<Array<FileRow[]>>(
    `SELECT id, path, language, chunk_count, chunking_status, last_chunked
       FROM file
      WHERE repo = type::thing('repo', $repoId)
        AND path = $filePath
      LIMIT 1`,
    { repoId: repositoryId, filePath },
  );

  const fileRow = (fileRows ?? [])[0];
  if (!fileRow) {
    return {
      repo_id: repositoryId,
      file_path: filePath,
      chunks: [],
      count: 0,
    };
  }

  const fileRecordId = new RecordId("file", normalizeRecordId(fileRow.id, "file"));

  type ChunkRow = {
    id: unknown;
    chunk_index: number;
    start_line: number;
    end_line: number;
    chunk_type: string;
    language: string;
    content: string;
    token_estimate?: number;
    symbol_name?: string | null;
    parent_scope?: string | null;
    visibility?: string | null;
  };

  const [chunkRows] = await db.query<Array<ChunkRow[]>>(
    `SELECT id, chunk_index, start_line, end_line, chunk_type, language, content,
            token_estimate, symbol_name, parent_scope, visibility
       FROM chunk
      WHERE file = $fileId
      ORDER BY chunk_index ASC, start_line ASC`,
    { fileId: fileRecordId },
  );

  const chunks = (chunkRows ?? []).map((row) => ({
    id: normalizeRecordId(row.id, "chunk"),
    chunk_index: row.chunk_index,
    start_line: row.start_line,
    end_line: row.end_line,
    chunk_type: row.chunk_type,
    language: row.language,
    content: row.content,
    token_estimate: row.token_estimate ?? 0,
    symbol_name: row.symbol_name ?? null,
    parent_scope: row.parent_scope ?? null,
    visibility: row.visibility ?? null,
  }));

  return {
    repo_id: repositoryId,
    file_path: fileRow.path,
    file: {
      id: normalizeRecordId(fileRow.id, "file"),
      path: fileRow.path,
      language: fileRow.language,
      chunk_count: fileRow.chunk_count ?? chunks.length,
      chunking_status: fileRow.chunking_status ?? "unknown",
      last_chunked: fileRow.last_chunked ?? null,
    },
    chunks,
    count: chunks.length,
  };
}

/**
 * Execute get_chunk_context tool
 */
export async function executeGetChunkContext(
  params: unknown,
  _requestId: string | number,
  _userId: string,
): Promise<unknown> {
  if (typeof params !== "object" || params === null) {
    throw new Error("Parameters must be an object");
  }

  const p = params as Record<string, unknown>;

  if (p.chunk_id === undefined || typeof p.chunk_id !== "string") {
    throw new Error("Missing or invalid required parameter: chunk_id");
  }

  const chunkId = normalizeRecordId(p.chunk_id, "chunk");
  const db = await getDb();

  type TargetRow = {
    id: unknown;
    file: unknown;
    chunk_index: number;
    start_line: number;
    end_line: number;
    chunk_type: string;
    language: string;
    content: string;
  };

  const [targetRows] = await db.query<Array<TargetRow[]>>(
    `SELECT id, file, chunk_index, start_line, end_line, chunk_type, language, content
       FROM type::thing('chunk', $chunkId)
      FETCH file`,
    { chunkId },
  );

  const target = (targetRows ?? [])[0];
  if (!target) {
    throw new Error(`Chunk not found: ${p.chunk_id}`);
  }

  const fileId = normalizeRecordId(target.file, "file");
  const fileRecordId = new RecordId("file", fileId);

  type AdjacentRow = {
    id: unknown;
    chunk_index: number;
    start_line: number;
    end_line: number;
    content: string;
  };

  const [prevRows] = await db.query<Array<AdjacentRow[]>>(
    `SELECT id, chunk_index, start_line, end_line, content
       FROM chunk
      WHERE file = $fileId
        AND chunk_index = $chunkIndex
      LIMIT 1`,
    { fileId: fileRecordId, chunkIndex: target.chunk_index - 1 },
  );

  const [nextRows] = await db.query<Array<AdjacentRow[]>>(
    `SELECT id, chunk_index, start_line, end_line, content
       FROM chunk
      WHERE file = $fileId
        AND chunk_index = $chunkIndex
      LIMIT 1`,
    { fileId: fileRecordId, chunkIndex: target.chunk_index + 1 },
  );

  let fileMeta = getFetchedFileMeta(target.file);
  if (!fileMeta) {
    type FileMetaRow = {
      id: unknown;
      path: string;
      language: string;
      chunk_count?: number;
      chunking_status?: string;
      last_chunked?: string | null;
      repo?: unknown;
    };

    const [fileRows] = await db.query<Array<FileMetaRow[]>>(
      `SELECT id, path, language, chunk_count, chunking_status, last_chunked, repo
         FROM type::thing('file', $fileId)
        LIMIT 1`,
      { fileId },
    );

    const f = (fileRows ?? [])[0];
    if (!f) {
      throw new Error(`Parent file not found for chunk: ${p.chunk_id}`);
    }

    fileMeta = {
      id: normalizeRecordId(f.id, "file"),
      path: f.path,
      language: f.language,
      chunkCount: f.chunk_count ?? 0,
      chunkingStatus: f.chunking_status ?? "unknown",
      lastChunked: f.last_chunked ?? null,
      repositoryId: f.repo ? normalizeRecordId(f.repo, "repo") : null,
    };
  }

  const previous = (prevRows ?? [])[0];
  const next = (nextRows ?? [])[0];

  return {
    chunk: {
      id: normalizeRecordId(target.id, "chunk"),
      file_id: fileId,
      file_path: fileMeta.path,
      repository_id: fileMeta.repositoryId,
      chunk_index: target.chunk_index,
      start_line: target.start_line,
      end_line: target.end_line,
      chunk_type: target.chunk_type,
      language: target.language,
      content: target.content,
    },
    previous: previous
      ? {
          id: normalizeRecordId(previous.id, "chunk"),
          chunk_index: previous.chunk_index,
          start_line: previous.start_line,
          end_line: previous.end_line,
          content: previous.content,
        }
      : null,
    next: next
      ? {
          id: normalizeRecordId(next.id, "chunk"),
          chunk_index: next.chunk_index,
          start_line: next.start_line,
          end_line: next.end_line,
          content: next.content,
        }
      : null,
    file: {
      id: fileMeta.id,
      path: fileMeta.path,
      language: fileMeta.language,
      chunk_count: fileMeta.chunkCount,
      chunking_status: fileMeta.chunkingStatus,
      last_chunked: fileMeta.lastChunked,
    },
  };
}
