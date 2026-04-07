/**
 * Embedding pipeline for KotaDB.
 *
 * Generates 768-dimensional vector embeddings via Ollama (nomic-embed-text)
 * and stores them on `file` and `symbol` records in SurrealDB.
 *
 * Designed to run asynchronously AFTER the main indexing pipeline — embeddings
 * are additive. If Ollama is unavailable the pipeline logs a warning and exits
 * cleanly without blocking the caller.
 *
 * @module @indexer/embeddings
 */

import { createLogger } from "@logging/logger.js";
import { getDb } from "@db/surreal/client.js";

const logger = createLogger({ module: "indexer-embeddings" });

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OLLAMA_URL = process.env["OLLAMA_URL"] ?? "http://localhost:7102";
const OLLAMA_MODEL = "nomic-embed-text";
const BATCH_SIZE = 10;
const CONTENT_TRUNCATE_CHARS = 2000;

// ---------------------------------------------------------------------------
// Core: generateEmbedding
// ---------------------------------------------------------------------------

/**
 * Generate a 768-dimensional embedding for a single text string.
 *
 * Calls Ollama at the configured URL using the nomic-embed-text model.
 * Returns null if Ollama is unavailable or returns an unexpected response.
 *
 * Exported so that query layer modules can generate query embeddings for
 * semantic search without duplicating the Ollama call logic.
 *
 * @param text - The text to embed
 * @returns 768-dimensional float array, or null on failure
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
	if (!text || text.trim().length === 0) {
		return null;
	}

	try {
		const response = await fetch(`${OLLAMA_URL}/api/embed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ model: OLLAMA_MODEL, input: text }),
		});

		if (!response.ok) {
			logger.warn("Ollama embed request failed", {
				status: response.status,
				statusText: response.statusText,
			});
			return null;
		}

		const data = (await response.json()) as { embeddings?: number[][] };

		if (!data.embeddings || data.embeddings.length === 0) {
			logger.warn("Ollama returned empty embeddings array");
			return null;
		}

		const vec = data.embeddings[0];
		if (!vec || vec.length === 0) {
			logger.warn("Ollama returned empty first embedding");
			return null;
		}

		return vec;
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		logger.warn("Ollama unavailable — skipping embedding", { cause });
		return null;
	}
}

// ---------------------------------------------------------------------------
// embedFiles — batch-embed file records
// ---------------------------------------------------------------------------

/**
 * Embed a batch of file records identified by their SurrealDB IDs.
 *
 * Content is truncated to CONTENT_TRUNCATE_CHARS characters before embedding
 * to stay within Ollama's context limits and keep throughput reasonable.
 *
 * Processes files in batches of BATCH_SIZE (sequential within each batch,
 * parallel across files within a batch) to avoid overwhelming Ollama.
 *
 * @param fileIds - Array of raw file UUIDs (without the "file:" prefix)
 */
async function embedFiles(fileIds: string[]): Promise<void> {
	if (fileIds.length === 0) return;

	const db = await getDb();

	for (let i = 0; i < fileIds.length; i += BATCH_SIZE) {
		const batch = fileIds.slice(i, i + BATCH_SIZE);

		await Promise.all(
			batch.map(async (fileId) => {
				try {
					// Fetch the file content
					const rows = await db.query<[Array<{ id: string; path: string; content: string }>]>(
						`SELECT id, path, content FROM file:⟨${fileId}⟩`,
					);

					const row = rows[0]?.[0];
					if (!row) {
						logger.warn("File record not found for embedding", { fileId });
						return;
					}

					// Truncate content before embedding
					const text = (row.content ?? "").slice(0, CONTENT_TRUNCATE_CHARS);
					const vector = await generateEmbedding(text);
					if (!vector) return;

					await db.query(
						`UPDATE file:⟨${fileId}⟩ SET embedding = $embedding`,
						{ embedding: vector },
					);

					logger.debug("Embedded file", { fileId, path: row.path, dims: vector.length });
				} catch (err) {
					const cause = err instanceof Error ? err.message : String(err);
					logger.warn("Failed to embed file", { fileId, cause });
				}
			}),
		);
	}
}

// ---------------------------------------------------------------------------
// embedSymbols — batch-embed symbol records
// ---------------------------------------------------------------------------

/**
 * Embed a batch of symbol records identified by their SurrealDB IDs.
 *
 * The text fed to Ollama is: name + " " + signature + " " + documentation,
 * with null fields omitted. This creates a semantically rich representation
 * of each symbol for similarity search.
 *
 * @param symbolIds - Array of raw symbol UUIDs (without the "symbol:" prefix)
 */
