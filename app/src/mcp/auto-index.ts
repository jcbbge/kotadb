/**
 * Auto-indexing utilities for MCP tools
 *
 * Provides automatic repository detection and indexing on first tool use.
 * This enables "just works" behavior where users don't need to manually
 * index their codebase before using search/analysis tools.
 *
 * Issue: #35 - Automatic indexing implementation
 */

import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getDb } from "@db/client.js";
import { createLogger } from "@logging/logger.js";
import {
	runIndexingWorkflow,
	isRepositoryIndexed as isRepositoryIndexedQuery,
	deleteFileByPath as deleteFileByPathQuery,
	deleteFilesByPaths as deleteFilesByPathsQuery,
	getRepositoryIdByName,
} from "@api/queries";
import type { IndexRequest } from "@shared/types";

const logger = createLogger({ module: "auto-index" });

// Re-export the database functions for convenience
export { isRepositoryIndexedQuery as isRepositoryIndexed };

/**
 * Check if a repository path has been indexed.
 *
 * @param localPath - Absolute path to the repository
 * @returns Object with indexed status and repository ID if found
 */
export async function isPathIndexed(
	localPath: string,
): Promise<{ indexed: boolean; repositoryId?: string }> {
	const db = await getDb();

	// Normalize path
	const normalizedPath = resolve(localPath);

	// Check for repository with matching git_url (local paths are stored as git_url)
	const [rows] = await db.query<Array<Array<{ id: unknown; last_indexed_at: string | null }>>>(
		"SELECT id, last_indexed_at FROM repo WHERE git_url = $gitUrl LIMIT 1",
		{ gitUrl: normalizedPath },
	);

	if (!rows || rows.length === 0) {
		return { indexed: false };
	}

	const row = rows[0];
	if (!row) return { indexed: false };
	const rawId =
		typeof row.id === "object" && row.id !== null
			? ((row.id as Record<string, unknown>)["id"] as string | undefined) ?? String(row.id)
			: String(row.id);

	if (!row.last_indexed_at) {
		return { indexed: false, repositoryId: rawId };
	}

	// Verify at least one file exists using the query function
	const indexed = await isRepositoryIndexedQuery(rawId);
	return {
		indexed,
		repositoryId: rawId,
	};
}

/**
 * Detect repository identifier from the current working directory.
 *
 * Uses the following heuristics:
 * 1. Check if a .git directory exists
 * 2. Extract repository name from directory name
 * 3. Create a local/* identifier for local repositories
 *
 * @param cwd - Working directory (defaults to process.cwd())
 * @returns Repository identifier in "local/name" format, or null if not a repository
 */
export function detectRepositoryFromCwd(cwd?: string): string | null {
	const workDir = cwd || process.cwd();

	// Check if this looks like a git repository
	const gitDir = resolve(workDir, ".git");
	if (!existsSync(gitDir)) {
		logger.debug("Not a git repository (no .git directory)", { path: workDir });
		return null;
	}

	// Extract repository name from directory
	const repoName = basename(workDir);
	const identifier = "local/" + repoName;

	logger.debug("Detected repository from cwd", { path: workDir, identifier });
	return identifier;
}

/**
 * Result of auto-index operation
 */
export interface AutoIndexResult {
	/** Whether indexing was performed (false if already indexed) */
	wasIndexed: boolean;
	/** Repository ID (either existing or newly created) */
	repositoryId: string;
	/** Human-readable message about what happened */
	message: string;
	/** Indexing stats (only present if wasIndexed is true) */
	stats?: {
		filesIndexed: number;
		symbolsExtracted: number;
		referencesExtracted: number;
	};
}

/**
 * Ensure a repository is indexed before tool execution.
 *
 * This is the main auto-index entry point. It:
 * 1. Resolves the repository identifier (from param or cwd)
 * 2. Checks if already indexed
 * 3. Performs indexing if needed
 * 4. Returns the repository ID for use by the tool
 *
 * @param repositoryParam - Optional repository identifier from tool params
 * @param localPath - Optional local path override
 * @returns AutoIndexResult with repository ID and status
 */
