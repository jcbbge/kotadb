/**
 * SurrealDB Test Helpers
 *
 * Provides utilities for testing with SurrealDB.
 * Uses production database with test data isolation via naming conventions.
 *
 * @module tests/helpers/surreal
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { getDb, closeDb } from "@db/client.js";
import type { Surreal } from "surrealdb";

/**
 * Get the production database connection for testing.
 */
export async function getTestDb(): Promise<Surreal> {
	return getDb();
}

/**
 * Close the database connection.
 */
export async function closeTestDb(): Promise<void> {
	await closeDb();
}

/**
 * Clear all test data from tables.
 * Deletes records with test-specific identifiers.
 */
export async function clearTestData(): Promise<void> {
	const db = await getDb();

	// Remove test repositories (and their related data via cascade).
	// Covers repos using the 'local/' prefix (local-mode indexing in tests)
	// and any name patterns used across integration test suites.
	await db.query(`
		DELETE FROM repo WHERE full_name CONTAINS 'local/';
		DELETE FROM repo WHERE name CONTAINS 'test-' OR full_name CONTAINS 'test-';
		DELETE FROM repo WHERE name CONTAINS 'snippet-test' OR full_name CONTAINS 'snippet-test';
		DELETE FROM repo WHERE name CONTAINS 'persist-test' OR full_name CONTAINS 'persist-test';
		DELETE FROM file WHERE chunk_count = NONE;
	`);
}

/**
 * Create a test repository record.
 */
export async function createTestRepo(overrides: Partial<{
	id: string;
	name: string;
	full_name: string;
	default_branch: string;
}> = {}): Promise<{ id: string; name: string; full_name: string }> {
	const db = await getDb();

	const id = overrides.id ?? randomUUID();
	const name = overrides.name ?? "test-repo";
	const full_name = overrides.full_name ?? "test-owner/test-repo";
	const default_branch = overrides.default_branch ?? "main";

	await db.query(
		`CREATE repo:${id} CONTENT {
			id: '${id}',
			name: '${name}',
			full_name: '${full_name}',
			default_branch: '${default_branch}',
			created_at: time::now()
		}`
	);

	return { id, name, full_name };
}

/**
 * Create a test file record.
 */
export async function createTestFile(repoId: string, overrides: Partial<{
	id: string;
	path: string;
	content: string;
}> = {}): Promise<{ id: string; path: string }> {
	const db = await getDb();

	const id = overrides.id ?? randomUUID();
	const path = overrides.path ?? "src/test.ts";
	const content = overrides.content ?? "export function test() {}";

	await db.query(
		`CREATE file:\`${id}\` CONTENT {
			id: '${id}',
			repo: repo:\`${repoId}\`,
			path: '${path}',
			content: '${content.replace(/'/g, "\\'")}',
			content_hash: '${randomUUID()}',
			indexed_at: time::now()
		}`
	);

	return { id, path };
}

/**
 * Create a temp directory for test files.
 */
export function createTempDir(prefix = "kotadb-test-"): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Clean up a temp directory.
 */
export function cleanupTempDir(tempDir: string): void {
	rmSync(tempDir, { recursive: true, force: true });
}

/**
 * Query helpers for common test operations.
 */
export const testQueries = {
	async countRepos(): Promise<number> {
		const db = await getDb();
		const result = await db.query<[unknown[]]>("SELECT * FROM repo");
		return result[0]?.length ?? 0;
	},

	async countFiles(): Promise<number> {
		const db = await getDb();
		const result = await db.query<[unknown[]]>("SELECT * FROM file");
		return result[0]?.length ?? 0;
	},

	async getFilesForRepo(repoId: string): Promise<Array<{ id: string; path: string }>> {
		const db = await getDb();
		const result = await db.query<[Array<{ id: string; path: string }>]>(
			`SELECT id, path FROM file WHERE repo = repo:\`${repoId}\``
		);
		return result[0] ?? [];
	},
};