async function embedSymbols(symbolIds: string[]): Promise<void> {
	if (symbolIds.length === 0) return;

	const db = await getDb();

	for (let i = 0; i < symbolIds.length; i += BATCH_SIZE) {
		const batch = symbolIds.slice(i, i + BATCH_SIZE);

		await Promise.all(
			batch.map(async (symbolId) => {
				try {
					const rows = await db.query<
						[Array<{ id: string; name: string; signature: string | null; documentation: string | null }>]
					>(`SELECT id, name, signature, documentation FROM symbol:⟨${symbolId}⟩`);

					const row = rows[0]?.[0];
					if (!row) {
						logger.warn("Symbol record not found for embedding", { symbolId });
						return;
					}

					// Compose text: name + signature + documentation
					const parts: string[] = [row.name];
					if (row.signature) parts.push(row.signature);
					if (row.documentation) parts.push(row.documentation);
					const text = parts.join(" ").slice(0, CONTENT_TRUNCATE_CHARS);

					const vector = await generateEmbedding(text);
					if (!vector) return;

					await db.query(
						`UPDATE symbol:⟨${symbolId}⟩ SET embedding = $embedding`,
						{ embedding: vector },
					);

					logger.debug("Embedded symbol", { symbolId, name: row.name, dims: vector.length });
				} catch (err) {
					const cause = err instanceof Error ? err.message : String(err);
					logger.warn("Failed to embed symbol", { symbolId, cause });
				}
			}),
		);
	}
}

// ---------------------------------------------------------------------------
// embedRepository — full backfill for a repo
// ---------------------------------------------------------------------------

/**
 * Run the full embedding backfill for a repository.
 *
 * Finds all `file` and `symbol` records belonging to the repo that have
 * `embedding = NONE`, then generates and stores embeddings for them in
 * batches of BATCH_SIZE.
 *
 * Processes records in pages of 100 until no un-embedded records remain,
 * so very large repos are handled without loading everything into memory.
 *
 * Returns counts of how many files and symbols were embedded.
 *
 * @param repoId - Raw repository UUID (without the "repo:" prefix)
 * @returns Object with `files` and `symbols` counts
 */
export async function embedRepository(repoId: string): Promise<{ files: number; symbols: number }> {
	logger.info("Starting embedding backfill", { repoId });

	let totalFiles = 0;
	let totalSymbols = 0;

	// Test Ollama availability with a cheap probe before attempting the full backfill
	const probe = await generateEmbedding("probe");
	if (!probe) {
		logger.warn("Ollama unavailable — skipping embedding backfill", { repoId });
		return { files: 0, symbols: 0 };
	}

	let db: Awaited<ReturnType<typeof getDb>>;
	try {
		db = await getDb();
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		logger.warn("SurrealDB unavailable — skipping embedding backfill", { repoId, cause });
		return { files: 0, symbols: 0 };
	}

	// -------------------------------------------------------------------------
	// Embed files — page through un-embedded records in batches of 100
	// -------------------------------------------------------------------------
	while (true) {
		let fileRows: Array<{ id: string }>;
		try {
			const result = await db.query<[Array<{ id: string }>]>(
				`SELECT id FROM file WHERE embedding = NONE AND repo = repo:⟨${repoId}⟩ LIMIT 100`,
			);
			fileRows = result[0] ?? [];
		} catch (err) {
			const cause = err instanceof Error ? err.message : String(err);
			logger.warn("Failed to query un-embedded files", { repoId, cause });
			break;
		}

		if (fileRows.length === 0) break;

		// Extract the raw ID string from each SurrealDB record ID
		const ids = fileRows.map((r) => extractRawId(r.id));
		await embedFiles(ids);
		totalFiles += ids.length;

		// If we got fewer than 100 results, we've reached the end
		if (fileRows.length < 100) break;
	}

	// -------------------------------------------------------------------------
	// Embed symbols — page through un-embedded records in batches of 100
	// -------------------------------------------------------------------------
	while (true) {
		let symbolRows: Array<{ id: string }>;
		try {
			const result = await db.query<[Array<{ id: string }>]>(
				`SELECT id FROM symbol WHERE embedding = NONE AND repo = repo:⟨${repoId}⟩ LIMIT 100`,
			);
			symbolRows = result[0] ?? [];
		} catch (err) {
			const cause = err instanceof Error ? err.message : String(err);
			logger.warn("Failed to query un-embedded symbols", { repoId, cause });
			break;
		}

		if (symbolRows.length === 0) break;

		const ids = symbolRows.map((r) => extractRawId(r.id));
		await embedSymbols(ids);
		totalSymbols += ids.length;

		if (symbolRows.length < 100) break;
	}

	logger.info("Embedding backfill complete", { repoId, files: totalFiles, symbols: totalSymbols });
	return { files: totalFiles, symbols: totalSymbols };
}

// ---------------------------------------------------------------------------
// Utility: extractRawId
// ---------------------------------------------------------------------------

/**
 * Extract the raw UUID string from a SurrealDB record ID.
 *
 * SurrealDB returns IDs as either a plain string ("file:abc123") or as a
 * structured object depending on the SDK version and query shape. This helper
 * normalises both forms to the plain string that can be interpolated into
 * `table:⟨id⟩` queries.
 *
 * @param id - Raw record ID from SurrealDB query result
 * @returns Plain UUID string
 */
function extractRawId(id: unknown): string {
	if (typeof id === "string") {
		// May come back as "file:abc123" — strip the table prefix
		const colonIdx = id.indexOf(":");
		if (colonIdx !== -1) {
			return id.slice(colonIdx + 1).replace(/^⟨|⟩$/g, "");
		}
		return id;
	}

	// SurrealDB SDK sometimes returns { tb: "file", id: "abc123" }
	if (typeof id === "object" && id !== null && "id" in id) {
		const inner = (id as Record<string, unknown>)["id"];
		if (typeof inner === "string") return inner;
	}

	return String(id);
}