export async function ensureRepositoryIndexed(
	repositoryParam?: string,
	localPath?: string,
): Promise<AutoIndexResult> {
	const db = await getDb();

	// Determine the repository identifier
	let identifier: string;
	let repoLocalPath: string | undefined = localPath;

	if (repositoryParam) {
		identifier = repositoryParam;

		// Check if this is a local path being passed as repository
		if (existsSync(repositoryParam) && existsSync(resolve(repositoryParam, ".git"))) {
			repoLocalPath = resolve(repositoryParam);
			identifier = "local/" + basename(repositoryParam);
		}
	} else {
		// Auto-detect from cwd
		const detected = detectRepositoryFromCwd();
		if (!detected) {
			throw new Error(
				"Could not detect repository. Please provide a 'repository' parameter or run from within a git repository.",
			);
		}
		identifier = detected;
		repoLocalPath = process.cwd();
	}

	// Check if already indexed by full_name
	const [existingRows] = await db.query<Array<Array<{ id: unknown; last_indexed_at: string | null }>>>(
		"SELECT id, last_indexed_at FROM repo WHERE full_name = $fullName LIMIT 1",
		{ fullName: identifier },
	);

	const existing = existingRows && existingRows.length > 0 ? existingRows[0] : null;

	if (existing && existing.last_indexed_at) {
		const rawId =
			typeof existing.id === "object" && existing.id !== null
				? ((existing.id as Record<string, unknown>)["id"] as string | undefined) ?? String(existing.id)
				: String(existing.id);

		// Verify files exist using the database function
		if (await isRepositoryIndexedQuery(rawId)) {
			logger.debug("Repository already indexed", {
				identifier,
				repositoryId: rawId,
			});

			return {
				wasIndexed: false,
				repositoryId: rawId,
				message: "Repository '" + identifier + "' is already indexed",
			};
		}
	}

	// Need to index - prepare request
	logger.info("Auto-indexing repository", { identifier, localPath: repoLocalPath });

	const indexRequest: IndexRequest = {
		repository: identifier,
		ref: "main",
		localPath: repoLocalPath,
	};

	try {
		const result = await runIndexingWorkflow(indexRequest);

		logger.info("Auto-indexing completed", {
			identifier,
			repositoryId: result.repositoryId,
			filesIndexed: result.filesIndexed,
		});

		return {
			wasIndexed: true,
			repositoryId: result.repositoryId,
			message: "Automatically indexed repository '" + identifier + "' (" + result.filesIndexed + " files)",
			stats: {
				filesIndexed: result.filesIndexed,
				symbolsExtracted: result.symbolsExtracted,
				referencesExtracted: result.referencesExtracted,
			},
		};
	} catch (error) {
		logger.error(
			"Auto-indexing failed",
			error instanceof Error ? error : new Error(String(error)),
			{ identifier },
		);
		throw new Error(
			"Failed to auto-index repository '" + identifier + "': " + (error instanceof Error ? error.message : String(error)),
		);
	}
}

/**
 * Delete indexed files by path for incremental updates.
 * Delegates to the database layer function which handles edge cleanup properly.
 *
 * @param repositoryId - Repository UUID
 * @param filePaths - Array of file paths to delete (relative to repo root)
 * @returns Number of files deleted
 */
export async function deleteFilesByPath(repositoryId: string, filePaths: string[]): Promise<number> {
	const result = await deleteFilesByPathsQuery(repositoryId, filePaths);
	return result.deletedCount;
}

/**
 * Delete a single file by path.
 * Delegates to the database layer function.
 *
 * @param repositoryId - Repository UUID
 * @param filePath - File path to delete (relative to repo root)
 * @returns true if file was deleted, false if not found
 */
export async function deleteFileByPath(repositoryId: string, filePath: string): Promise<boolean> {
	return deleteFileByPathQuery(repositoryId, filePath);
}
