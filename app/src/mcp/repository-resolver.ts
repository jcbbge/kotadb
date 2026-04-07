/**
 * Repository identifier resolution utilities
 *
 * Supports both UUID and full_name formats for user convenience.
 * All functions are async — they query SurrealDB via getDb().
 */

import { getDb } from "@db/client.js";

/** UUID v4 pattern */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Check if a string is a valid UUID
 */
export function isUUID(value: string): boolean {
	return UUID_PATTERN.test(value);
}

/**
 * Extract the UUID string from a SurrealDB record ID object or string.
 */
function extractId(raw: unknown): string {
	if (raw === null || raw === undefined) return "";
	if (typeof raw === "string") {
		const match = raw.match(/^[^:]+:\u27E8(.+)\u27E9$/);
		if (match) return match[1] ?? raw;
		return raw;
	}
	if (typeof raw === "object") {
		const obj = raw as Record<string, unknown>;
		if (typeof obj["id"] === "string") return obj["id"];
	}
	return String(raw);
}

/**
 * Resolve a repository identifier (UUID or full_name) to a repository ID.
 *
 * @param identifier - Repository UUID or full_name (e.g., "local/kotadb")
 * @returns Repository ID or null if not found
 */
export async function resolveRepositoryParam(
	identifier: string | undefined,
): Promise<string | null> {
	const db = await getDb();

	if (!identifier) {
		// Fall back to most recently created repository
		const [rows] = await db.query<Array<Array<{ id: unknown }>>>(
			"SELECT id, created_at FROM repo ORDER BY created_at DESC LIMIT 1",
		);
		if (!rows || rows.length === 0 || rows[0] === undefined) return null;
		return extractId(rows[0].id);
	}

	// Check if it's a UUID — return as-is without validation
	if (isUUID(identifier)) {
		return identifier;
	}

	// Treat as full_name
	const [rows] = await db.query<Array<Array<{ id: unknown }>>>(
		"SELECT id FROM repo WHERE full_name = $fullName LIMIT 1",
		{ fullName: identifier },
	);
	if (!rows || rows.length === 0 || rows[0] === undefined) return null;
	return extractId(rows[0].id);
}

/**
 * Alias for resolveRepositoryParam for backward compatibility
 */
export const resolveRepositoryIdentifier = resolveRepositoryParam;

/**
 * Resolve a repository identifier with detailed error information.
 *
 * @param identifier - Repository UUID or full_name
 * @returns Object with id (if found) or error message
 */
export async function resolveRepositoryIdentifierWithError(
	identifier: string | undefined,
): Promise<{ id: string } | { error: string }> {
	const db = await getDb();

	if (!identifier) {
		const [rows] = await db.query<Array<Array<{ id: unknown }>>>(
			"SELECT id, created_at FROM repo ORDER BY created_at DESC LIMIT 1",
		);
		if (!rows || rows.length === 0 || rows[0] === undefined) {
			return { error: "No repositories found. Please index a repository first using index_repository tool." };
		}
		return { id: extractId(rows[0].id) };
	}

	// Check if it's a UUID — return as-is without validation
	if (isUUID(identifier)) {
		return { id: identifier };
	}

	// Treat as full_name
	const [rows] = await db.query<Array<Array<{ id: unknown }>>>(
		"SELECT id FROM repo WHERE full_name = $fullName LIMIT 1",
		{ fullName: identifier },
	);
	if (!rows || rows.length === 0 || rows[0] === undefined) {
		return { error: `Repository not found: ${identifier}. Use a valid repository UUID or full_name.` };
	}
	return { id: extractId(rows[0].id) };
}
