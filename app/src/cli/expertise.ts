/**
 * CLI expertise command implementation
 *
 * Manages expertise.yaml files for expert domains.
 *
 * Usage:
 *   kotadb expertise sync --domain <domain>
 *   kotadb expertise validate --domain <domain>
 *   kotadb expertise key-files --domain <domain>
 *
 * @module cli/expertise
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { getDb } from "@db/client.js";
import { resolveRepositoryIdentifierWithError } from "@mcp/repository-resolver";
import { queryDependents, resolveFilePath } from "@api/queries";

export interface ExpertiseOptions {
	subcommand: "sync" | "validate" | "key-files";
	domain?: string;
	help?: boolean;
}

interface KeyFileEntry {
	path: string;
	purpose: string;
	exports?: string;
	patterns?: string;
}

interface ExpertiseYaml {
	overview?: {
		description?: string;
		scope?: string;
		rationale?: string;
	};
	core_implementation?: {
		key_files?: KeyFileEntry[];
	};
	key_operations?: Record<string, {
		when?: string;
		approach?: string;
		pattern?: string;
		timestamp?: string;
		evidence?: string;
		rationale?: string;
	}>;
	patterns?: Record<string, {
		structure?: string;
		notes?: string[];
		timestamp?: string;
		evidence?: string;
	}>;
	best_practices?: Record<string, string>;
	known_issues?: Array<{
		issue: string;
		impact?: string;
		status?: string;
		resolution?: string;
	}>;
}

const EXPERTS_BASE_PATH = ".claude/agents/experts";
const VALID_DOMAINS = [
	"api",
	"agent-authoring",
	"automation",
	"claude-config",
	"database",
	"documentation",
	"github",
	"indexer",
	"testing",
];

/**
 * Print expertise command help
 */
function printExpertiseHelp(): void {
	const help = `
kotadb expertise - Manage expert domain knowledge

USAGE:
  kotadb expertise <subcommand> [OPTIONS]

SUBCOMMANDS:
  sync          Sync patterns from expertise.yaml to database
  validate      Validate expertise.yaml patterns for staleness
  key-files     List key files with dependent counts

OPTIONS:
  --domain, -d <name>   Expert domain to operate on (required)
  --help, -h            Show this help message

AVAILABLE DOMAINS:
  api             HTTP endpoints, MCP tools, Express patterns
  agent-authoring Agent creation, frontmatter, tools, registry
  automation      ADW workflows, agent orchestration
  claude-config   .claude/ configuration (commands, hooks, settings)
  database        SurrealDB schema, migrations, queries
  documentation   Documentation management, content organization
  github          Issues, PRs, branches, GitHub CLI workflows
  indexer         AST parsing, symbol extraction, code analysis
  testing         Antimocking, Bun tests, SurrealDB test patterns

EXAMPLES:
  kotadb expertise sync --domain database
  kotadb expertise validate --domain api
  kotadb expertise key-files --domain indexer
  kotadb expertise key-files -d testing

`;
	process.stdout.write(help);
}

/**
 * Parse expertise command arguments
 */
export function parseExpertiseArgs(args: string[]): ExpertiseOptions | { error: string } | { help: true } {
	if (args.length === 0) {
		return { help: true };
	}

	const subcommand = args[0];
	if (subcommand === "--help" || subcommand === "-h") {
		return { help: true };
	}

	if (!["sync", "validate", "key-files"].includes(subcommand as string)) {
		return { error: "Error: Unknown subcommand: " + subcommand + ". Use sync, validate, or key-files." };
	}

	const options: ExpertiseOptions = {
		subcommand: subcommand as "sync" | "validate" | "key-files",
	};

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		if (arg === undefined) continue;

		if (arg === "--help" || arg === "-h") {
			return { help: true };
		} else if (arg === "--domain" || arg === "-d") {
			const value = args[++i];
			if (!value || value.startsWith("-")) {
				return { error: "Error: --domain requires a domain name" };
			}
			options.domain = value;
		} else if (arg.startsWith("--domain=")) {
			const value = arg.split("=")[1];
			if (!value) {
				return { error: "Error: --domain requires a domain name" };
			}
			options.domain = value;
		} else if (arg.startsWith("-") && arg !== "-") {
			return { error: "Error: Unknown option: " + arg };
		}
	}

	if (!options.domain) {
		return { error: "Error: --domain is required" };
	}

	if (!VALID_DOMAINS.includes(options.domain)) {
		return { error: "Error: Unknown domain: " + options.domain + ". Valid domains: " + VALID_DOMAINS.join(", ") };
	}

	return options;
}

