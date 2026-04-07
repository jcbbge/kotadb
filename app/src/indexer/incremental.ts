/**
 * Incremental indexing support for KotaDB.
 *
 * Provides efficient re-indexing of changed files without full repository scans.
 * Supports both git-based change detection and mtime-based fallback.
 *
 * Key features:
 * - indexChangedFiles: Re-index only specified files
 * - deleteIndexedFiles: Remove files from index
 * - detectChangedFiles: Git-based or mtime-based change detection
 *
 * @module @indexer/incremental
 */

import { stat } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { createLogger } from "@logging/logger.js";
import { getDb } from "@db/client.js";
import { parseFileWithRecovery, isSupportedForAST } from "@indexer/ast-parser.js";
import { extractSymbols } from "@indexer/symbol-extractor.js";
import { extractPhpSymbols } from "@indexer/php-extractor.js";
import { extractZigSymbols } from "@indexer/zig-extractor.js";
import { extractReferences, type Reference } from "@indexer/reference-extractor.js";
import { parseTsConfig, type PathMappings } from "@indexer/path-resolver.js";
import { parseSourceFile } from "@indexer/parsers.js";
import { resolveImport } from "@indexer/import-resolver.js";
import { detectLanguage } from "@shared/language-utils.js";
import { Sentry } from "../instrument.js";

const logger = createLogger({ module: "indexer-incremental" });

/**
 * Result of incremental indexing operation.
 */
export interface IncrementalIndexResult {
	/** Number of files updated */
	filesUpdated: number;
	/** Number of files deleted from index */
	filesDeleted: number;
	/** Number of symbols extracted */
	symbolsExtracted: number;
	/** Number of references extracted */
	referencesExtracted: number;
	/** Paths that failed to index */
	errors: Array<{ path: string; error: string }>;
}

/**
 * Changed file entry with metadata.
 */
export interface ChangedFile {
	/** Relative path from repository root */
	path: string;
	/** Change type: added, modified, or deleted */
	status: "added" | "modified" | "deleted";
}

/**
 * Options for change detection.
 */
export interface DetectChangesOptions {
	/** Repository root path */
	repositoryPath: string;
	/** Repository ID in database */
	repositoryId: string;
	/** Use git for change detection (default: true if .git exists) */
	useGit?: boolean;
	/** Base ref for git diff (default: HEAD) */
	baseRef?: string;
}

// Supported file extensions for incremental indexing (matches parsers.ts)
const SUPPORTED_EXTENSIONS = new Set<string>([
	".ts",
	".tsx",
	".js",
	".jsx",
	".cjs",
	".mjs",
	".json",
	".php",
	".zig",
]);

/**
 * Normalize file path for consistent database storage.
 */
function normalizePath(filePath: string): string {
	let normalized = filePath.replace(/\\/g, "/");
	if (normalized.startsWith("/")) {
		normalized = normalized.slice(1);
	}
	if (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}
	return normalized;
}

/**
 * Check if file extension is supported for indexing.
 */
function isSupportedSource(filePath: string): boolean {
	return SUPPORTED_EXTENSIONS.has(extname(filePath).toLowerCase());
}

// ---------------------------------------------------------------------------
// Reference type classification (mirrors storage.ts)
// ---------------------------------------------------------------------------

const IMPORT_TYPES = new Set(["import", "re_export", "export_all", "dynamic_import"]);
const CALL_TYPES = new Set(["call", "property_access", "type_reference", "variable_reference"]);
const EXTENDS_TYPES = new Set(["extends", "implements"]);

function classifyReference(referenceType: string): "imports" | "calls" | "extends" | null {
	if (IMPORT_TYPES.has(referenceType)) return "imports";
	if (CALL_TYPES.has(referenceType)) return "calls";
	if (EXTENDS_TYPES.has(referenceType)) return "extends";
	return null;
}

// ---------------------------------------------------------------------------
// deleteIndexedFiles
// ---------------------------------------------------------------------------

