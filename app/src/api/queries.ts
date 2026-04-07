/**
 * Database query layer for indexed data
 *
 * SurrealDB query layer implementation.
 * All public functions are now async; callers must await them.
 *
 * @module @api/queries
 */

import { randomUUID } from "node:crypto";
import { getDb } from "@db/client.js";
import { resolveImport } from "@indexer/import-resolver.js";
import type { PathMappings } from "@indexer/path-resolver.js";
import type { Reference } from "@indexer/reference-extractor";
import type { Symbol as ExtractedSymbol } from "@indexer/symbol-extractor";
import { storeIndexedData, type ReferenceData as GraphReferenceData } from "@indexer/storage";
import { createLogger } from "@logging/logger.js";
import { detectLanguage } from "@shared/language-utils";
import type { IndexRequest, IndexedFile } from "@shared/types";
import { RecordId } from "surrealdb";

const logger = createLogger({ module: "api-queries" });

/**
 * Normalize file path to consistent format for database storage.
 *
 * Rules:
 * - No leading slashes
 * - Forward slashes only (replace backslashes)
 * - No ./ prefix
 * - Consistent relative-to-repo-root format
 *
 * @param filePath - Absolute or relative file path
 * @returns Normalized relative path
 */
function normalizePath(filePath: string): string {
	let normalized = filePath;

	// Replace backslashes with forward slashes
	normalized = normalized.replace(/\\/g, "/");

	// Remove leading slash if present
	if (normalized.startsWith("/")) {
		normalized = normalized.slice(1);
	}

	// Remove ./ prefix
	if (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}

	return normalized;
}

/**
 * Build a SurrealDB record ID string for a table and UUID.
 * e.g. rid("file", "abc-123") -> "file:⟨abc-123⟩"
 *
 * NOTE: In SurrealDB 3.0 + SDK v2, DO NOT mix rid() string interpolation with
 * $param binding in the same query — the query planner fails to match records.
 * Use ridParam() to get a RecordId object for use as a query parameter instead.
 */
function rid(table: string, id: string): string {
	return `${table}:\u27E8${id}\u27E9`;
}

/**
 * Build a SurrealDB RecordId object for use as a query parameter.
 * This avoids the SurrealDB 3.0 + SDK v2 bug where mixing rid() string
 * interpolation with $param binding causes empty results.
 */
function ridParam(table: string, id: string): RecordId {
	return new RecordId(table, id);
}

/**
 * Extract the UUID string from a SurrealDB record ID.
 * SurrealDB may return record IDs as objects like { tb: "file", id: "abc" }
 * or as strings like "file:⟨abc⟩". This helper normalises both forms.
 */
function extractId(raw: unknown): string {
	if (raw === null || raw === undefined) return "";
	if (typeof raw === "string") {
		// Strip "table:⟨uuid⟩" wrapper if present
		const match = raw.match(/^[^:]+:\u27E8(.+)\u27E9$/);
		if (match) return match[1] ?? raw;
		return raw;
	}
	if (typeof raw === "object") {
		const obj = raw as Record<string, unknown>;
		// Plain object with id/tb fields (legacy SDK shape)
		if (typeof obj["id"] === "string") return obj["id"];
		if (typeof obj["tb"] === "string" && typeof obj["id"] === "string") {
			return obj["id"] as string;
		}
		// SurrealDB SDK RecordId: private #table/#id, but toString() returns "table:⟨uuid⟩"
		const str = String(raw);
		const match = str.match(/^[^:]+:\u27E8(.+)\u27E9$/);
		if (match) return match[1] ?? str;
		// Fallback: plain "table:uuid" without angle brackets
		const plainMatch = str.match(/^[^:]+:(.+)$/);
		if (plainMatch) return plainMatch[1] ?? str;
		return str;
	}
	return String(raw);
}

export interface SearchOptions {
	repositoryId?: string;
	projectId?: string;
	limit?: number;
}

/**
 * Represents a single matching line with surrounding context
 */
export interface SnippetMatch {
	line: number; // 1-indexed line number
	content: string; // The matching line
	context_before: string[]; // N lines before
	context_after: string[]; // N lines after
}

/**
 * Extract line-based snippets from file content showing matches with context.
 *
 * Algorithm:
 * 1. Split content into lines
 * 2. Find all lines matching query (case-insensitive substring match)
 * 3. For each match, extract contextLines before/after
 * 4. Return array of SnippetMatch objects (one per matching line)
 *
 * NOTE: Does NOT merge overlapping contexts - each match gets separate snippet.
 *
 * @param content - Full file content
 * @param query - Search query term
 * @param contextLines - Lines of context before/after (default: 3, max: 10)
 * @returns Array of snippet matches with line numbers and context
 */
export function extractLineSnippets(
	content: string,
	query: string,
	contextLines: number,
): SnippetMatch[] {
	if (!content || !query) return [];

	const lines = content.split("\n");
	const matches: SnippetMatch[] = [];

	// Split query into tokens on whitespace AND common code delimiters (. :: -> /)
	// So "heap.DebugAllocator" or "std::mem::Allocator" both produce useful sub-tokens
	const queryTokens = query.toLowerCase().trim()
		.split(/[\s.:\->/]+/)
		.filter(t => t.length > 1); // skip single-char noise

	lines.forEach((line, index) => {
		const lowerLine = line.toLowerCase();
		const matches_line = queryTokens.some((token) => lowerLine.includes(token));
		if (matches_line) {
			const lineNumber = index + 1; // 1-indexed
			const start = Math.max(0, index - contextLines);
			const end = Math.min(lines.length, index + contextLines + 1);

			matches.push({
				line: lineNumber,
				content: line,
				context_before: lines.slice(start, index),
				context_after: lines.slice(index + 1, end),
			});
		}
	});

	return matches;
}

// ============================================================================
// Repository management
// ============================================================================

/**
 * Ensure repository exists in SurrealDB, create if not.
 *
 * @param fullName - Repository full name (owner/repo format)
 * @param gitUrl - Git URL for the repository (optional)
 * @param defaultBranch - Default branch name (optional, defaults to 'main')
 * @param localPath - Local clone path (optional)
 * @param currentCommit - Current HEAD commit SHA (optional)
 * @param ref - Current branch/tag ref (optional)
 * @returns Repository UUID
 */
export async function ensureRepository(
	fullName: string,
	gitUrl?: string,
	defaultBranch?: string,
	localPath?: string,
	currentCommit?: string,
	ref?: string,
): Promise<string> {
	const db = await getDb();

	const [existing] = await db.query<Array<Array<{ id: unknown }>>>(
		"SELECT id FROM repo WHERE full_name = $fullName LIMIT 1",
		{ fullName },
	);

	if (existing && existing.length > 0 && existing[0] !== undefined) {
		const id = extractId(existing[0].id);
		logger.debug("Repository already exists in SurrealDB", { fullName, id });
		return id;
	}

	const id = randomUUID();
	const name = fullName.split("/").pop() || fullName;

	await db.query(
		`INSERT INTO repo (id, name, full_name, git_url, local_path, current_commit, ref, default_branch, created_at, updated_at)
     VALUES ($id, $name, $fullName, $gitUrl, $localPath, $currentCommit, $ref, $defaultBranch, time::now(), time::now())`,
		{
			id,
			name,
			fullName,
			gitUrl: gitUrl ?? undefined,
			localPath: localPath ?? undefined,
			currentCommit: currentCommit ?? undefined,
			ref: ref ?? undefined,
			defaultBranch: defaultBranch ?? "main",
		},
	);

	logger.info("Created repository in SurrealDB", { fullName, id });
	return id;
}

/**
 * Update repository last_indexed_at timestamp.
 *
 * @param repositoryId - Repository UUID
 */
