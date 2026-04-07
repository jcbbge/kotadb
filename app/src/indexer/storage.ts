/**
 * Database storage layer for indexed data
 *
 * SurrealDB storage layer implementation.
 * Uses graph edges (calls, imports, extends) instead of a flat references table.
 *
 * @module @indexer/storage
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "@logging/logger.js";
import { getDb } from "@db/client.js";

const logger = createLogger({ module: "indexer-storage" });

/**
 * File data for storage (matches file table fields)
 */
export interface FileData {
	path: string;
	content: string;
	language: string;
	size_bytes: number;
	metadata?: Record<string, unknown>;
}

/**
 * Symbol data for storage (matches symbol table fields)
 */
export interface SymbolData {
	file_path: string; // Used to lookup file record ID in storage function
	name: string;
	kind: string;
	line_start: number;
	line_end: number;
	signature?: string;
	documentation?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Reference data for storage
 *
 * reference_type drives which graph edge table is used:
 *   import | re_export | export_all | dynamic_import  → imports edge
 *   call | property_access | type_reference | variable_reference → calls edge
 *   extends | implements → extends edge
 */
export interface ReferenceData {
	source_file_path: string; // Used to lookup source file record ID
source_symbol_key?: string; // Optional source symbol key when available
	target_symbol_key?: string; // Format: "file_path::symbol_name::line_start"
	target_file_path?: string; // Fallback if symbol not extracted
	line_number: number;
	reference_type: string;
	metadata?: Record<string, unknown>;
}

/**
 * Dependency graph entry for storage
 */
export interface DependencyGraphEntry {
	from_file_path?: string;
	to_file_path?: string;
	from_symbol_key?: string; // Format: "file_path::symbol_name::line_start"
	to_symbol_key?: string; // Format: "file_path::symbol_name::line_start"
	dependency_type: string;
	metadata?: Record<string, unknown>;
}

/**
 * Result stats returned by storeIndexedData()
 */
export interface StorageResult {
	files_indexed: number;
	symbols_extracted: number;
	references_found: number;
	dependencies_extracted: number;
}

// ---------------------------------------------------------------------------
// Reference type classification helpers
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
// Main storage function
// ---------------------------------------------------------------------------

/**
 * Store indexed data atomically in SurrealDB.
 *
 * Performs:
 * 1. Upsert files and build fileId mapping
 * 2. Upsert symbols and build symbolId mapping
 * 3. Delete existing graph edges for each file, then create new edges
 * 4. Return summary stats
 *
 * @param repositoryId - Repository UUID
 * @param files - Array of file data to store
 * @param symbols - Array of symbol data to store
 * @param references - Array of reference data to store
 * @param dependencyGraph - Array of dependency graph entries (counted only)
 * @returns Summary stats
 */
export async function storeIndexedData(
	repositoryId: string,
	files: FileData[],
	symbols: SymbolData[],
	references: ReferenceData[],
	dependencyGraph: DependencyGraphEntry[],
): Promise<StorageResult> {
	const db = await getDb();

	let filesIndexed = 0;
	let symbolsExtracted = 0;
	let referencesFound = 0;

	// Map from file path → SurrealDB record ID string (e.g. "file:⟨uuid⟩")
	const filePathToRecordId = new Map<string, string>();
	// Map from symbol key → SurrealDB record ID string (e.g. "symbol:⟨uuid⟩")
	const symbolKeyToRecordId = new Map<string, string>();

	const indexedAt = new Date().toISOString();
	const repoRecordId = `repo:\`${repositoryId}\``;

	// -------------------------------------------------------------------------
	// 1. Upsert files
	// -------------------------------------------------------------------------
	for (const file of files) {
		const id = randomUUID();
		const recordId = `file:\`${id}\``;
		const metadata = file.metadata ?? {};

		await db.query(
			`UPSERT ${recordId} SET
				repo = $repo,
				path = $path,
				content = $content,
				language = $language,
				size_bytes = $size_bytes,
				indexed_at = $indexed_at,
				metadata = $metadata`,
			{
				repo: repoRecordId,
				path: file.path,
				content: file.content,
				language: file.language,
				size_bytes: file.size_bytes,
				indexed_at: indexedAt,
				metadata,
			},
		);

		filePathToRecordId.set(file.path, recordId);
		filesIndexed++;
	}

	// -------------------------------------------------------------------------
	// 2. Upsert symbols
	// -------------------------------------------------------------------------
	for (const symbol of symbols) {
		const fileRecordId = filePathToRecordId.get(symbol.file_path);
		if (!fileRecordId) {
			logger.warn("Symbol file not found in this batch", { file_path: symbol.file_path });
			continue;
		}

		const id = randomUUID();
		const recordId = `symbol:\`${id}\``;
		const symbolKey = `${symbol.file_path}::${symbol.name}::${symbol.line_start}`;
		const metadata = symbol.metadata ?? {};

		await db.query(
			`UPSERT ${recordId} SET
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
				line_start: symbol.line_start,
				line_end: symbol.line_end,
				signature: symbol.signature ?? null,
				documentation: symbol.documentation ?? null,
				metadata,
			},
		);

		symbolKeyToRecordId.set(symbolKey, recordId);
		symbolsExtracted++;
	}

	// -------------------------------------------------------------------------
	// 3. Delete existing edges for each file before re-creating
	// -------------------------------------------------------------------------
	// Graph-only mode: hydrate file IDs from existing DB rows when files[] is empty.
	if (filePathToRecordId.size === 0 && references.length > 0) {
		const uniquePaths = Array.from(
			new Set(
				references
					.flatMap((ref) => [ref.source_file_path, ref.target_file_path])
					.filter((path): path is string => Boolean(path)),
			),
		);

		if (uniquePaths.length > 0) {
			const [rows] = await db.query<Array<Array<{ id: string; path: string }>>>(
				`SELECT id.id AS id, path FROM file WHERE repo = $repo AND path IN $paths`,
				{ repo: repoRecordId, paths: uniquePaths },
			);

			for (const row of rows ?? []) {
				filePathToRecordId.set(row.path, `file:\`${row.id}\``);
			}
		}
	}

	for (const [, fileRecordId] of filePathToRecordId) {
		// Delete file-level import edges originating from this file
		await db.query(`DELETE ${fileRecordId}->imports`);
		// Delete symbol-level call/extends edges where the source symbol belongs to this file
		await db.query(`DELETE (SELECT * FROM calls WHERE in.file = ${fileRecordId})`);
		await db.query(`DELETE (SELECT * FROM extends WHERE in.file = ${fileRecordId})`);
	}
	// -------------------------------------------------------------------------
	// 4. Create graph edges for references
	// -------------------------------------------------------------------------
	for (const ref of references) {
		const sourceFileRecordId = filePathToRecordId.get(ref.source_file_path);
		if (!sourceFileRecordId) {
			logger.warn("Reference source file not found in this batch", {
				file_path: ref.source_file_path,
			});
			continue;
		}

		const edgeTable = classifyReference(ref.reference_type);
		if (!edgeTable) {
			logger.warn("Unknown reference_type, skipping", { reference_type: ref.reference_type });
			continue;
		}

		const metadata = ref.metadata ?? {};

		if (edgeTable === "imports") {
			// File → File import edges
			// We need a target file record ID. Try to find from the current batch,
			// then fall back to a SurrealDB lookup by repo + path.
			let targetRecordId: string | null = null;

			if (ref.target_file_path) {
				targetRecordId = filePathToRecordId.get(ref.target_file_path) ?? null;

				if (!targetRecordId) {
					// Look up in the database — file may have been indexed in a prior batch
					const rows = await db.query<[Array<{ id: string }>]>(
						`SELECT id FROM file WHERE repo = $repo AND path = $path LIMIT 1`,
						{ repo: repoRecordId, path: ref.target_file_path },
					);
					const hit = rows[0]?.[0];
					if (hit) {
						targetRecordId = `file:\`${hit.id}\``;
					}
				}
			}

			if (!targetRecordId) {
				// No resolvable target — skip this edge
				continue;
			}

			await db.query(
				`RELATE ${sourceFileRecordId}->${edgeTable}->${targetRecordId} SET
					reference_type = $reference_type,
					line_number = $line_number,
					column_number = $column_number,
					metadata = $metadata`,
				{
					reference_type: ref.reference_type,
					line_number: ref.line_number,
					column_number: 0,
					metadata,
				},
			);
		} else {
			// Symbol → Symbol call / extends edges
			// Try to resolve source and target symbols via their keys.
			let sourceSymbolRecordId: string | null = null;
			let targetSymbolRecordId: string | null = null;

			if (ref.source_symbol_key && ref.target_symbol_key) {
				sourceSymbolRecordId = symbolKeyToRecordId.get(ref.source_symbol_key) ?? null;
				targetSymbolRecordId = symbolKeyToRecordId.get(ref.target_symbol_key) ?? null;
			}
			// If we can't resolve both endpoints, fall back to file → file on call edges
			if (!sourceSymbolRecordId || !targetSymbolRecordId) {
				// Use the source file as the "in" node
				let targetRecordId: string | null = null;
				if (ref.target_file_path) {
					targetRecordId = filePathToRecordId.get(ref.target_file_path) ?? null;
					if (!targetRecordId) {
						const rows = await db.query<[Array<{ id: string }>]>(
							`SELECT id FROM file WHERE repo = $repo AND path = $path LIMIT 1`,
							{ repo: repoRecordId, path: ref.target_file_path },
						);
						const hit = rows[0]?.[0];
						if (hit) {
							targetRecordId = `file:\`${hit.id}\``;
						}
					}
				}

				if (!targetRecordId) {
					// No resolvable target — skip this edge
					continue;
				}

				await db.query(
					`RELATE ${sourceFileRecordId}->${edgeTable}->${targetRecordId} SET
						reference_type = $reference_type,
						line_number = $line_number,
						column_number = $column_number,
						metadata = $metadata`,
					{
						reference_type: ref.reference_type,
						line_number: ref.line_number,
						column_number: 0,
						metadata,
					},
				);
			} else {
				await db.query(
					`RELATE ${sourceSymbolRecordId}->${edgeTable}->${targetSymbolRecordId} SET
						reference_type = $reference_type,
						line_number = $line_number,
						column_number = $column_number,
						metadata = $metadata`,
					{
						reference_type: ref.reference_type,
						line_number: ref.line_number,
						column_number: 0,
						metadata,
					},
				);
			}
		}

		referencesFound++;
	}

	const dependenciesExtracted = dependencyGraph.length;

	logger.info("Successfully stored indexed data to SurrealDB", {
		repository_id: repositoryId,
		files_indexed: filesIndexed,
		symbols_extracted: symbolsExtracted,
		references_found: referencesFound,
		dependencies_extracted: dependenciesExtracted,
	});

	return {
		files_indexed: filesIndexed,
		symbols_extracted: symbolsExtracted,
		references_found: referencesFound,
		dependencies_extracted: dependenciesExtracted,
	};
}

// ============================================================================
// Backward-compatible alias (for tests that pass a db handle — now ignored,
// since SurrealDB uses a singleton retrieved internally)
// ============================================================================

/**
 * @deprecated Use storeIndexedData() directly.
 *
 * The `db` parameter is accepted for call-site compatibility but is not used;
 * the SurrealDB singleton is retrieved via getDb() internally.
 */
export async function storeIndexedDataLocal(
	_db: unknown,
	repositoryId: string,
	files: FileData[],
	symbols: SymbolData[],
	references: ReferenceData[],
	dependencyGraph: DependencyGraphEntry[],
): Promise<StorageResult> {
	return storeIndexedData(repositoryId, files, symbols, references, dependencyGraph);
}
