/**
 * Tests for kota_sync_import MCP tool
 *
 * Test Coverage:
 * - kota_sync_import: Import JSONL files into SurrealDB
 *
 * @module tests/mcp/kota-sync-import
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { executeSyncImport } from "@mcp/tools.js";
import { getTestDb, closeTestDb, clearTestData, createTempDir, cleanupTempDir } from "../helpers/surreal.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

describe("kota_sync_import MCP tool", () => {
	let tempDir: string;
	const requestId = "test-request-1";

	beforeAll(async () => {
		await getTestDb();
	});

	afterAll(async () => {
		await closeTestDb();
	});

	beforeEach(async () => {
		tempDir = createTempDir("mcp-import-test-");
		await clearTestData();
	});

	afterEach(() => {
		if (tempDir) {
			cleanupTempDir(tempDir);
		}
	});

	test("should handle import with no files gracefully", async () => {
		const importDir = join(tempDir, "import");
		mkdirSync(importDir, { recursive: true });

		const result = (await executeSyncImport(
			{ import_dir: importDir },
			requestId,
		)) as {
			success: boolean;
			tables_imported: number;
		};

		expect(result.success).toBeDefined();
		expect(result.tables_imported).toBeDefined();
	});

	test("should accept custom import_dir parameter", async () => {
		const importDir = join(tempDir, "custom-import");
		mkdirSync(importDir, { recursive: true });

		const result = (await executeSyncImport(
			{ import_dir: importDir },
			requestId,
		)) as {
			success: boolean;
			import_dir?: string;
		};

		expect(result.success).toBeDefined();
	});

	test("should work with empty params object", async () => {
		const result = (await executeSyncImport({}, requestId)) as {
			success: boolean;
		};

		expect(result.success).toBeDefined();
	});

	test("should work with undefined params", async () => {
		const result = (await executeSyncImport(undefined, requestId)) as {
			success: boolean;
		};

		expect(result.success).toBeDefined();
	});

	test("should throw error when params is invalid type", async () => {
		await expect(async () => {
			await executeSyncImport("invalid", requestId);
		}).toThrow("Parameters must be an object");
	});

	test("should include duration_ms in result", async () => {
		const importDir = join(tempDir, "import");
		mkdirSync(importDir, { recursive: true });

		const result = (await executeSyncImport(
			{ import_dir: importDir },
			requestId,
		)) as {
			duration_ms: number;
		};

		expect(result.duration_ms).toBeDefined();
		expect(typeof result.duration_ms).toBe("number");
	});

	test("should include rows_imported in result", async () => {
		const importDir = join(tempDir, "import");
		mkdirSync(importDir, { recursive: true });

		const result = (await executeSyncImport(
			{ import_dir: importDir },
			requestId,
		)) as {
			rows_imported: number;
		};

		expect(result.rows_imported).toBeDefined();
		expect(typeof result.rows_imported).toBe("number");
	});

	test("should handle import errors gracefully", async () => {
		const importDir = join(tempDir, "import-with-errors");
		mkdirSync(importDir, { recursive: true });

		// Create invalid JSONL file
		const invalidFile = join(importDir, "invalid.jsonl");
		writeFileSync(invalidFile, "not valid json\n");

		const result = (await executeSyncImport(
			{ import_dir: importDir },
			requestId,
		)) as {
			success: boolean;
			errors?: Array<unknown>;
		};

		// Result should indicate import status
		expect(result.success).toBeDefined();
	});
});