/**
 * Find project root by looking for .git directory
 */
function findProjectRoot(): string {
	let current = process.cwd();
	while (current !== "/") {
		if (existsSync(join(current, ".git"))) {
			return current;
		}
		current = resolve(current, "..");
	}
	return process.cwd();
}

/**
 * Load expertise.yaml for a domain
 */
function loadExpertiseYaml(domain: string): ExpertiseYaml | { error: string } {
	const projectRoot = findProjectRoot();
	const expertisePath = join(projectRoot, EXPERTS_BASE_PATH, domain, "expertise.yaml");

	if (!existsSync(expertisePath)) {
		return { error: "Expertise file not found: " + expertisePath };
	}

	try {
		const content = readFileSync(expertisePath, "utf-8");
		return parseYaml(content) as ExpertiseYaml;
	} catch (err) {
		return { error: "Failed to parse expertise.yaml: " + (err instanceof Error ? err.message : String(err)) };
	}
}

/**
 * Execute sync subcommand
 */
async function executeSync(domain: string): Promise<{ success: boolean; message: string; count?: number }> {
	const expertise = loadExpertiseYaml(domain);
	if ("error" in expertise) {
		return { success: false, message: expertise.error };
	}

	const db = await getDb();
	let syncedCount = 0;

	if (expertise.key_operations) {
		for (const [name, op] of Object.entries(expertise.key_operations)) {
			const title = domain + ":" + name;
			const context = op.when || "";
			const decision = op.approach || op.pattern || "";
			const rationale = op.rationale || "";

			const [existing] = await db.query<Array<Array<{ id: unknown }>>>(
				"SELECT id FROM decision WHERE title = $title AND scope = 'pattern' LIMIT 1",
				{ title },
			);

			if (existing && existing.length > 0 && existing[0] !== undefined) {
				const rawId =
					typeof existing[0].id === "object" && existing[0].id !== null
						? ((existing[0].id as Record<string, unknown>)["id"] as string | undefined) ?? String(existing[0].id)
						: String(existing[0].id);
				await db.query(
					`UPDATE decision:\u27E8${rawId}\u27E9 SET context = $context, decision = $decision, rationale = $rationale, updated_at = time::now()`,
					{ context, decision, rationale },
				);
			} else {
				const id = randomUUID();
				await db.query(
					`INSERT INTO decision (id, title, context, decision, scope, rationale, created_at, updated_at)
					 VALUES ($id, $title, $context, $decision, 'pattern', $rationale, time::now(), time::now())`,
					{ id, title, context, decision, rationale },
				);
			}
			syncedCount++;
		}
	}

	if (expertise.patterns) {
		for (const [name, pattern] of Object.entries(expertise.patterns)) {
			const title = domain + ":pattern:" + name;
			const context = pattern.notes?.join("\n") || "";
			const decision = pattern.structure || "";

			const [existing] = await db.query<Array<Array<{ id: unknown }>>>(
				"SELECT id FROM decision WHERE title = $title AND scope = 'convention' LIMIT 1",
				{ title },
			);

			if (existing && existing.length > 0 && existing[0] !== undefined) {
				const rawId =
					typeof existing[0].id === "object" && existing[0].id !== null
						? ((existing[0].id as Record<string, unknown>)["id"] as string | undefined) ?? String(existing[0].id)
						: String(existing[0].id);
				await db.query(
					`UPDATE decision:\u27E8${rawId}\u27E9 SET context = $context, decision = $decision, updated_at = time::now()`,
					{ context, decision },
				);
			} else {
				const id = randomUUID();
				await db.query(
					`INSERT INTO decision (id, title, context, decision, scope, created_at, updated_at)
					 VALUES ($id, $title, $context, $decision, 'convention', time::now(), time::now())`,
					{ id, title, context, decision },
				);
			}
			syncedCount++;
		}
	}

	if (expertise.known_issues) {
		for (const issue of expertise.known_issues) {
			const searchTerm = issue.issue.substring(0, 50);

			const [existingRows] = await db.query<Array<Array<{ id: unknown }>>>(
				"SELECT id FROM insight WHERE content ~ $searchTerm LIMIT 1",
				{ searchTerm },
			);

			if (!existingRows || existingRows.length === 0) {
				const content = "[" + domain + "] " + issue.issue + "\nImpact: " + (issue.impact || "Unknown") + "\nStatus: " + (issue.status || "Unknown") + "\nResolution: " + (issue.resolution || "None");
				const insightType = issue.status === "resolved" ? "workaround" : "discovery";
				const id = randomUUID();
				await db.query(
					"INSERT INTO insight (id, content, insight_type, created_at) VALUES ($id, $content, $insightType, time::now())",
					{ id, content, insightType },
				);
				syncedCount++;
			}
		}
	}

	return {
		success: true,
		message: "Synced " + syncedCount + " patterns from " + domain + " expertise",
		count: syncedCount,
	};
}