/**
 * Delete indexed data for specified file paths.
 *
 * Removes files, associated symbols, and graph edges.
 *
 * @param repositoryId - Repository UUID
 * @param paths - Array of relative file paths to delete
 * @returns Number of files deleted
 */
export async function deleteIndexedFiles(
	repositoryId: string,
	paths: string[],
): Promise<number> {
	return deleteIndexedFilesInternal(repositoryId, paths);
}

/**
 * Internal implementation.
 */
async function deleteIndexedFilesInternal(
	repositoryId: string,
	paths: string[],
): Promise<number> {
	if (paths.length === 0) {
		return 0;
	}

	const db = await getDb();
	let deletedCount = 0;
	const repoRecordId = `repo:\`${repositoryId}\``;

	for (const filePath of paths) {
		const normalizedPath = normalizePath(filePath);

		// Find the file record
		const rows = await db.query<[Array<{ id: string }>]>(
			`SELECT id FROM file WHERE repo = $repo AND path = $path LIMIT 1`,
			{ repo: repoRecordId, path: normalizedPath },
		);
		const fileRecord = rows[0]?.[0];

		if (!fileRecord) {
			logger.debug("File not found in index, skipping delete", {
				path: normalizedPath,
				repositoryId,
			});
			continue;
		}

		const fileRecordId = `file:\`${fileRecord.id}\``;

		// Delete graph edges originating from this file
		await db.query(`DELETE ${fileRecordId}->imports`);
		await db.query(`DELETE (SELECT * FROM calls WHERE in.file = ${fileRecordId})`);
		await db.query(`DELETE (SELECT * FROM extends WHERE in.file = ${fileRecordId})`);

		// Delete symbols belonging to this file
		await db.query(
			`DELETE symbol WHERE file = ${fileRecordId}`,
		);

		// Delete the file record itself
		await db.query(`DELETE ${fileRecordId}`);

		deletedCount++;
		logger.debug("Deleted indexed file", {
			path: normalizedPath,
			fileId: fileRecord.id,
		});
	}

	logger.info("Deleted indexed files", {
		repositoryId,
		count: deletedCount,
		requested: paths.length,
	});

	return deletedCount;
}

// ---------------------------------------------------------------------------
// indexChangedFiles
// ---------------------------------------------------------------------------

/**
 * Index or re-index specified changed files.
 *
 * For each file:
 * 1. Deletes existing data (if file was previously indexed)
 * 2. Reads and parses file content
 * 3. Extracts symbols and references
 * 4. Stores new data
 *
 * @param repositoryId - Repository UUID
 * @param repositoryPath - Absolute path to repository root
 * @param changedFiles - Array of changed file entries
 * @returns Indexing result with counts and errors
 */
export async function indexChangedFiles(
	repositoryId: string,
	repositoryPath: string,
	changedFiles: ChangedFile[],
): Promise<IncrementalIndexResult> {
	return indexChangedFilesInternal(repositoryId, repositoryPath, changedFiles);
}

/**
 * Internal implementation.
 */
