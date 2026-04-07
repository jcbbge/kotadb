/**
 * SurrealDB client for KotaDB.
 *
 * Connects to ws://127.0.0.1:8002/rpc (or SURREAL_URL env).
 * Namespace: kotadb, Database: index (or SURREAL_NS / SURREAL_DB env).
 */

import { Surreal } from "surrealdb";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Config — read from env with hardcoded defaults
// ---------------------------------------------------------------------------

const SURREAL_URL = process.env["SURREAL_URL"] ?? "ws://127.0.0.1:8002/rpc";
const SURREAL_NS  = process.env["SURREAL_NS"]  ?? "kotadb";
const SURREAL_DB  = process.env["SURREAL_DB"]  ?? "index";
const SURREAL_USER = process.env["SURREAL_USER"] ?? "root";
const SURREAL_PASS = process.env["SURREAL_PASS"] ?? "root";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

let _db: Surreal | null = null;
let _connecting: Promise<Surreal> | null = null;

// ---------------------------------------------------------------------------
// getDb — lazy singleton, returns a connected Surreal instance
// ---------------------------------------------------------------------------

/**
 * Returns the connected SurrealDB singleton instance.
 *
 * Lazy-connects on first call. Subsequent calls return the cached instance.
 *
 * @throws Error if SurrealDB is not running or connection fails.
 */
export async function getDb(): Promise<Surreal> {
	if (_db !== null) {
		return _db;
	}

	// Deduplicate concurrent callers — only one connect() race at a time.
	if (_connecting !== null) {
		return _connecting;
	}

	_connecting = (async (): Promise<Surreal> => {
		const db = new Surreal();

		try {
			await db.connect(SURREAL_URL, {
				namespace: SURREAL_NS,
				database: SURREAL_DB,
				authentication: {
					username: SURREAL_USER,
					password: SURREAL_PASS,
				},
			});
		} catch (err) {
			_connecting = null;
			const cause = err instanceof Error ? err.message : String(err);
			throw new Error(
				`KotaDB: Cannot connect to SurrealDB at ${SURREAL_URL}.\n` +
				`  Cause: ${cause}\n\n` +
				`  SurrealDB not running. Start with:\n` +
				`    surreal start --bind 127.0.0.1:8002 --user root --pass root file://~/.kotadb/surreal.db`,
			);
		}

		_db = db;
		_connecting = null;
		return db;
	})();

	return _connecting;
}

// ---------------------------------------------------------------------------
// initializeSchema — reads schema.surql and executes it against the database
// ---------------------------------------------------------------------------

/**
 * Reads and executes the SurrealDB schema against the connected database.
 *
 * Safe to call multiple times — DEFINE statements in SurrealDB are idempotent
 * when written without IF NOT EXISTS (they overwrite, not error).
 */
export async function initializeSchema(): Promise<void> {
	const db = await getDb();

	// Resolve schema path relative to this source file so it works regardless
	// of cwd.
	const __filename = fileURLToPath(import.meta.url);
	const __dirname  = dirname(__filename);
	const schemaPath = resolve(__dirname, "schema.surql");

	let schemaSql: string;
	try {
		schemaSql = readFileSync(schemaPath, "utf-8");
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		throw new Error(
			`KotaDB: Failed to read schema file at ${schemaPath}.\n  Cause: ${cause}`,
		);
	}

	try {
		await db.query(schemaSql);
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		throw new Error(
			`KotaDB: Failed to apply schema against SurrealDB.\n  Cause: ${cause}`,
		);
	}
}

// ---------------------------------------------------------------------------
// closeDb — clean shutdown
// ---------------------------------------------------------------------------

/**
 * Closes the active SurrealDB connection and clears the singleton.
 * Safe to call if no connection is open.
 */
export async function closeDb(): Promise<void> {
	if (_db !== null) {
		await _db.close();
		_db = null;
	}
	_connecting = null;
}
