/**
 * Integration tests for index_repository MCP tool
 *
 * Tests actual indexing workflow with filesystem operations.
 * Follows antimocking philosophy - uses real directories and files.
 *
 * Note: Creates test directories within app directory due to workspace
 * security validation in runIndexingWorkflow.
 *
 * @module tests/mcp/index-repository.integration
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { executeIndexRepository } from "@mcp/tools.js";
import { getTestDb, closeTestDb, clearTestData, testQueries } from "../helpers/surreal.js";

describe("index_repository integration tests", () => {
	let testProjectsDir: string;
	const requestId = "test-request";
	const userId = "test-user";

	beforeAll(async () => {
		await getTestDb();

		// Create test projects directory within app directory (workspace requirement)
		testProjectsDir = join(process.cwd(), ".test-projects-mcp");
		if (existsSync(testProjectsDir)) {
			rmSync(testProjectsDir, { recursive: true, force: true });
		}
		mkdirSync(testProjectsDir, { recursive: true });
	});

	afterAll(async () => {
		await closeTestDb();

		// Clean up test projects directory
		if (existsSync(testProjectsDir)) {
			rmSync(testProjectsDir, { recursive: true, force: true });
		}
	});

	beforeEach(async () => {
		await clearTestData();
	});

	afterEach(async () => {
		await clearTestData();
	});

	test("should index local directory and return stats", async () => {
		// Create a test project directory
		const projectDir = join(testProjectsDir, "test-project");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(join(projectDir, "src"), { recursive: true });

		writeFileSync(
			join(projectDir, "src", "index.ts"),
			"export function greet(name: string) { return `Hello, ${name}`; }"
		);

		writeFileSync(
			join(projectDir, "src", "utils.ts"),
			"export const VERSION = '1.0.0';"
		);

		const result = await executeIndexRepository(
			{
				repository: "test-project",
				localPath: projectDir,
			},
			requestId,
			userId
		) as { status: string; repositoryId: string; stats: { files_indexed: number; symbols_extracted: number } };

		expect(result.status).toBe("completed");
		expect(result.repositoryId).toBeDefined();
		expect(result.stats.files_indexed).toBeGreaterThanOrEqual(2);
		expect(result.stats.symbols_extracted).toBeGreaterThan(0);
	});

	test("should handle empty directory gracefully", async () => {
		const emptyDir = join(testProjectsDir, "empty-project");
		mkdirSync(emptyDir, { recursive: true });

		const result = await executeIndexRepository(
			{
				repository: "empty-project",
				localPath: emptyDir,
			},
			requestId,
			userId
		) as { status: string; stats: { files_indexed: number } };

		expect(result.status).toBe("completed");
		expect(result.stats.files_indexed).toBe(0);
	});

	test("should persist files to SurrealDB", async () => {
		const projectDir = join(testProjectsDir, "persist-test");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(
			join(projectDir, "main.ts"),
			"export const APP = 'test';"
		);

		const result = await executeIndexRepository(
			{
				repository: "persist-test",
				localPath: projectDir,
			},
			requestId,
			userId
		) as { repositoryId: string };

		// Verify file was stored in SurrealDB
		const files = await testQueries.getFilesForRepo(result.repositoryId);

		expect(files.length).toBeGreaterThan(0);
		expect(files.some((f) => f.path.includes("main.ts"))).toBe(true);
	});

	test("should default ref to main if not provided", async () => {
		const projectDir = join(testProjectsDir, "ref-test");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(projectDir, "test.ts"), "export {}");

		const result = await executeIndexRepository(
			{
				repository: "ref-test",
				localPath: projectDir,
			},
			requestId,
			userId
		) as { status: string };

		// Should complete without error even without ref param
		expect(result.status).toBe("completed");
	});
});