export async function updateRepositoryLastIndexed(
	repositoryId: string,
): Promise<void> {
	const db = await getDb();
	await db.query(
		`UPDATE ${rid("repo", repositoryId)} SET last_indexed_at = time::now(), updated_at = time::now()`,
	);
	logger.debug("Updated repository last_indexed_at", { repositoryId });
}

/**
 * Update repository metadata including local_path, current_commit, and ref.
 *
 * @param repositoryId - Repository UUID
 * @param localPath - Local clone path
 * @param currentCommit - Current HEAD SHA
 * @param ref - Current branch/tag ref
 */
export async function updateRepositoryInfo(
	repositoryId: string,
	localPath: string,
	currentCommit: string,
	ref: string,
): Promise<void> {
	const db = await getDb();
	await db.query(
		`UPDATE ${rid("repo", repositoryId)} SET 
      local_path = $localPath,
      current_commit = $currentCommit,
      ref = $ref,
      last_indexed_at = time::now(),
      updated_at = time::now()`,
		{
			localPath,
			currentCommit,
			ref,
		},
	);
	logger.debug("Updated repository info", {
		repositoryId,
		localPath,
		currentCommit,
		ref,
	});
}

/**
 * Get repository ID from full_name.
 *
 * @param fullName - Repository full name
 * @returns Repository UUID or null if not found
 */
export async function getRepositoryIdByName(
	fullName: string,
): Promise<string | null> {
	const db = await getDb();
	const [rows] = await db.query<Array<Array<{ id: unknown }>>>(
		"SELECT id FROM repo WHERE full_name = $fullName LIMIT 1",
		{ fullName },
	);

	if (!rows || rows.length === 0 || rows[0] === undefined) return null;
	return extractId(rows[0].id);
}

// ============================================================================
// File operations
// ============================================================================

/**
 * Save indexed files to SurrealDB using UPSERT.
 *
 * @param files - Array of indexed files
 * @param repositoryId - Repository UUID
 * @returns Number of files saved
 */
export async function saveIndexedFiles(
	files: IndexedFile[],
	repositoryId: string,
): Promise<number> {
	if (files.length === 0) return 0;

	const db = await getDb();
	let count = 0;

	for (const file of files) {
		const language = detectLanguage(file.path);
		const sizeBytes = new TextEncoder().encode(file.content).length;
		const indexedAt = file.indexedAt ? file.indexedAt : new Date();
		const metadata = { dependencies: file.dependencies || [] };
		const normalizedFilePath = normalizePath(file.path);

		// Check if file already exists for this repo+path to preserve UUID
		// NOTE: Use ridParam() as a parameter to avoid SurrealDB 3.0 + SDK v2 bug
		// where mixing rid() string interpolation with $param binding returns empty results.
		const [existing] = await db.query<Array<Array<{ id: unknown }>>>(
			`SELECT id FROM file WHERE repo = $repoId AND path = $path LIMIT 1`,
			{ repoId: ridParam("repo", repositoryId), path: normalizedFilePath },
		);

		const fileId =
			existing && existing.length > 0 && existing[0] !== undefined
				? extractId(existing[0].id)
				: randomUUID();

		await db.query(
			`UPSERT ${rid("file", fileId)} SET
         repo         = ${rid("repo", repositoryId)},
         path         = $path,
         content      = $content,
         language     = $language,
         size_bytes   = $sizeBytes,
         content_hash = NONE,
         indexed_at   = $indexedAt,
         metadata     = $metadata`,
			{
				path: normalizedFilePath,
				content: file.content,
				language,
				sizeBytes,
				indexedAt,
				metadata,
			},
		);
		count++;
	}

	logger.info("Saved indexed files to SurrealDB", { count, repositoryId });
	return count;
}

/**
 * Resolve file path to file UUID.
 *
 * @param filePath - Relative file path to resolve
 * @param repositoryId - Repository UUID
 * @returns File UUID or null if not found
 */
export async function resolveFilePath(
	filePath: string,
	repositoryId: string,
): Promise<string | null> {
	const db = await getDb();
	// Use ridParam() to avoid SurrealDB 3.0 + SDK v2 bug with mixed interpolation + params.
	const [rows] = await db.query<Array<Array<{ id: unknown }>>>(
		`SELECT id FROM file WHERE repo = $repoId AND path = $path LIMIT 1`,
		{ repoId: ridParam("repo", repositoryId), path: normalizePath(filePath) },
	);

	if (!rows || rows.length === 0 || rows[0] === undefined) return null;
	return extractId(rows[0].id);
}

/**
 * Check if a repository has been indexed (has files in the file table).
 *
 * @param repositoryId - Repository UUID or full_name
 * @returns true if the repository has indexed files, false otherwise
 */
export async function isRepositoryIndexed(
	repositoryId: string,
): Promise<boolean> {
	const db = await getDb();

	const [byId] = await db.query<Array<Array<{ count: number }>>>(
		`SELECT count() AS count FROM file WHERE repo = ${rid("repo", repositoryId)} GROUP ALL`,
	);

	if (
		byId &&
		byId.length > 0 &&
		byId[0] !== undefined &&
		(byId[0].count ?? 0) > 0
	) {
		return true;
	}

	// Fall back to full_name lookup
	const repoId = await getRepositoryIdByName(repositoryId);
	if (!repoId) return false;

	const [byName] = await db.query<Array<Array<{ count: number }>>>(
		`SELECT count() AS count FROM file WHERE repo = ${rid("repo", repoId)} GROUP ALL`,
	);

	return !!(
		byName &&
		byName.length > 0 &&
		byName[0] !== undefined &&
		(byName[0].count ?? 0) > 0
	);
}

/**
 * Delete a single file from the index by path.
 *
 * @param repositoryId - Repository UUID
 * @param filePath - Relative file path to delete
 * @returns true if file was deleted, false if not found
 */
export async function deleteFileByPath(
	repositoryId: string,
	filePath: string,
): Promise<boolean> {
	const normalizedPath = normalizePath(filePath);
	const fileId = await resolveFilePath(normalizedPath, repositoryId);

	if (!fileId) {
		logger.debug("File not found for deletion", {
			repositoryId,
			filePath: normalizedPath,
		});
		return false;
	}

	const db = await getDb();

	// Delete the file and all graph edges where this file participates
	await db.query(
		`DELETE ${rid("file", fileId)};
     DELETE imports WHERE in = ${rid("file", fileId)} OR out = ${rid("file", fileId)};
     DELETE calls   WHERE in = ${rid("file", fileId)} OR out = ${rid("file", fileId)};
     DELETE symbol  WHERE file = ${rid("file", fileId)};`,
	);

	logger.info("Deleted file from index", {
		repositoryId,
		filePath: normalizedPath,
		fileId,
	});
	return true;
}

/**
 * Delete multiple files from the index by paths.
 *
 * @param repositoryId - Repository UUID
 * @param filePaths - Array of relative file paths to delete
 * @returns Object with deleted count and list of deleted paths
 */
export async function deleteFilesByPaths(
	repositoryId: string,
	filePaths: string[],
): Promise<{ deletedCount: number; deletedPaths: string[] }> {
	if (filePaths.length === 0) {
		return { deletedCount: 0, deletedPaths: [] };
	}

	const deletedPaths: string[] = [];
	for (const filePath of filePaths) {
		const deleted = await deleteFileByPath(repositoryId, filePath);
		if (deleted) {
			deletedPaths.push(normalizePath(filePath));
		}
	}

	logger.info("Deleted files from index", {
		repositoryId,
		requestedCount: filePaths.length,
		deletedCount: deletedPaths.length,
	});

	return { deletedCount: deletedPaths.length, deletedPaths };
}

// ============================================================================
// Search
// ============================================================================