/**
 * Execute validate subcommand
 */
function executeValidate(domain: string): { success: boolean; message: string; results?: Array<{ name: string; status: string; lastUpdated: string }> } {
	const expertise = loadExpertiseYaml(domain);
	if ("error" in expertise) {
		return { success: false, message: expertise.error };
	}

	const results: Array<{ name: string; status: string; lastUpdated: string }> = [];
	const now = new Date();
	const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);

	if (expertise.key_operations) {
		for (const [name, op] of Object.entries(expertise.key_operations)) {
			let status = "valid";
			const timestamp = op.timestamp || "unknown";

			if (timestamp === "unknown") {
				status = "no-date";
			} else {
				const opDate = new Date(timestamp);
				if (opDate < sixMonthsAgo) {
					status = "stale";
				}
			}

			results.push({ name, status, lastUpdated: timestamp });
		}
	}

	if (expertise.patterns) {
		for (const [name, pattern] of Object.entries(expertise.patterns)) {
			let status = "valid";
			const timestamp = pattern.timestamp || "unknown";

			if (timestamp === "unknown") {
				status = "no-date";
			} else {
				const patternDate = new Date(timestamp);
				if (patternDate < sixMonthsAgo) {
					status = "stale";
				}
			}

			results.push({ name: "pattern:" + name, status, lastUpdated: timestamp });
		}
	}

	const staleCount = results.filter((r) => r.status === "stale").length;
	const noDateCount = results.filter((r) => r.status === "no-date").length;
	const validCount = results.filter((r) => r.status === "valid").length;

	return {
		success: true,
		message: "Validated " + results.length + " patterns: " + validCount + " valid, " + staleCount + " stale, " + noDateCount + " missing date",
		results,
	};
}

/**
 * Execute key-files subcommand
 */
async function executeKeyFiles(domain: string): Promise<{ success: boolean; message: string; results?: Array<{ path: string; dependents: number; purpose: string }> }> {
	const expertise = loadExpertiseYaml(domain);
	if ("error" in expertise) {
		return { success: false, message: expertise.error };
	}

	const keyFiles = expertise.core_implementation?.key_files;
	if (!keyFiles || keyFiles.length === 0) {
		return { success: false, message: "No key files defined in " + domain + " expertise.yaml" };
	}

	const results: Array<{ path: string; dependents: number; purpose: string }> = [];

	const repoResult = await resolveRepositoryIdentifierWithError(undefined);
	const hasRepo = !("error" in repoResult);
	const repositoryId = hasRepo ? (repoResult as { id: string }).id : null;

	for (const file of keyFiles) {
		let dependentCount = 0;

		if (repositoryId) {
			const fileId = await resolveFilePath(file.path, repositoryId);
			if (fileId) {
				const dependents = await queryDependents(fileId, 1, false);
				dependentCount = dependents.direct.length;
			}
		}

		results.push({
			path: file.path,
			dependents: dependentCount,
			purpose: file.purpose || "No purpose specified",
		});
	}

	results.sort((a, b) => b.dependents - a.dependents);

	return {
		success: true,
		message: "Found " + results.length + " key files in " + domain + " expertise",
		results,
	};
}