async function indexChangedFilesInternal(
	repositoryId: string,
	repositoryPath: string,
	changedFiles: ChangedFile[],
): Promise<IncrementalIndexResult> {
	const absoluteRoot = resolve(repositoryPath);
	const result: IncrementalIndexResult = {
		filesUpdated: 0,
		filesDeleted: 0,
		symbolsExtracted: 0,
		referencesExtracted: 0,
		errors: [],
	};

	if (changedFiles.length === 0) {
		return result;
	}

	const db = await getDb();
	const repoRecordId = `repo:\`${repositoryId}\``;

	// Separate deleted files from added/modified
	const deletedPaths: string[] = [];
	const filesToIndex: ChangedFile[] = [];

	for (const file of changedFiles) {
		if (file.status === "deleted") {
			deletedPaths.push(file.path);
		} else if (isSupportedSource(file.path)) {
			filesToIndex.push(file);
		}
	}

	// Handle deletions first
	if (deletedPaths.length > 0) {
		result.filesDeleted = await deleteIndexedFilesInternal(repositoryId, deletedPaths);
	}

	if (filesToIndex.length === 0) {
		return result;
	}

	// Parse tsconfig.json for path alias resolution
	const pathMappings = parseTsConfig(absoluteRoot);
	if (pathMappings) {
		logger.debug("Loaded path mappings for incremental indexing", {
			aliasCount: Object.keys(pathMappings.paths).length,
		});
	}

	// Get all indexed files for reference resolution
	const indexedFileRows = await db.query<[Array<{ id: string; path: string }>]>(
		`SELECT id, path FROM file WHERE repo = $repo`,
		{ repo: repoRecordId },
	);
	const allIndexedFiles = (indexedFileRows[0] ?? []).map((row) => ({
		id: row.id,
		path: row.path,
	}));

	// Build set of existing paths for quick lookup
	const existingPaths = new Set(allIndexedFiles.map((f) => f.path));

	// Process each file to index
	for (const changedFile of filesToIndex) {
		const normalizedPath = normalizePath(changedFile.path);
		const absolutePath = resolve(absoluteRoot, changedFile.path);

		try {
			// Parse source file
			const fileRecord = await parseSourceFile(absolutePath, absoluteRoot);
			if (!fileRecord) {
				result.errors.push({
					path: changedFile.path,
					error: "Failed to parse source file",
				});
				continue;
			}

			// Delete existing data if file was previously indexed
			if (existingPaths.has(normalizedPath)) {
				await deleteIndexedFilesInternal(repositoryId, [normalizedPath]);
			}

			// Store file in SurrealDB
			const fileId = randomUUID();
			const fileRecordId = `file:\`${fileId}\``;
			const language = detectLanguage(fileRecord.path);
			const sizeBytes = new TextEncoder().encode(fileRecord.content).length;
			const indexedAt = new Date().toISOString();
			const fileMetadata = { dependencies: fileRecord.dependencies || [] };

			await db.query(
				`UPSERT ${fileRecordId} SET
					repo = $repo,
					path = $path,
					content = $content,
					language = $language,
					size_bytes = $size_bytes,
					content_hash = NONE,
					indexed_at = $indexed_at,
					metadata = $metadata`,
				{
					repo: repoRecordId,
					path: normalizedPath,
					content: fileRecord.content,
					language,
					size_bytes: sizeBytes,
					indexed_at: indexedAt,
					metadata: fileMetadata,
				},
			);

			result.filesUpdated++;

			// Extract and store symbols/references
			const isPhp = normalizedPath.endsWith(".php");
			const isZig = normalizedPath.endsWith(".zig");
			if (isSupportedForAST(normalizedPath) || isPhp || isZig) {
				let symbols: ReturnType<typeof extractSymbols> = [];
				let references: ReturnType<typeof extractReferences> = [];

				if (isPhp) {
					symbols = extractPhpSymbols(fileRecord.content, normalizedPath);
				} else if (isZig) {
					symbols = extractZigSymbols(fileRecord.content, normalizedPath);
				} else {
					const parseResult = parseFileWithRecovery(normalizedPath, fileRecord.content);
					if (parseResult.ast) {
						symbols = extractSymbols(parseResult.ast, normalizedPath);
						references = extractReferences(parseResult.ast, normalizedPath);
					}
				}

					// Map symbol key → record ID for reference resolution
					const symbolKeyToRecordId = new Map<string, string>();

					// Store symbols
					if (symbols.length > 0) {
						for (const symbol of symbols) {
							const symbolId = randomUUID();
							const symbolRecordId = `symbol:\`${symbolId}\``;
							const symbolKey = `${normalizedPath}::${symbol.name}::${symbol.lineStart}`;
							const symbolMetadata = {
								column_start: symbol.columnStart,
								column_end: symbol.columnEnd,
								is_exported: symbol.isExported,
								is_async: symbol.isAsync,
								access_modifier: symbol.accessModifier,
							};

							await db.query(
								`UPSERT ${symbolRecordId} SET
									file = $file,
									repo = $repo,
									name = $name,
									kind = $kind,
									line_start = $line_start,
									line_end = $line_end,
									signature = $signature,
									documentation = $documentation,
									metadata = $metadata`,
								{
									file: fileRecordId,
									repo: repoRecordId,
									name: symbol.name,
									kind: symbol.kind,
									line_start: symbol.lineStart,
									line_end: symbol.lineEnd,
									signature: symbol.signature ?? null,
									documentation: symbol.documentation ?? null,
									metadata: symbolMetadata,
								},
							);

							symbolKeyToRecordId.set(symbolKey, symbolRecordId);
							result.symbolsExtracted++;
						}
					}

					// Store references as graph edges
					if (references.length > 0) {
						const updatedFiles = [
							...allIndexedFiles,
							{ id: fileId, path: normalizedPath },
						];
						const refCount = await storeReferencesForFile(
							db,
							fileId,
							fileRecordId,
							repoRecordId,
							normalizedPath,
							references,
							symbolKeyToRecordId,
							updatedFiles,
							pathMappings,
							absoluteRoot,
						);
						result.referencesExtracted += refCount;
					}
			}

			logger.debug("Indexed changed file", {
				path: normalizedPath,
				status: changedFile.status,
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			result.errors.push({ path: changedFile.path, error: errorMessage });
			logger.error(
				"Failed to index changed file",
				error instanceof Error ? error : undefined,
				{ path: changedFile.path },
			);

			if (error instanceof Error) {
				Sentry.captureException(error, {
					tags: { module: "incremental-indexer" },
					contexts: { file: { path: changedFile.path } },
				});
			}
		}
	}

	logger.info("Incremental indexing complete", {
		repositoryId,
		filesUpdated: result.filesUpdated,
		filesDeleted: result.filesDeleted,
		symbolsExtracted: result.symbolsExtracted,
		referencesExtracted: result.referencesExtracted,
		errors: result.errors.length,
	});

	return result;
}

// ---------------------------------------------------------------------------
// storeReferencesForFile — creates graph edges for a single file's references
// ---------------------------------------------------------------------------

/**
 * Store references for a single file as SurrealDB graph edges.
 */
async function storeReferencesForFile(
	db: Awaited<ReturnType<typeof getDb>>,
	fileId: string,
	fileRecordId: string,
	repoRecordId: string,
	filePath: string,
	references: Reference[],
	symbolKeyToRecordId: Map<string, string>,
	allFiles: Array<{ id: string; path: string }>,
	pathMappings: PathMappings | null,
	repoRoot?: string,
): Promise<number> {
	let count = 0;

	// Delete pre-existing edges for this file before re-inserting
	await db.query(`DELETE ${fileRecordId}->imports`);
	await db.query(`DELETE (SELECT * FROM calls WHERE in.file = ${fileRecordId})`);
	await db.query(`DELETE (SELECT * FROM extends WHERE in.file = ${fileRecordId})`);

	// Build a quick path → record ID map from allFiles
	const pathToFileRecordId = new Map<string, string>(
		allFiles.map((f) => [f.path, `file:\`${f.id}\``]),
	);
	// Ensure the current file is included (it was just inserted)
	pathToFileRecordId.set(filePath, fileRecordId);

	for (const ref of references) {
		const edgeTable = classifyReference(ref.referenceType);
		if (!edgeTable) {
			continue;
		}

		const metadata = { target_name: ref.targetName, column_number: ref.columnNumber, ...ref.metadata };

		if (edgeTable === "imports") {
			// Resolve the import target to a file record
			let targetRecordId: string | null = null;

			if (ref.metadata?.importSource) {
				const resolved = resolveImport(
					ref.metadata.importSource,
					filePath,
					allFiles,
					pathMappings,
					repoRoot,
				);
				if (resolved) {
					const normalizedResolved = resolved.replace(/\\/g, "/").replace(/^\//, "").replace(/^\.\//, "");
					targetRecordId = pathToFileRecordId.get(normalizedResolved) ?? null;
				}
			}

			if (!targetRecordId) {
				continue;
			}

			await db.query(
				`RELATE ${fileRecordId}->${edgeTable}->${targetRecordId} SET
					reference_type = $reference_type,
					line_number = $line_number,
					column_number = $column_number,
					metadata = $metadata`,
				{
					reference_type: ref.referenceType,
					line_number: ref.lineNumber,
					column_number: ref.columnNumber ?? 0,
					metadata,
				},
			);
		} else {
			// calls / extends: symbol → symbol preferred, fall back to file → file
			const symbolKey = ref.targetName
				? symbolKeyToRecordId.get(`${filePath}::${ref.targetName}::${ref.lineNumber}`) ?? null
				: null;

			const sourceNode = symbolKey ?? fileRecordId;
			const targetNode = symbolKey ?? fileRecordId;

			// Only emit if source !== target (avoid self-loops on fallback)
			if (sourceNode === targetNode && sourceNode === fileRecordId) {
				continue;
			}

			await db.query(
				`RELATE ${sourceNode}->${edgeTable}->${targetNode} SET
					reference_type = $reference_type,
					line_number = $line_number,
					column_number = $column_number,
					metadata = $metadata`,
				{
					reference_type: ref.referenceType,
					line_number: ref.lineNumber,
					column_number: ref.columnNumber ?? 0,
					metadata,
				},
			);
		}

		count++;
	}

	return count;
}

// ---------------------------------------------------------------------------
// detectChangedFiles
// ---------------------------------------------------------------------------

/**
 * Detect changed files using git or mtime comparison.
 */
export async function detectChangedFiles(options: DetectChangesOptions): Promise<ChangedFile[]> {
	const { repositoryPath, repositoryId } = options;
	const absoluteRoot = resolve(repositoryPath);
	const useGit = options.useGit ?? (await hasGitDirectory(absoluteRoot));

	if (useGit) {
		return detectChangedFilesGit(absoluteRoot, repositoryId, options.baseRef);
	}
	return detectChangedFilesMtime(absoluteRoot, repositoryId);
}

async function hasGitDirectory(repositoryPath: string): Promise<boolean> {
	try {
		const gitPath = resolve(repositoryPath, ".git");
		const stats = await stat(gitPath);
		return stats.isDirectory();
	} catch {
		return false;
	}
}

async function detectChangedFilesGit(
	repositoryPath: string,
	repositoryId: string,
	baseRef: string = "HEAD",
): Promise<ChangedFile[]> {
	const changed: ChangedFile[] = [];

	try {
		const diffResult = await runGit(["diff", "--name-status", baseRef], {
			cwd: repositoryPath,
			allowFailure: true,
		});

		if (diffResult.exitCode === 0 && diffResult.stdout.trim()) {
			const lines = diffResult.stdout.trim().split("\n");
			for (const line of lines) {
				const parts = line.split("\t");
				const statusCode = parts[0];
				const filePath = parts.slice(1).join("\t");

				if (!filePath || !isSupportedSource(filePath)) continue;

				let status: ChangedFile["status"];
				switch (statusCode?.[0]) {
					case "A": status = "added"; break;
					case "D": status = "deleted"; break;
					default: status = "modified"; break;
				}

				changed.push({ path: normalizePath(filePath), status });
			}
		}

		const statusResult = await runGit(
			["status", "--porcelain", "--untracked-files=normal"],
			{ cwd: repositoryPath, allowFailure: true },
		);

		if (statusResult.exitCode === 0 && statusResult.stdout.trim()) {
			const lines = statusResult.stdout.trim().split("\n");
			for (const line of lines) {
				const statusCode = line.slice(0, 2);
				const filePath = line.slice(3);

				if (!filePath || !isSupportedSource(filePath)) continue;

				if (statusCode === "??") {
					const normalizedPath = normalizePath(filePath);
					if (!changed.some((c) => c.path === normalizedPath)) {
						changed.push({ path: normalizedPath, status: "added" });
					}
				}
			}
		}

		logger.info("Detected changed files via git", {
			repositoryPath,
			count: changed.length,
			baseRef,
		});
	} catch (error) {
		logger.warn("Git change detection failed, falling back to mtime", {
			error: error instanceof Error ? error.message : String(error),
		});
		return detectChangedFilesMtime(repositoryPath, repositoryId);
	}

	return changed;
}

async function detectChangedFilesMtime(
	repositoryPath: string,
	repositoryId: string,
): Promise<ChangedFile[]> {
	const db = await getDb();
	const changed: ChangedFile[] = [];
	const repoRecordId = `repo:\`${repositoryId}\``;

	const rows = await db.query<[Array<{ path: string; indexed_at: string }>]>(
		`SELECT path, indexed_at FROM file WHERE repo = $repo`,
		{ repo: repoRecordId },
	);
	const indexedFiles = rows[0] ?? [];

	const indexedMap = new Map<string, Date>();
	for (const file of indexedFiles) {
		indexedMap.set(file.path, new Date(file.indexed_at));
	}

	const { discoverSources } = await import("@indexer/parsers.js");
	const allSources = await discoverSources(repositoryPath);

	for (const absolutePath of allSources) {
		const relativePath = normalizePath(relative(repositoryPath, absolutePath));

		try {
			const fileStat = await stat(absolutePath);
			const mtime = fileStat.mtime;
			const indexedAt = indexedMap.get(relativePath);

			if (!indexedAt) {
				changed.push({ path: relativePath, status: "added" });
			} else if (mtime > indexedAt) {
				changed.push({ path: relativePath, status: "modified" });
			}

			indexedMap.delete(relativePath);
		} catch {
			if (indexedMap.has(relativePath)) {
				changed.push({ path: relativePath, status: "deleted" });
				indexedMap.delete(relativePath);
			}
		}
	}

	for (const [path] of indexedMap) {
		changed.push({ path, status: "deleted" });
	}

	logger.info("Detected changed files via mtime", {
		repositoryPath,
		count: changed.length,
	});
	return changed;
}

// ---------------------------------------------------------------------------
// Git utility
// ---------------------------------------------------------------------------

interface GitCommandResult { stdout: string; stderr: string; exitCode: number; }
interface GitCommandOptions { cwd?: string; allowFailure?: boolean; }

async function runGit(args: string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
	const proc = Bun.spawn({
		cmd: ["git", ...args],
		stdout: "pipe",
		stderr: "pipe",
		cwd: options.cwd,
	});
	const stdoutPromise = proc.stdout ? new Response(proc.stdout).text() : Promise.resolve("");
	const stderrPromise = proc.stderr ? new Response(proc.stderr).text() : Promise.resolve("");
	const exitCode = await proc.exited;
	const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

	if (exitCode !== 0 && !options.allowFailure) {
		const gitError = new Error(
			`git ${args.join(" ")} failed with code ${exitCode}: ${stderr.trim()}`,
		);
		logger.error("Git command failed", gitError, {
			git_command: args.join(" "),
			exit_code: exitCode,
			cwd: options.cwd,
		});
		throw gitError;
	}

	return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// Test-friendly aliases
// ---------------------------------------------------------------------------

/**
 * @deprecated Use deleteIndexedFiles() directly.
 *
 * The `db` parameter is accepted for call-site compatibility but is not used;
 * SurrealDB singleton is retrieved via getDb() internally.
 */
export async function deleteIndexedFilesLocal(
	_db: unknown,
	repositoryId: string,
	paths: string[],
): Promise<number> {
	return deleteIndexedFilesInternal(repositoryId, paths);
}

/**
 * @deprecated Use indexChangedFiles() directly.
 *
 * The `db` parameter is accepted for call-site compatibility but is not used.
 */
export async function indexChangedFilesLocal(
	_db: unknown,
	repositoryId: string,
	repositoryPath: string,
	changedFiles: ChangedFile[],
): Promise<IncrementalIndexResult> {
	return indexChangedFilesInternal(repositoryId, repositoryPath, changedFiles);
}
