/**
 * Database queries for Dynamic Expertise feature
 *
 * SurrealDB query layer implementation.
 * All public functions are now async; callers must await them.
 *
 * Provides domain-specific file discovery based on dependency graph analysis.
 * Key files are identified by how many other files depend on them (dependents).
 *
 * @module @api/expertise-queries
 */

import { getDb } from "@db/client.js";
import { createLogger } from "@logging/logger.js";

const logger = createLogger({ module: "expertise-queries" });

/**
 * Build a SurrealDB record ID string.
 */
function rid(table: string, id: string): string {
  return `${table}:\u27E8${id}\u27E9`;
}

/**
 * Domain to path pattern mappings for expertise routing.
 *
 * Each domain maps to an array of glob-style prefix patterns that identify
 * files belonging to that domain within the repository.
 *
 * In SurrealQL these are matched with the string::starts_with() function
 * or the LIKE operator. We store both the pattern string and a SurrealQL
 * LIKE-compatible pattern (% suffix) for each entry.
 */
export const DOMAIN_PATH_PATTERNS: Record<string, string[]> = {
  "database": [
    "src/db/%",
    "app/src/db/%",
  ],
  "api": [
    "src/api/%",
    "src/mcp/%",
    "app/src/api/%",
    "app/src/mcp/%",
  ],
  "indexer": [
    "src/indexer/%",
    "app/src/indexer/%",
  ],
  "testing": [
    "tests/%",
    "app/tests/%",
    "__tests__/%",
  ],
  "claude-config": [
    ".claude/%",
  ],
  "agent-authoring": [
    ".claude/agents/%",
  ],
  "automation": [
    ".claude/commands/automation/%",
  ],
  "github": [
    ".github/%",
  ],
  "documentation": [
    "web/docs/%",
    "docs/%",
  ],
};

/**
 * Result type for domain key files query
 */
export interface DomainKeyFile {
  /** File path relative to repository root */
  path: string;
  /** Number of files that depend on this file */
  dependentCount: number;
  /** Repository ID the file belongs to */
  repositoryId: string;
}

/**
 * Build a SurrealQL WHERE clause fragment for LIKE-based path pattern matching.
 *
 * Returns a string like:
 *   `path LIKE 'src/db/%' OR path LIKE 'app/src/db/%'`
 *
 * SurrealDB supports SQL-style LIKE with % wildcards.
 */
function buildPathLikeClause(patterns: string[]): string {
  return patterns
    .map((p) => `path LIKE '${p.replace(/'/g, "''")}'`)
    .join(" OR ");
}

/**
 * Get the most-depended-on files for a domain (key files).
 *
 * Key files are identified by counting how many other files import them
 * (inbound `imports` graph edges). This identifies the core infrastructure
 * files for each domain.
 *
 * @param domain - Domain name (e.g., "database", "api", "indexer")
 * @param limit - Maximum number of files to return (default: 10)
 * @param repositoryId - Optional repository filter
 * @returns Array of key files sorted by dependent count (descending)
 *
 * @example
 * ```ts
 * const keyFiles = await getDomainKeyFiles("database", 5);
 * // Returns top 5 most-imported files from src/db/
 * ```
 */
export async function getDomainKeyFiles(
  domain: string,
  limit: number = 10,
  repositoryId?: string,
): Promise<DomainKeyFile[]> {
  const patterns = DOMAIN_PATH_PATTERNS[domain];

  if (!patterns || patterns.length === 0) {
    logger.warn("Unknown domain or no patterns defined", { domain });
    return [];
  }

  const db = await getDb();

  // Build the path condition as a LIKE clause
  const pathClause = buildPathLikeClause(patterns);

  // Repo filter fragment (injected inline because SurrealQL parameterisation
  // for record IDs is awkward in WHERE fragments)
  const repoClause = repositoryId
    ? `AND repo = ${rid("repo", repositoryId)}`
    : "";

  // For each matching file, count the number of inbound `imports` edges.
  // SurrealDB supports aggregation over a subquery in SELECT.
  //
  // Strategy:
  //   1. Select files matching the path patterns (+optional repo)
  //   2. For each file, count(<-imports) — the number of edges pointing TO it
  //   3. Order by that count descending and cap with LIMIT
  const query = `
    SELECT
      id,
      path,
      repo,
      count(<-imports) AS dependent_count
    FROM file
    WHERE (${pathClause})
      ${repoClause}
    ORDER BY dependent_count DESC
    LIMIT $limit
  `;

  type Row = {
    id: unknown;
    path: string;
    repo: unknown;
    dependent_count: number;
  };

  const [rows] = await db.query<Array<Row[]>>(query, { limit });

  if (!rows) {
    return [];
  }

  logger.debug("Retrieved domain key files", {
    domain,
    count: rows.length,
    limit,
    repositoryId,
  });

  return rows.map((row) => {
    const rawRepoId =
      typeof row.repo === "object" && row.repo !== null
        ? ((row.repo as Record<string, unknown>)["id"] as string | undefined) ??
          String(row.repo)
        : String(row.repo);

    return {
      path: row.path,
      dependentCount: row.dependent_count ?? 0,
      repositoryId: rawRepoId,
    };
  });
}

/**
 * Get all files for a domain (without dependency ranking).
 *
 * Returns all indexed files matching the domain's path patterns.
 * Useful when you need the full list rather than just key files.
 *
 * @param domain - Domain name
 * @param limit - Maximum number of files (default: 100)
 * @param repositoryId - Optional repository filter
 * @returns Array of file paths
 */
export async function getDomainFiles(
  domain: string,
  limit: number = 100,
  repositoryId?: string,
): Promise<string[]> {
  const patterns = DOMAIN_PATH_PATTERNS[domain];

  if (!patterns || patterns.length === 0) {
    logger.warn("Unknown domain or no patterns defined", { domain });
    return [];
  }

  const db = await getDb();

  const pathClause = buildPathLikeClause(patterns);
  const repoClause = repositoryId
    ? `AND repo = ${rid("repo", repositoryId)}`
    : "";

  const query = `
    SELECT path
    FROM file
    WHERE (${pathClause})
      ${repoClause}
    ORDER BY indexed_at DESC
    LIMIT $limit
  `;

  const [rows] = await db.query<Array<Array<{ path: string }>>>(query, { limit });

  return (rows ?? []).map((row) => row.path);
}

/**
 * Get available domains that have indexed files.
 *
 * Checks which domains have at least one file matching their patterns.
 * Useful for determining which expertise areas are available.
 *
 * @param repositoryId - Optional repository filter
 * @returns Array of domain names that have files
 */
export async function getAvailableDomains(
  repositoryId?: string,
): Promise<string[]> {
  const availableDomains: string[] = [];

  for (const domain of Object.keys(DOMAIN_PATH_PATTERNS)) {
    const files = await getDomainFiles(domain, 1, repositoryId);
    if (files.length > 0) {
      availableDomains.push(domain);
    }
  }

  logger.debug("Retrieved available domains", {
    count: availableDomains.length,
    domains: availableDomains,
    repositoryId,
  });

  return availableDomains;
}