/**
 * Search indexed files by content/path using SurrealDB BM25 full-text search.
 *
 * Uses the `file_fts` index defined in schema.surql which covers both
 * the `path` and `content` fields with the code_analyzer.
 *
 * @param term - Search term to match in file content or path
 * @param options - Search options (repositoryId filter, limit)
 * @returns Array of matching indexed files
 */
export async function searchFiles(
	term: string,
	options: SearchOptions = {},
): Promise<IndexedFile[]> {
	const db = await getDb();
	const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

	type FileRow = {
		id: unknown;
		repo: unknown;
		path: string;
		content: string;
		metadata: Record<string, unknown>;
		indexed_at: string;
	};

	let rows: FileRow[];

	// NOTE: In SurrealDB 3.0, use @@ operator (searches all FULLTEXT indexes on the field).
	// search::score() does not work with parameterized queries via the WebSocket SDK in v3.
	//
	// Multi-word queries: @@ uses AND semantics by default. For multi-word queries we
	// tokenize and run one search per token, then merge results (OR across tokens).
	const tokens = term.trim().split(/\s+/).filter(Boolean);

	if (tokens.length <= 1) {
		// Single token — use existing path
		if (options.repositoryId) {
			const [result] = await db.query<Array<FileRow[]>>(
				`SELECT *
       FROM file
       WHERE (content @@ $term OR path @@ $term)
         AND repo = $repoId
       LIMIT $limit`,
				{ term, limit, repoId: ridParam("repo", options.repositoryId) },
			);
			rows = result ?? [];
		} else {
			const [result] = await db.query<Array<FileRow[]>>(
				`SELECT *
       FROM file
       WHERE content @@ $term OR path @@ $term
       LIMIT $limit`,
				{ term, limit },
			);
			rows = result ?? [];
		}
	} else {
		// Multi-word: run per-token searches and merge by file id (OR semantics)
		const seen = new Map<string, FileRow>();
		for (const token of tokens) {
			let tokenRows: FileRow[];
			if (options.repositoryId) {
				const [result] = await db.query<Array<FileRow[]>>(
					`SELECT *
         FROM file
         WHERE (content @@ $term OR path @@ $term)
           AND repo = $repoId
         LIMIT $limit`,
					{ term: token, limit, repoId: ridParam("repo", options.repositoryId) },
				);
				tokenRows = result ?? [];
			} else {
				const [result] = await db.query<Array<FileRow[]>>(
					`SELECT *
         FROM file
         WHERE content @@ $term OR path @@ $term
         LIMIT $limit`,
					{ term: token, limit },
				);
				tokenRows = result ?? [];
			}
			for (const row of tokenRows) {
				const id = String(row.id);
				if (!seen.has(id)) seen.set(id, row);
			}
			if (seen.size >= limit) break;
		}
		rows = Array.from(seen.values()).slice(0, limit);
	}

	return rows.map((row) => ({
		id: extractId(row.id),
		projectRoot: extractId(row.repo),
		path: row.path,
		content: row.content,
		dependencies: (row.metadata?.dependencies as string[]) || [],
		indexedAt: new Date(row.indexed_at),
	}));
}

// ============================================================================
// Hybrid search (BM25 + HNSW vector, scores combined)
// ============================================================================

export interface HybridFileResult {
	id: string;
	projectRoot: string;
	path: string;
	content: string;
	dependencies: string[];
	indexedAt: Date;
	semanticScore: number;
	bm25Score: number;
	combinedScore: number;
}

/**
 * Hybrid search for files: combines HNSW vector similarity with BM25 full-text.
 *
 * Score combination: combined = 0.6 * semantic + 0.4 * bm25
 * Both searches run in parallel; results are merged by record ID, scored, and
 * returned sorted by combined score descending.
 *
 * Falls back to pure BM25 when Ollama is unavailable (semantic score = 0).
 *
 * @param query - Search query string
 * @param queryVector - Pre-computed 768-dim embedding for the query (or null)
 * @param options - Search options (repositoryId, limit)
 * @returns Array of file results sorted by combined score
 */
export async function hybridSearchFiles(
	query: string,
	queryVector: number[] | null,
	options: SearchOptions = {},
): Promise<HybridFileResult[]> {
	const db = await getDb();
	const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
	// Fetch more candidates per path so merging produces enough final results
	const candidateLimit = Math.min(limit * 3, 100);

	type FileRow = {
		id: unknown;
		repo: unknown;
		path: string;
		content: string;
		metadata: Record<string, unknown>;
		indexed_at: string;
	};

	// --- BM25 path (without search::score - SurrealDB 3.0 bug workaround) ---
	// --- BM25 path ---
	// Note: search::score() works with bound params in SurrealDB 3.0.4+
	let bm25Rows: Array<FileRow & { bm25_score: number }> = [];
	if (options.repositoryId) {
		const [result] = await db.query<
			Array<Array<FileRow & { bm25_score: number }>>
		>(
			`SELECT *, search::score(0) AS bm25_score
       FROM file
       WHERE (content @@ $query OR path @@ $query)
         AND repo = $repoId
       ORDER BY bm25_score DESC
       LIMIT $limit`,
			{
				query,
				limit: candidateLimit,
				repoId: ridParam("repo", options.repositoryId),
			},
		);
		bm25Rows = result ?? [];
	} else {
		const [result] = await db.query<
			Array<Array<FileRow & { bm25_score: number }>>
		>(
			`SELECT *, search::score(0) AS bm25_score
       FROM file
       WHERE content @@ $query OR path @@ $query
       ORDER BY bm25_score DESC
       LIMIT $limit`,
			{ query, limit: candidateLimit },
		);
		bm25Rows = result ?? [];
	}

	// --- HNSW vector path (only if embedding available) ---
	// Note: SurrealDB 3.0 has a bug where KNN operators fail with filter combinations
	// Workaround: run vector search without filters, filter in post-process
	let vectorRows: Array<FileRow & { semantic_score: number }> = [];
	if (queryVector !== null) {
		try {
			// Run without filters to avoid SurrealDB 3.0 KNN bug
			const [result] = await db.query<
				Array<Array<FileRow & { semantic_score: number }>>
			>(
				`SELECT *, vector::similarity::cosine(embedding, $vec) AS semantic_score
	         FROM file
	         WHERE embedding <|${candidateLimit}|> $vec
	         ORDER BY semantic_score DESC`,
				{ vec: queryVector },
			);
			vectorRows = result ?? [];
		} catch (vectorError) {
			// SurrealDB 3.0 KNN bug - fall back to BM25-only
			logger.warn("Vector search failed, falling back to BM25-only", {
				error:
					vectorError instanceof Error
						? vectorError.message
						: String(vectorError),
			});
			vectorRows = [];
		}
	}

	// --- Merge and score ---
	// Use native search::score() from SurrealDB 3.0.4+
	const maxBm25 =
		bm25Rows.reduce((m, r) => Math.max(m, r.bm25_score ?? 0), 0) || 1;
	const maxSemantic =
		vectorRows.reduce(
			(m, r) =>
				Math.max(
					m,
					((r as Record<string, unknown>).semantic_score as number) ?? 0,
				),
			0,
		) || 1;

	const merged = new Map<string, HybridFileResult>();

	for (const row of bm25Rows) {
		const id = extractId(row.id);
		merged.set(id, {
			id,
			projectRoot: extractId(row.repo),
			path: row.path,
			content: row.content,
			dependencies: (row.metadata?.dependencies as string[]) || [],
			indexedAt: new Date(row.indexed_at),
			semanticScore: 0,
			bm25Score: (row.bm25_score ?? 0) / maxBm25,
			combinedScore: 0,
		});
	}

	for (const row of vectorRows) {
		const id = extractId(row.id);
		const normSemantic = (row.semantic_score ?? 0) / maxSemantic;
		const existing = merged.get(id);
		if (existing) {
			existing.semanticScore = normSemantic;
		} else {
			merged.set(id, {
				id,
				projectRoot: extractId(row.repo),
				path: row.path,
				content: row.content,
				dependencies: (row.metadata?.dependencies as string[]) || [],
				indexedAt: new Date(row.indexed_at),
				semanticScore: normSemantic,
				bm25Score: 0,
				combinedScore: 0,
			});
		}
	}

	// Compute combined scores and sort
	let results = Array.from(merged.values())
		.map((r) => ({
			...r,
			combinedScore: 0.6 * r.semanticScore + 0.4 * r.bm25Score,
		}))
		.sort((a, b) => b.combinedScore - a.combinedScore)
		.slice(0, limit);

	// Post-process filter by repository (workaround for SurrealDB 3.0 KNN bug)
	if (options.repositoryId) {
		results = results.filter((r) => r.projectRoot === options.repositoryId);
	}

	return results;
}