/**
 * Format validation results as table
 */
function formatValidationTable(results: Array<{ name: string; status: string; lastUpdated: string }>): string {
	const lines: string[] = [];
	const nameWidth = Math.max(20, ...results.map((r) => r.name.length));

	lines.push("Pattern".padEnd(nameWidth) + "  " + "Status".padEnd(10) + "  " + "Last Updated");
	lines.push("-".repeat(nameWidth + 30));

	for (const result of results) {
		const statusDisplay = result.status === "valid" ? "valid" : result.status === "stale" ? "STALE" : "NO DATE";
		lines.push(result.name.padEnd(nameWidth) + "  " + statusDisplay.padEnd(10) + "  " + result.lastUpdated);
	}

	return lines.join("\n");
}

/**
 * Format key files results as table
 */
function formatKeyFilesTable(results: Array<{ path: string; dependents: number; purpose: string }>): string {
	const lines: string[] = [];
	const pathWidth = Math.max(35, ...results.map((r) => r.path.length));

	lines.push("File".padEnd(pathWidth) + "  " + "Dependents".padEnd(10) + "  " + "Purpose");
	lines.push("-".repeat(pathWidth + 60));

	for (const result of results) {
		const purposeTruncated = result.purpose.length > 40 ? result.purpose.substring(0, 37) + "..." : result.purpose;
		lines.push(result.path.padEnd(pathWidth) + "  " + String(result.dependents).padEnd(10) + "  " + purposeTruncated);
	}

	return lines.join("\n");
}

/**
 * Run expertise command
 */
export function runExpertiseCommand(args: string[]): void {
	const parseResult = parseExpertiseArgs(args);

	if ("help" in parseResult && parseResult.help) {
		printExpertiseHelp();
		process.exit(0);
	}

	if ("error" in parseResult) {
		process.stderr.write(parseResult.error + "\n");
		process.stderr.write("Usage: kotadb expertise <sync|validate|key-files> --domain <domain>\n");
		process.exit(1);
	}

	const { subcommand, domain } = parseResult as ExpertiseOptions;

	if (!domain) {
		process.stderr.write("Error: --domain is required\n");
		process.exit(1);
	}

	// executeSync and executeKeyFiles are now async; executeValidate is still sync
	const runAsync = async (): Promise<void> => {
		let result: { success: boolean; message: string; results?: unknown };

		switch (subcommand) {
			case "sync":
				result = await executeSync(domain);
				break;
			case "validate":
				result = executeValidate(domain);
				break;
			case "key-files":
				result = await executeKeyFiles(domain);
				break;
		}

		if (!result.success) {
			process.stderr.write(result.message + "\n");
			process.exit(1);
		}

		process.stdout.write(result.message + "\n");

		if (subcommand === "validate" && result.results) {
			process.stdout.write("\n");
			process.stdout.write(formatValidationTable(result.results as Array<{ name: string; status: string; lastUpdated: string }>) + "\n");
		}

		if (subcommand === "key-files" && result.results) {
			process.stdout.write("\n");
			process.stdout.write(formatKeyFilesTable(result.results as Array<{ path: string; dependents: number; purpose: string }>) + "\n");
		}
	};

	runAsync().catch((err: unknown) => {
		process.stderr.write((err instanceof Error ? err.message : String(err)) + "\n");
		process.exit(1);
	});
}
