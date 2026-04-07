#!/usr/bin/env bun
/**
 * KotaDB CLI Entry Point
 *
 * Provides command-line interface for running the KotaDB MCP server.
 * Designed for use with `npx kotadb` or `bunx kotadb`.
 *
 * Usage:
 *   kotadb              Start the MCP server (default port 3000)
 *   kotadb --stdio      Start in stdio mode (for Claude Code integration)
 *   kotadb --port 4000  Start on custom port
 *   kotadb --toolset full  Select tool tier (default, core, memory, full)
 *   kotadb --version    Show version
 *   kotadb --help       Show help
 *   kotadb deps         Query dependency information for a file
 */

import { createExpressApp } from "@api/routes";
import { getEnvironmentConfig } from "@config/environment";
import { createLogger } from "@logging/logger";
import { createMcpServer, type McpServerContext } from "@mcp/server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Valid toolset tiers for MCP tool selection
 * - default: 8 tools (core + sync)
 * - core: 6 tools
 * - memory: 14 tools (core + sync + memory)
 * - full: 20 tools (all)
 */
export type ToolsetTier = "default" | "core" | "memory" | "full";

const VALID_TOOLSET_TIERS: ToolsetTier[] = ["default", "core", "memory", "full"];

interface CliOptions {
  port: number;
  help: boolean;
  version: boolean;
  stdio: boolean;
  toolset: ToolsetTier;
}

function getVersion(): string {
  try {
    const packageJsonPath = join(__dirname, "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    return packageJson.version || "unknown";
  } catch {
    return "unknown";
  }
}

function printHelp(): void {
  const version = getVersion();
  process.stdout.write(`
kotadb v${version} - Local code intelligence for CLI agents

USAGE:
  kotadb [OPTIONS]
  kotadb deps [OPTIONS]
  kotadb expertise [OPTIONS]

COMMANDS:
  deps              Query dependency information for a file
                    Options:
                      --file, -f <path>     Target file to analyze (required)
                      --format json|text    Output format (default: text)
                      --depth, -d <n>       Dependency traversal depth 1-5 (default: 1)
                      --include-tests       Include test files in output
                      --repository, -r <id> Repository ID or full_name

  expertise         Manage expert domain knowledge
                    Subcommands:
                      sync --domain <d>     Sync patterns to database
                      validate --domain <d> Check for stale patterns
                      key-files --domain <d> List key files with dependents

OPTIONS:
  --stdio           REMOVED - Use HTTP transport to http://localhost:3099/mcp
  --port <number>   Port to listen on (default: 3000, env: PORT)
  --toolset <tier>  Select tool tier (default: default)
                    Tiers:
                      default  8 tools (core + sync)
                      core     6 tools (search, index, deps, impact)
                      memory   14 tools (core + sync + memory layer)
                      full     20 tools (all available tools)
  --version, -v     Show version number
  --help, -h        Show this help message

ENVIRONMENT VARIABLES:
  PORT              Server port (default: 3000, HTTP mode only)
  KOTA_DB_PATH      (deprecated) Legacy DB path — ignored, SurrealDB is used
  KOTA_ALLOWED_ORIGINS  Comma-separated allowed CORS origins
  LOG_LEVEL         Logging level: debug, info, warn, error (default: info)

EXAMPLES:
  kotadb --stdio                              Start in stdio mode (for Claude Code)
  kotadb --stdio --toolset full               Start with all tools enabled
  kotadb --stdio --toolset core               Start with minimal core tools
  kotadb                                      Start HTTP server on port 3000
  kotadb --port 4000                          Start HTTP server on port 4000
  kotadb deps --file src/db/client.ts         Query deps for a file (text)
  kotadb deps --file src/db/client.ts --format json   Query deps (JSON)
  kotadb deps -f src/api/routes.ts -d 2       Query deps with depth 2

MCP CONFIGURATION (stdio mode - RECOMMENDED):
  Add to your .mcp.json or Claude Code settings:

  {
    "mcpServers": {
      "kotadb": {
        "command": "bunx",
        "args": ["kotadb@next", "--stdio"]
      }
    }
  }

  With toolset selection:

  {
    "mcpServers": {
      "kotadb": {
        "command": "bunx",
        "args": ["kotadb@next", "--stdio", "--toolset", "full"]
      }
    }
  }

MCP CONFIGURATION (HTTP mode - legacy):
  Add to your .mcp.json or Claude Code settings:

  {
    "mcpServers": {
      "kotadb": {
        "type": "http",
        "url": "http://localhost:3000/mcp",
        "headers": {
          "Accept": "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-06-18"
        }
      }
    }
  }

DOCUMENTATION:
  https://github.com/jayminwest/kotadb

`);
}

function printVersion(): void {
  const version = getVersion();
  process.stdout.write(`kotadb v${version}\n`);
}

function isValidToolsetTier(value: string): value is ToolsetTier {
  return VALID_TOOLSET_TIERS.includes(value as ToolsetTier);
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    port: Number(process.env.PORT ?? 3000),
    help: false,
    version: false,
    stdio: false,
    toolset: "default",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;

    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--version" || arg === "-v") {
      options.version = true;
    } else if (arg === "--stdio") {
      options.stdio = true;
    } else if (arg === "--port") {
      const portStr = args[++i];
      if (!portStr || Number.isNaN(Number(portStr))) {
        process.stderr.write("Error: --port requires a valid number\n");
        process.exit(1);
      }
      options.port = Number(portStr);
    } else if (arg.startsWith("--port=")) {
      const portStr = arg.split("=")[1];
      if (portStr === undefined || Number.isNaN(Number(portStr))) {
        process.stderr.write("Error: --port requires a valid number\n");
        process.exit(1);
      }
      options.port = Number(portStr);
    } else if (arg === "--toolset") {
      const tierStr = args[++i];
      if (!tierStr) {
        process.stderr.write("Error: --toolset requires a tier value\n");
        process.stderr.write("Valid tiers: default, core, memory, full\n");
        process.exit(1);
      }
      if (!isValidToolsetTier(tierStr)) {
        process.stderr.write(`Error: Invalid toolset tier '${tierStr}'\n`);
        process.stderr.write("Valid tiers: default, core, memory, full\n");
        process.exit(1);
      }
      options.toolset = tierStr;
    } else if (arg.startsWith("--toolset=")) {
      const tierStr = arg.split("=")[1];
      if (tierStr === undefined || tierStr === "") {
        process.stderr.write("Error: --toolset requires a tier value\n");
        process.stderr.write("Valid tiers: default, core, memory, full\n");
        process.exit(1);
      }
      if (!isValidToolsetTier(tierStr)) {
        process.stderr.write(`Error: Invalid toolset tier '${tierStr}'\n`);
        process.stderr.write("Valid tiers: default, core, memory, full\n");
        process.exit(1);
      }
      options.toolset = tierStr;
    } else if (arg.startsWith("-") && arg !== "-") {
      process.stderr.write(`Unknown option: ${arg}\n`);
      process.stderr.write("Use --help for usage information\n");
      process.exit(1);
    }
  }

  return options;
}