export interface HybridSymbolResult {
	id: string;
	name: string;
	kind: string;
	signature: string | null;
	documentation: string | null;
	filePath: string;
	lineStart: number;
	lineEnd: number;
	repositoryId: string;
	isExported: boolean;
	semanticScore: number;
	bm25Score: number;
	combinedScore: number;
}

/**
 * Hybrid search for symbols: combines HNSW vector similarity with BM25 full-text.
 *
 * Score combination: combined = 0.6 * semantic + 0.4 * bm25
 * Searches name, signature, and documentation fields.
 * Falls back to pure BM25 when no query vector is available.
 *
 * @param query - Search query string
 * @param queryVector - Pre-computed 768-dim embedding for the query (or null)
 * @param options - Search options (repositoryId, limit, symbolKinds, exportedOnly)
 * @returns Array of symbol results sorted by combined score
 */
export async function hybridSearchSymbols(
	query: string,
	queryVector: number[] | null,
	options: SearchOptions & {
		symbolKinds?: string[];
		exportedOnly?: boolean;
	} = {},
): Promise<HybridSymbolResult[]> {
	const db = await getDb();
	const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
	const candidateLimit = Math.min(limit * 3, 100);

	type SymbolRow = {
		id: unknown;
		name: string;
		kind: string;
		signature: string | null;
		documentation: string | null;
		line_start: number;
		line_end: number;
		metadata: Record<string, unknown>;
		file_path: string;
		repo: unknown;
	};

	// Build common filter conditions (shared by both BM25 and vector paths)
	const filterConditions: string[] = [];
	const filterParams: Record<string, unknown> = {
		query,
		limit: candidateLimit,
	};

	if (options.symbolKinds && options.symbolKinds.length > 0) {
		filterConditions.push("kind IN $symbolKinds");
		filterParams.symbolKinds = options.symbolKinds;
	}
	if (options.exportedOnly) {
		filterConditions.push("metadata.is_exported = true");
	}
	// NOTE: repo filter is NOT applied to the BM25 query — SurrealDB 3.0 has a bug where
	// mixing @@ (BM25) with non-FTS AND conditions returns empty results.
	// Repo filtering is done post-query in application code.
	if (options.repositoryId) {
		// kept for non-BM25 paths (symbolKinds, exportedOnly still go in filterSuffix)
	}

	const filterSuffix =
		filterConditions.length > 0 ? ` AND ${filterConditions.join(" AND ")}` : "";

	// --- BM25 path ---
	// search::score() works with bound params in SurrealDB 3.0.4+
	// Repo filter intentionally omitted — applied in post-process (SurrealDB 3.0 bug)
	const bm25Query = `SELECT id, name, kind, signature, documentation, line_start, line_end, metadata, file.path AS file_path, repo,
         search::score(0) AS bm25_score
         FROM symbol
         WHERE (name @@ $query OR signature @@ $query OR documentation @@ $query)${filterSuffix}
         ORDER BY bm25_score DESC
         LIMIT $limit`;

	const [bm25Result] = await db.query<
		Array<Array<SymbolRow & { bm25_score: number }>>
	>(bm25Query, filterParams);
	const bm25RowsRaw = bm25Result ?? [];
	// Post-filter by repo (workaround for SurrealDB 3.0 BM25 + AND filter bug)
	const bm25Rows = options.repositoryId
		? bm25RowsRaw.filter(r => extractId(r.repo) === options.repositoryId)
		: bm25RowsRaw;

	// --- HNSW vector path ---
	// Note: SurrealDB 3.0 has a bug where KNN operators fail with certain filter combinations
	// Fall back to BM25-only if vector search fails
	let vectorRows: Array<SymbolRow & { semantic_score: number }> = [];
	if (queryVector !== null) {
		try {
			const vectorParams: Record<string, unknown> = {
				vec: queryVector,
				limit: candidateLimit,
			};
			if (options.symbolKinds && options.symbolKinds.length > 0) {
				vectorParams.symbolKinds = options.symbolKinds;
			}
			if (options.repositoryId) {
				vectorParams.repoId = ridParam("repo", options.repositoryId);
			}

			// Note: SurrealDB 3.0 has a bug where KNN operators fail with filter combinations
			// Run without filters, filter in post-process
			const vectorQuery = `SELECT id, name, kind, signature, documentation, line_start, line_end, metadata, file.path AS file_path, repo,
           vector::similarity::cosine(embedding, $vec) AS semantic_score
           FROM symbol
           WHERE embedding <|${candidateLimit}|> $vec
           ORDER BY semantic_score DESC`;

			const [vectorResult] = await db.query<
				Array<Array<SymbolRow & { semantic_score: number }>>
			>(vectorQuery, vectorParams);
			vectorRows = vectorResult ?? [];
		} catch (vectorError) {
			// SurrealDB 3.0 KNN bug - fall back to BM25-only
			logger.warn("Vector search failed, falling back to BM25-only", {
				error:
					vectorError instanceof Error
						? vectorError.message
						: String(vectorError),
			});
			vectorRows = [];
		}
	}

	// --- Merge and score ---
	// Use native search::score() from SurrealDB 3.0.4+
	const maxBm25 =
		bm25Rows.reduce((m, r) => Math.max(m, r.bm25_score ?? 0), 0) || 1;
	const maxSemantic =
		vectorRows.reduce(
			(m, r) =>
				Math.max(
					m,
					((r as Record<string, unknown>).semantic_score as number) ?? 0,
				),
			0,
		) || 1;

	const merged = new Map<string, HybridSymbolResult>();

	const rowToBase = (
		row: SymbolRow,
	): Omit<
		HybridSymbolResult,
		"semanticScore" | "bm25Score" | "combinedScore"
	> => ({
		id: extractId(row.id),
		name: row.name,
		kind: row.kind,
		signature: row.signature,
		documentation: row.documentation,
		filePath: row.file_path,
		lineStart: row.line_start,
		lineEnd: row.line_end,
		repositoryId: extractId(row.repo),
		isExported: (row.metadata?.is_exported as boolean) || false,
	});

	for (const row of bm25Rows) {
		const base = rowToBase(row);
		merged.set(base.id, {
			...base,
			semanticScore: 0,
			bm25Score: (row.bm25_score ?? 0) / maxBm25,
			combinedScore: 0,
		});
	}

	for (const row of vectorRows) {
		const base = rowToBase(row);
		const normSemantic = (row.semantic_score ?? 0) / maxSemantic;
		const existing = merged.get(base.id);
		if (existing) {
			existing.semanticScore = normSemantic;
		} else {
			merged.set(base.id, {
				...base,
				semanticScore: normSemantic,
				bm25Score: 0,
				combinedScore: 0,
			});
		}
	}

	let results = Array.from(merged.values())
		.map((r) => ({
			...r,
			combinedScore: 0.6 * r.semanticScore + 0.4 * r.bm25Score,
		}))
		.sort((a, b) => b.combinedScore - a.combinedScore)
		.slice(0, limit);

	// Post-process filter by repository (workaround for SurrealDB 3.0 KNN bug)
	if (options.repositoryId) {
		results = results.filter((r) => r.repositoryId === options.repositoryId);
	}

	return results;
}

/**
 * BM25-only symbol search for exact or partial symbol name lookups.
 *
 * No embedding required — faster than hybrid search and better suited
 * for cases where the caller knows the symbol name or a substring of it.
 * The code_search analyzer (camel + blank tokenizers) splits camelCase so
 * that a query "getUserById" or "getUser" both find the right symbol.
 *
 * @param query - Symbol name or partial name
 * @param options - Search options (repositoryId, limit, symbolKinds, exportedOnly)
 * @returns Array of matching symbols sorted by BM25 score
 */
export async function searchSymbolExact(
	query: string,
	options: SearchOptions & {
		symbolKinds?: string[];
		exportedOnly?: boolean;
	} = {},
): Promise<HybridSymbolResult[]> {
	const db = await getDb();
	const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);

	const conditions: string[] = [
		"name @@ $query OR signature @@ $query OR documentation @@ $query",
	];
	const params: Record<string, unknown> = { query, limit };

	if (options.symbolKinds && options.symbolKinds.length > 0) {
		conditions.push("kind IN $symbolKinds");
		params.symbolKinds = options.symbolKinds;
	}
	if (options.exportedOnly) {
		conditions.push("metadata.is_exported = true");
	}
	// NOTE: repo filter omitted from BM25 WHERE clause - SurrealDB 3.0 bug.
	// Applied post-query below.

	const whereClause = conditions.join(" AND ");

	// Use native search::score() - works in SurrealDB 3.0.4+
	const [rows] = await db.query<
		Array<
			Array<{
				id: unknown;
				name: string;
				kind: string;
				signature: string | null;
				documentation: string | null;
				line_start: number;
				line_end: number;
				metadata: Record<string, unknown>;
				file_path: string;
				repo: unknown;
				bm25_score: number;
			}>
		>
	>(
		`SELECT id, name, kind, signature, documentation, line_start, line_end, metadata,
            file.path AS file_path, repo, search::score(0) AS bm25_score
     FROM symbol
     WHERE ${whereClause}
     ORDER BY bm25_score DESC
     LIMIT $limit`,
		params,
	);

	const maxBm25 =
		(rows ?? []).reduce((m, r) => Math.max(m, r.bm25_score ?? 0), 0) || 1;

	return (rows ?? []).map((row) => ({
		id: extractId(row.id),
		name: row.name,
		kind: row.kind,
		signature: row.signature,
		documentation: row.documentation,
		filePath: row.file_path,
		lineStart: row.line_start,
		lineEnd: row.line_end,
		repositoryId: extractId(row.repo),
		isExported: (row.metadata?.is_exported as boolean) || false,
		semanticScore: 0,
		bm25Score: (row.bm25_score ?? 0) / maxBm25,
		combinedScore: (row.bm25_score ?? 0) / maxBm25,
	})).filter(r => !options.repositoryId || r.repositoryId === options.repositoryId);
}

/**
 * List recently indexed files.
 *
 * @param limit - Maximum number of files to return
 * @param repositoryId - Optional repository filter
 * @returns Array of recently indexed files
 */
export async function listRecentFiles(
	limit: number,
	repositoryId?: string,
): Promise<IndexedFile[]> {
	const db = await getDb();

	type FileRow = {
		id: unknown;
		repo: unknown;
		path: string;
		content: string;
		metadata: Record<string, unknown>;
		indexed_at: string;
	};

	let rows: FileRow[];

	if (repositoryId) {
		const [result] = await db.query<Array<FileRow[]>>(
			`SELECT id, repo, path, content, metadata, indexed_at
       FROM file
       WHERE repo = ${rid("repo", repositoryId)}
       ORDER BY indexed_at DESC
       LIMIT $limit`,
			{ limit },
		);
		rows = result ?? [];
	} else {
		const [result] = await db.query<Array<FileRow[]>>(
			`SELECT id, repo, path, content, metadata, indexed_at
       FROM file
       ORDER BY indexed_at DESC
       LIMIT $limit`,
			{ limit },
		);
		rows = result ?? [];
	}

	return rows.map((row) => ({
		id: extractId(row.id),
		projectRoot: extractId(row.repo),
		path: row.path,
		content: row.content,
		dependencies: (row.metadata?.dependencies as string[]) || [],
		indexedAt: new Date(row.indexed_at),
	}));
}

// ============================================================================
// Dependency graph traversal
// ============================================================================

export interface DependencyResult {
	direct: string[];
	indirect: Record<string, string[]>;
	cycles: string[][];
}

/**
 * Query files that depend on the given file (reverse lookup).
 *
 * Uses SurrealDB `imports` graph edge table with backward traversal.
 * `<-imports<-file` follows edges backward: which files import this file?
 *
 * @param fileId - Target file UUID
 * @param depth - Recursion depth (1-5, clamped)
 * @param includeTests - Whether to include test files
 * @param referenceTypes - Edge reference types to follow
 * @returns Dependency result with direct/indirect relationships and cycles
 */
export async function queryDependents(
	fileId: string,
	depth: number,
	includeTests: boolean,
	referenceTypes: string[] = ["import", "re_export", "export_all"],
): Promise<DependencyResult> {
	const db = await getDb();
	const clampedDepth = Math.min(Math.max(depth, 1), 5);

	// Validate file exists and get its path
	const [fileRows] = await db.query<Array<Array<{ path: string }>>>(
		`SELECT path FROM ${rid("file", fileId)} LIMIT 1`,
	);

	if (!fileRows || fileRows.length === 0 || fileRows[0] === undefined) {
		throw new Error(`File not found: ${fileId}`);
	}

	const targetPath = fileRows[0].path;
	const directPaths: string[] = [];
	const indirect: Record<string, string[]> = {};
	const visited = new Set<string>([fileId]);
	const cycles: string[][] = [];

	let frontier = [fileId];

	for (let level = 1; level <= clampedDepth; level++) {
		if (frontier.length === 0) break;

		// Traverse one hop backward: who imports files in frontier?
		const [hopRows] = await db.query<
			Array<
				Array<{
					depId: unknown;
					depPath: string;
					referenceType: string;
				}>
			>
		>(
			`SELECT
         in.id   AS depId,
         in.path AS depPath,
         reference_type AS referenceType
       FROM imports
       WHERE out IN $frontierIds
         AND reference_type IN $refTypes`,
			{
				frontierIds: frontier.map((id) => rid("file", id)),
				refTypes: referenceTypes,
			},
		);

		const nextFrontier: string[] = [];

		for (const hop of hopRows ?? []) {
			const rawDepId = extractId(hop.depId);
			const depPath = hop.depPath;

			if (
				!includeTests &&
				(depPath.includes("test") || depPath.includes("spec"))
			) {
				continue;
			}

			if (visited.has(rawDepId)) {
				cycles.push([depPath, targetPath]);
				continue;
			}

			visited.add(rawDepId);
			nextFrontier.push(rawDepId);

			if (level === 1) {
				if (!directPaths.includes(depPath)) {
					directPaths.push(depPath);
				}
			} else {
				const key = `depth_${level}`;
				if (!indirect[key]) indirect[key] = [];
				if (!indirect[key].includes(depPath)) {
					indirect[key].push(depPath);
				}
			}
		}

		frontier = nextFrontier;
	}

	return { direct: directPaths, indirect, cycles };
}