async function main(): Promise<void> {
  // Parse command line arguments (skip first two: bun/node and script path)
  let args = process.argv.slice(2);

  // Handle 'bun run cli.ts' case where script path is included
  if (args[0]?.endsWith("cli.ts")) {
    args = args.slice(1);
  }

  // Check for subcommands first
  const firstArg = args[0];
  if (firstArg === "deps") {
    // Handle deps subcommand
    const { runDepsCommand } = await import("./cli/deps.js");
    await runDepsCommand(args.slice(1));
    return;
  }

  if (firstArg === "expertise") {
    // Handle expertise subcommand
    const { runExpertiseCommand } = await import("./cli/expertise.js");
    await runExpertiseCommand(args.slice(1));
    return;
  }

  const options = parseArgs(args);

  // Handle --version
  if (options.version) {
    printVersion();
    process.exit(0);
  }

  // Handle --help
  if (options.help) {
    printHelp();
    process.exit(0);
  }

	// Stdio mode removed - HTTP daemon only to prevent orphaned processes
	if (options.stdio) {
		process.stderr.write("Error: --stdio mode has been removed. Use HTTP transport instead.\\n");
		process.stderr.write("The Kotadb daemon runs on http://localhost:3099/mcp\\n");
		process.exit(1);
	}

  // Start server in HTTP mode
  const logger = createLogger();
  const envConfig = getEnvironmentConfig();

  logger.info("KotaDB starting", {
    version: getVersion(),
    mode: envConfig.mode,
    port: options.port,
    localDbPath: envConfig.localDbPath,
    toolset: options.toolset,
  });

  const app = createExpressApp();

  const server = app.listen(options.port, () => {
    logger.info("KotaDB server started", {
      port: options.port,
      mcp_endpoint: `http://localhost:${options.port}/mcp`,
      health_endpoint: `http://localhost:${options.port}/health`,
      toolset: options.toolset,
    });

    // Print user-friendly startup message
    process.stdout.write(`\n`);
    process.stdout.write(`KotaDB v${getVersion()} running\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`  MCP Endpoint:    http://localhost:${options.port}/mcp\n`);
    process.stdout.write(`  Health Check:    http://localhost:${options.port}/health\n`);
    process.stdout.write(`  Database:        ${envConfig.localDbPath}\n`);
    process.stdout.write(`  Toolset:         ${options.toolset}\n`);
    process.stdout.write(`\n`);
    process.stdout.write(`Press Ctrl+C to stop\n`);
    process.stdout.write(`\n`);
  });

  // Graceful shutdown handlers
  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down gracefully`);
    server.close(() => {
      logger.info("Server closed");
      process.exit(0);
    });

    // Force exit after 10 seconds
    setTimeout(() => {
      logger.warn("Forced shutdown after timeout");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Global error handlers
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("Unhandled promise rejection", reason instanceof Error ? reason : undefined);
  });

  process.on("uncaughtException", (error: Error) => {
    logger.error("Uncaught exception", error);
    process.exit(1);
  });
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error.message}\n`);
  process.exit(1);
});