/**
 * Query files that the given file depends on (forward lookup).
 *
 * Uses SurrealDB `imports` graph edge table with forward traversal.
 * `->imports->file` follows edges forward: what does this file import?
 *
 * @param fileId - Source file UUID
 * @param depth - Recursion depth (1-5, clamped)
 * @param referenceTypes - Edge reference types to follow
 * @returns Dependency result with direct/indirect relationships and cycles
 */
export async function queryDependencies(
	fileId: string,
	depth: number,
	referenceTypes: string[] = ["import", "re_export", "export_all"],
): Promise<DependencyResult> {
	const db = await getDb();
	const clampedDepth = Math.min(Math.max(depth, 1), 5);

	const [fileRows] = await db.query<Array<Array<{ path: string }>>>(
		`SELECT path FROM ${rid("file", fileId)} LIMIT 1`,
	);

	if (!fileRows || fileRows.length === 0 || fileRows[0] === undefined) {
		throw new Error(`File not found: ${fileId}`);
	}

	const sourcePath = fileRows[0].path;
	const directPaths: string[] = [];
	const indirect: Record<string, string[]> = {};
	const visited = new Set<string>([fileId]);
	const cycles: string[][] = [];

	let frontier = [fileId];

	for (let level = 1; level <= clampedDepth; level++) {
		if (frontier.length === 0) break;

		// Traverse one hop forward: what does each file in frontier import?
		const [hopRows] = await db.query<
			Array<
				Array<{
					depId: unknown;
					depPath: string;
					referenceType: string;
				}>
			>
		>(
			`SELECT
         out.id   AS depId,
         out.path AS depPath,
         reference_type AS referenceType
       FROM imports
       WHERE in IN $frontierIds
         AND reference_type IN $refTypes`,
			{
				frontierIds: frontier.map((id) => rid("file", id)),
				refTypes: referenceTypes,
			},
		);

		const nextFrontier: string[] = [];

		for (const hop of hopRows ?? []) {
			const rawDepId = extractId(hop.depId);
			const depPath = hop.depPath;

			if (visited.has(rawDepId)) {
				cycles.push([sourcePath, depPath]);
				continue;
			}

			visited.add(rawDepId);
			nextFrontier.push(rawDepId);

			if (level === 1) {
				if (!directPaths.includes(depPath)) {
					directPaths.push(depPath);
				}
			} else {
				const key = `depth_${level}`;
				if (!indirect[key]) indirect[key] = [];
				if (!indirect[key].includes(depPath)) {
					indirect[key].push(depPath);
				}
			}
		}

		frontier = nextFrontier;
	}

	return { direct: directPaths, indirect, cycles };
}

// ============================================================================
// Symbol operations
// ============================================================================

/**
 * Store symbols extracted from AST into SurrealDB.
 *
 * @param symbols - Array of extracted symbols
 * @param fileId - UUID of the indexed file
 * @returns Number of symbols stored
 */
export async function storeSymbols(
	symbols: ExtractedSymbol[],
	fileId: string,
): Promise<number> {
	if (symbols.length === 0) return 0;

	const db = await getDb();

	// Get repo from file
	const [fileRows] = await db.query<Array<Array<{ repo: unknown }>>>(
		`SELECT repo FROM ${rid("file", fileId)} LIMIT 1`,
	);

	if (!fileRows || fileRows.length === 0 || fileRows[0] === undefined) {
		throw new Error(`File not found: ${fileId}`);
	}

	const repoId = extractId(fileRows[0].repo);
	let count = 0;

	for (const symbol of symbols) {
		const id = randomUUID();
		const metadata = {
			column_start: symbol.columnStart,
			column_end: symbol.columnEnd,
			is_exported: symbol.isExported,
			is_async: symbol.isAsync,
			access_modifier: symbol.accessModifier,
		};

		await db.query(
			`UPSERT ${rid("symbol", id)} SET
         file          = ${rid("file", fileId)},
         repo          = ${rid("repo", repoId)},
         name          = $name,
         kind          = $kind,
         line_start    = $lineStart,
         line_end      = $lineEnd,
         signature     = $signature,
         documentation = $documentation,
         metadata      = $metadata,
         created_at    = time::now()`,
			{
				name: symbol.name,
				kind: symbol.kind,
				lineStart: symbol.lineStart,
				lineEnd: symbol.lineEnd,
				signature: symbol.signature ?? undefined,
				documentation: symbol.documentation ?? undefined,
				metadata,
			},
		);
		count++;
	}

	logger.info("Stored symbols to SurrealDB", { count, fileId });
	return count;
}

export interface FindUsagesOptions {
	symbolName: string;
	filePath?: string;
	repositoryId: string;
	includeDefinitions?: boolean;
	includeTests?: boolean;
}

export interface SymbolUsage {
	file: string;
	line: number;
	column: number;
	usage_type: string;
	context: string;
}

export interface FindUsagesResult {
	symbol: string;
	defined_in: string;
	kind: string;
	usages: SymbolUsage[];
	total_usages: number;
	files_with_usages: number;
}

const REFERENCE_TYPE_MAP: Record<string, string> = {
	import: "import",
	call: "call",
	re_export: "re_export",
	export_all: "re_export",
	type_reference: "type_reference",
	extends: "type_reference",
	implements: "type_reference",
	property_access: "property_access",
	variable_reference: "variable_reference",
	dynamic_import: "import",
};

/**
 * Find all usages of a named symbol across the indexed codebase.
 *
 * Looks up the symbol definition in the symbol table, then finds all
 * callers via the `calls` graph edge (out = the symbol being called).
 *
 * @param options - Search options including symbolName and repositoryId
 * @returns Result with definition location, usage list, and counts
 */
export async function findSymbolUsages(
	options: FindUsagesOptions,
): Promise<FindUsagesResult> {
	const db = await getDb();
	const {
		symbolName,
		filePath,
		repositoryId,
		includeDefinitions = false,
		includeTests = true,
	} = options;

	// Step 1: Find the symbol definition
	type SymbolRow = {
		id: unknown;
		name: string;
		kind: string;
		line_start: number;
		line_end: number;
		file_path: string;
	};

	let symbolRows: SymbolRow[];

	if (filePath) {
		const [result] = await db.query<Array<SymbolRow[]>>(
			`SELECT s.id, s.name, s.kind, s.line_start, s.line_end, f.path AS file_path
       FROM symbol AS s, file AS f
       WHERE s.file = f.id
         AND s.name = $symbolName
         AND s.repo = ${rid("repo", repositoryId)}
         AND f.path = $filePath
       LIMIT 1`,
			{ symbolName, filePath },
		);
		symbolRows = result ?? [];
	} else {
		const [result] = await db.query<Array<SymbolRow[]>>(
			`SELECT s.id, s.name, s.kind, s.line_start, s.line_end, f.path AS file_path
       FROM symbol AS s, file AS f
       WHERE s.file = f.id
         AND s.name = $symbolName
         AND s.repo = ${rid("repo", repositoryId)}
       LIMIT 1`,
			{ symbolName },
		);
		symbolRows = result ?? [];
	}

	if (!symbolRows || symbolRows.length === 0 || symbolRows[0] === undefined) {
		logger.debug("Symbol not found for find_usages", {
			symbolName,
			repositoryId,
			filePath,
		});
		return {
			symbol: symbolName,
			defined_in: "unknown",
			kind: "unknown",
			usages: [],
			total_usages: 0,
			files_with_usages: 0,
		};
	}

	const symbolRow = symbolRows[0];
	const rawSymbolId = extractId(symbolRow.id);
	const definedIn = `${symbolRow.file_path}:${symbolRow.line_start}`;

	// Step 2: Find all callers of this symbol via the `calls` graph edge
	type CallRow = {
		callerFilePath: string;
		callerFileContent: string;
		lineNumber: number;
		columnNumber: number;
		referenceType: string;
	};

	const [callRows] = await db.query<Array<CallRow[]>>(
		`SELECT
       in.path    AS callerFilePath,
       in.content AS callerFileContent,
       line_number    AS lineNumber,
       column_number  AS columnNumber,
       reference_type AS referenceType
     FROM calls
     WHERE out = ${rid("symbol", rawSymbolId)}
     ORDER BY callerFilePath, lineNumber`,
	);

	// Step 3: Process results
	const usages: SymbolUsage[] = [];
	const filesWithUsages = new Set<string>();

	for (const ref of callRows ?? []) {
		if (
			!includeTests &&
			(ref.callerFilePath.includes("test") ||
				ref.callerFilePath.includes("spec") ||
				ref.callerFilePath.includes("__tests__"))
		) {
			continue;
		}

		if (
			!includeDefinitions &&
			ref.callerFilePath === symbolRow.file_path &&
			ref.lineNumber >= symbolRow.line_start &&
			ref.lineNumber <= symbolRow.line_end
		) {
			continue;
		}

		const lines = ref.callerFileContent.split("\n");
		const lineIndex = ref.lineNumber - 1;
		const context =
			lineIndex >= 0 && lineIndex < lines.length
				? (lines[lineIndex] ?? "").trim()
				: "";

		const usageType =
			REFERENCE_TYPE_MAP[ref.referenceType] || ref.referenceType;

		usages.push({
			file: ref.callerFilePath,
			line: ref.lineNumber,
			column: ref.columnNumber,
			usage_type: usageType,
			context,
		});

		filesWithUsages.add(ref.callerFilePath);
	}

	return {
		symbol: symbolRow.name,
		defined_in: definedIn,
		kind: symbolRow.kind,
		usages,
		total_usages: usages.length,
		files_with_usages: filesWithUsages.size,
	};
}

// ============================================================================
// References (graph edges)
// ============================================================================

/**
 * Store references extracted from AST as graph edges in SurrealDB.
 *
 * Import-type references become `imports` edges (file -> file).
 * Call/property/type references become `calls` edges (file -> symbol or file -> file).
 * Extends/implements references become `extends` edges.
 *
 * @param fileId - UUID of the source file
 * @param filePath - Relative path of the source file
 * @param references - Array of extracted references
 * @param allFiles - All indexed files (for path alias resolution)
 * @param pathMappings - TypeScript path alias mappings
 * @param repoRoot - Repository root path
 * @returns Number of references stored
 */
export async function storeReferences(
	fileId: string,
	filePath: string,
	references: Reference[],
	allFiles: Array<{ path: string }>,
	pathMappings?: PathMappings | null,
	repoRoot?: string,
): Promise<number> {
	if (references.length === 0) return 0;

	const db = await getDb();

	// Get repo for this file (needed for resolveFilePath calls)
	const [fileRows] = await db.query<Array<Array<{ repo: unknown }>>>(
		`SELECT repo FROM ${rid("file", fileId)} LIMIT 1`,
	);
	if (!fileRows || fileRows.length === 0 || fileRows[0] === undefined) {
		throw new Error(`File not found: ${fileId}`);
	}
	const repositoryId = extractId(fileRows[0].repo);

	// Remove existing edges from this source file before re-inserting
	await db.query(
		`DELETE imports WHERE in = ${rid("file", fileId)};
     DELETE calls   WHERE in = ${rid("file", fileId)};
     DELETE extends WHERE in = ${rid("file", fileId)};`,
	);

	let count = 0;

	for (const ref of references) {
		const edgeId = randomUUID();
		const metadata = {
			target_name: ref.targetName,
			column_number: ref.columnNumber,
			...ref.metadata,
		};

		if (
			ref.referenceType === "import" ||
			ref.referenceType === "re_export" ||
			ref.referenceType === "export_all" ||
			ref.referenceType === "dynamic_import"
		) {
			// Resolve target file and create an imports edge
			let targetFileId: string | null = null;
			if (ref.metadata?.importSource) {
				const resolved = resolveImport(
					ref.metadata.importSource,
					filePath,
					allFiles,
					pathMappings,
					repoRoot,
				);
				if (resolved) {
					targetFileId = await resolveFilePath(
						normalizePath(resolved),
						repositoryId,
					);
				}
			}

			if (targetFileId) {
				await db.query(
					`RELATE ${rid("file", fileId)} -> imports -> ${rid("file", targetFileId)}
           CONTENT {
             id: $edgeId,
             reference_type: $refType,
             line_number: $lineNum,
             column_number: $colNum,
             metadata: $metadata
           }`,
					{
						edgeId,
						refType: ref.referenceType,
						lineNum: ref.lineNumber,
						colNum: ref.columnNumber ?? 0,
						metadata,
					},
				);
				count++;
			}
		} else if (
			(ref.referenceType as string) === "extends" ||
			(ref.referenceType as string) === "implements"
		) {
			// Extend/implements edges are self-referential on the file level
			// (symbol-to-symbol resolution would require symbol UUID lookup)
			await db.query(
				`RELATE ${rid("file", fileId)} -> extends -> ${rid("file", fileId)}
         CONTENT {
           id: $edgeId,
           reference_type: $refType,
           line_number: $lineNum,
           column_number: $colNum,
           metadata: $metadata
         }`,
				{
					edgeId,
					refType: ref.referenceType,
					lineNum: ref.lineNumber,
					colNum: ref.columnNumber ?? 0,
					metadata,
				},
			);
			count++;
		} else {
			// call, property_access, type_reference, variable_reference
			await db.query(
				`RELATE ${rid("file", fileId)} -> calls -> ${rid("file", fileId)}
         CONTENT {
           id: $edgeId,
           reference_type: $refType,
           line_number: $lineNum,
           column_number: $colNum,
           metadata: $metadata
         }`,
				{
					edgeId,
					refType: ref.referenceType,
					lineNum: ref.lineNumber,
					colNum: ref.columnNumber ?? 0,
					metadata,
				},
			);
			count++;
		}
	}

	logger.info("Stored references to SurrealDB", { count, fileId });
	return count;
}

// ============================================================================
// Statistics
// ============================================================================

/**
 * Get index statistics for startup context display.
 *
 * @returns Statistics object with counts by type
 */
export async function getIndexStatistics(): Promise<{
	files: number;
	symbols: number;
	references: number;
	decisions: number;
	patterns: number;
	failures: number;
	repositories: number;
}> {
	const db = await getDb();

	const safeCount = async (table: string): Promise<number> => {
		try {
			const [rows] = await db.query<Array<Array<{ count: number }>>>(
				`SELECT count() AS count FROM ${table} GROUP ALL`,
			);
			return rows?.[0]?.count ?? 0;
		} catch {
			return 0;
		}
	};

	const [files, symbols, decisions, patterns, failures, repositories] =
		await Promise.all([
			safeCount("file"),
			safeCount("symbol"),
			safeCount("decision"),
			safeCount("pattern"),
			safeCount("failure"),
			safeCount("repo"),
		]);

	// Sum graph edge tables as "references"
	const references = await (async () => {
		try {
			const [ic] = await db.query<Array<Array<{ count: number }>>>(
				"SELECT count() AS count FROM imports GROUP ALL",
			);
			const [cc] = await db.query<Array<Array<{ count: number }>>>(
				"SELECT count() AS count FROM calls GROUP ALL",
			);
			return (ic?.[0]?.count ?? 0) + (cc?.[0]?.count ?? 0);
		} catch {
			return 0;
		}
	})();

	return {
		files,
		symbols,
		references,
		decisions,
		patterns,
		failures,
		repositories,
	};
}

// ============================================================================
// Indexing workflow
// ============================================================================

/**
 * Run indexing workflow for local mode (async, SurrealDB-backed).
 *
 * @param request - Index request with repository details
 * @returns Indexing result with stats
 */
export async function runIndexingWorkflow(request: IndexRequest): Promise<{
	repositoryId: string;
	filesIndexed: number;
	symbolsExtracted: number;
	referencesExtracted: number;
}> {
	const { existsSync, statSync } = await import("node:fs");
	const { resolve, isAbsolute, normalize } = await import("node:path");
	const { prepareRepository, currentRevision } = await import("@indexer/repos");
	const { resolveLocalPath, isInCloneStore, cloneRepository } = await import(
		"@indexer/clone-store"
	);
	const { discoverSources, parseSourceFile } = await import("@indexer/parsers");
	const { parseFileWithRecovery, isSupportedForAST } = await import(
		"@indexer/ast-parser"
	);
	const { extractSymbols } = await import("@indexer/symbol-extractor");
	const { extractReferences } = await import("@indexer/reference-extractor");
	const { parseTsConfig } = await import("@indexer/path-resolver");
	const { extractPhpSymbols } = await import("@indexer/php-extractor");
	const { extractZigSymbols } = await import("@indexer/zig-extractor");

	let localPath: string;
	let fullName = request.repository;
	let didAutoClone = false;

	if (request.localPath) {
		localPath = resolve(request.localPath);

		// Validation: Path must be absolute
		if (!isAbsolute(localPath)) {
			throw new Error(`Path must be absolute: ${localPath}`);
		}
		// Security: No path traversal — resolve and normalize must agree
		if (normalize(localPath) !== localPath) {
			throw new Error(`Path contains traversal characters: ${localPath}`);
		}
		if (!fullName.includes("/")) {
			fullName = `local/${fullName}`;
		}
	} else {
		// Try to resolve from clone store first
		if (isInCloneStore(fullName)) {
			localPath = resolveLocalPath(fullName);
			logger.info("Resolved repository from clone store", {
				fullName,
				localPath,
			});
		} else {
			// Auto-clone from GitHub
			logger.info("Repository not in clone store, auto-cloning from GitHub", {
				fullName,
			});
			localPath = await cloneRepository(fullName, request.ref);
			didAutoClone = true;
		}
	}

	if (!existsSync(localPath)) {
		throw new Error(`Repository path does not exist: ${localPath}`);
	}
	if (!statSync(localPath).isDirectory()) {
		throw new Error(`Path must be a directory: ${localPath}`);
	}

	// Get current commit SHA
	let currentCommit: string;
	try {
		currentCommit = await currentRevision(localPath);
	} catch {
		currentCommit = "unknown";
		logger.warn("Could not get current commit, using 'unknown'", { localPath });
	}

	const gitUrl = request.localPath
		? localPath
		: `https://github.com/${fullName}.git`;
	const repositoryId = await ensureRepository(
		fullName,
		gitUrl,
		request.ref,
		localPath,
		currentCommit,
		request.ref,
	);

	logger.info("Starting local indexing workflow", {
		repositoryId,
		fullName,
		localPath,
	});

	// Parse tsconfig.json for path alias resolution
	const pathMappings = parseTsConfig(localPath);
	if (pathMappings) {
		logger.info("Loaded path mappings from tsconfig.json", {
			aliasCount: Object.keys(pathMappings.paths).length,
			baseUrl: pathMappings.baseUrl,
		});
	}

	const sources = await discoverSources(localPath);
	const records = (
		await Promise.all(
			sources.map((source) => parseSourceFile(source, localPath)),
		)
	).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

	const filesIndexed = await saveIndexedFiles(records, repositoryId);

	// Query ALL indexed files for complete import resolution
	const db = await getDb();
	const [allIndexedRows] = await db.query<
		Array<Array<{ id: unknown; path: string }>>
	>(`SELECT id, path FROM file WHERE repo = ${rid("repo", repositoryId)}`);

	const allIndexedFiles = (allIndexedRows ?? []).map((row) => ({
		id: extractId(row.id),
		path: row.path,
	}));

	logger.debug("Queried all indexed files for path alias resolution", {
		count: allIndexedFiles.length,
		repositoryId,
	});

	let totalSymbols = 0;
	let totalReferences = 0;

	interface FileWithReferences {
		fileId: string;
		filePath: string;
		references: Reference[];
	}
	const filesWithReferences: FileWithReferences[] = [];

	for (const file of records) {
		const isPhp = file.path.endsWith(".php");
		const isZig = file.path.endsWith(".zig");

		if (!isSupportedForAST(file.path) && !isPhp && !isZig) continue;

		let symbols: Awaited<ReturnType<typeof extractSymbols>>;
		let references: Awaited<ReturnType<typeof extractReferences>> = [];

		if (isPhp) {
			symbols = extractPhpSymbols(file.content, file.path);
		} else if (isZig) {
			symbols = extractZigSymbols(file.content, file.path);
		} else {
			const parseResult = parseFileWithRecovery(file.path, file.content);
			if (!parseResult.ast) continue;
			symbols = extractSymbols(parseResult.ast!, file.path);
			references = extractReferences(parseResult.ast!, file.path);
		}

		const fileId = await resolveFilePath(file.path, repositoryId);
		if (!fileId) {
			logger.warn("Could not find file record after indexing", {
				filePath: file.path,
				repositoryId,
			});
			continue;
		}

		const symbolCount = await storeSymbols(symbols, fileId);
		totalSymbols += symbolCount;

		if (references.length > 0) {
			filesWithReferences.push({
				fileId,
				filePath: file.path,
				references,
			});
		}
	}

	for (const fileWithRefs of filesWithReferences) {
		const referenceCount = await storeReferences(
			fileWithRefs.fileId,
			fileWithRefs.filePath,
			fileWithRefs.references,
			allIndexedFiles,
			pathMappings,
			localPath,
		);
		totalReferences += referenceCount;
	}

	const graphReferences: GraphReferenceData[] = [];
	for (const fileWithRefs of filesWithReferences) {
		const sourcePath = normalizePath(fileWithRefs.filePath);

		for (const ref of fileWithRefs.references) {
			let targetFilePath: string | undefined;

			if (
				ref.referenceType === "import" ||
				ref.referenceType === "re_export" ||
				ref.referenceType === "export_all" ||
				ref.referenceType === "dynamic_import"
			) {
				if (ref.metadata?.importSource) {
					const resolved = resolveImport(
						ref.metadata.importSource,
						fileWithRefs.filePath,
						allIndexedFiles,
						pathMappings,
						localPath,
					);
					if (resolved) {
						targetFilePath = normalizePath(resolved);
					}
				}
			} else {
				// Keep parity with current storeReferences fallback for unresolved non-import refs.
				targetFilePath = sourcePath;
			}

			graphReferences.push({
				source_file_path: sourcePath,
				target_file_path: targetFilePath,
				line_number: ref.lineNumber,
				reference_type: ref.referenceType,
				metadata: {
					target_name: ref.targetName,
					column_number: ref.columnNumber,
					...ref.metadata,
				},
			});
		}
	}

	if (graphReferences.length > 0) {
		await storeIndexedData(repositoryId, [], [], graphReferences, []);
	}

	await updateRepositoryLastIndexed(repositoryId);

	logger.info("Local indexing workflow completed", {
		repositoryId,
		filesIndexed,
		symbolsExtracted: totalSymbols,
		referencesExtracted: totalReferences,
	});

	return {
		repositoryId,
		filesIndexed,
		symbolsExtracted: totalSymbols,
		referencesExtracted: totalReferences,
	};
}

// Alias for backward compatibility
export const runIndexingWorkflowLocal = runIndexingWorkflow;
