/**
 * Deletion manifest for tracking removed entities during sync
 *
 * Problem: JSONL export only captures current state. If you delete
 * a repository locally, other machines won't know to delete it on
 * import because it's simply absent from the export.
 *
 * Solution: .deletions.jsonl manifest tracks deletions explicitly:
 * ```jsonl
 * {"table":"repositories","id":"abc-123","deleted_at":"2025-12-15T10:30:00Z"}
 * {"table":"indexed_files","id":"def-456","deleted_at":"2025-12-15T10:31:00Z"}
 * ```
 *
 * NOTE: applyDeletionManifest and trackDeletions are stubs — JSONL sync
 * has not been ported to the SurrealDB backend yet.
 *
 * @module @sync/deletion-manifest
 */

import { existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@logging/logger.js";

const logger = createLogger({ module: "deletion-manifest" });

/**
 * Default export directory for JSONL sync files.
 * Falls back to project-local .kotadb/export or a home-dir default.
 */
function getDefaultExportDir(): string {
  return process.env.KOTADB_EXPORT_DIR || join(homedir(), ".kotadb", "export");
}

/**
 * Whitelist of tables that can be targeted by deletion operations.
 * This list MUST be kept in sync with the database schema.
 */
export const ALLOWED_DELETION_TABLES = [
  'repositories',
  'indexed_files',
  'indexed_symbols',
  'indexed_references',
  'projects',
  'project_repositories'
] as const;

export type AllowedDeletionTable = typeof ALLOWED_DELETION_TABLES[number];

/**
 * Security-related error for deletion operations
 */
export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/**
 * Validation error for deletion entries
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Deletion entry in manifest (original interface)
 */
export interface DeletionEntry {
  table: string;
  id: string;
  deleted_at: string;
}

/**
 * Strict schema for deletion entries with validation
 */
export interface ValidatedDeletionEntry {
  table: AllowedDeletionTable;
  id: string;
  deleted_at: string;
}

/**
 * Validates that a table name is allowed for deletion operations.
 * @param tableName - The table name to validate
 * @returns true if table is allowed, false otherwise
 */
export function isAllowedDeletionTable(tableName: string): tableName is AllowedDeletionTable {
  return (ALLOWED_DELETION_TABLES as readonly string[]).includes(tableName);
}

/**
 * Validates and throws if table name is not allowed.
 * @param tableName - The table name to validate
 * @throws SecurityError if table name is not in whitelist
 */
export function validateDeletionTableName(tableName: string): asserts tableName is AllowedDeletionTable {
  if (!isAllowedDeletionTable(tableName)) {
    throw new SecurityError(`Invalid table name for deletion: '${tableName}'. Allowed tables: ${ALLOWED_DELETION_TABLES.join(', ')}`);
  }
}

/**
 * Validates and transforms raw deletion entry to validated entry
 */
export function validateDeletionEntry(raw: unknown): ValidatedDeletionEntry {
  // Type guard and validation logic
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('Deletion entry must be an object');
  }

  const entry = raw as Record<string, unknown>;

  // Validate table name
  if (typeof entry.table !== 'string') {
    throw new ValidationError('Deletion entry table must be a string');
  }
  validateDeletionTableName(entry.table);

  // Validate ID
  if (typeof entry.id !== 'string' || !entry.id.trim()) {
    throw new ValidationError('Deletion entry id must be a non-empty string');
  }

  // Validate timestamp
  if (typeof entry.deleted_at !== 'string') {
    throw new ValidationError('Deletion entry deleted_at must be a string');
  }

  // Validate ISO timestamp format
  const timestamp = new Date(entry.deleted_at);
  if (isNaN(timestamp.getTime())) {
    throw new ValidationError('Deletion entry deleted_at must be a valid ISO timestamp');
  }

  return {
    table: entry.table,
    id: entry.id.trim(),
    deleted_at: entry.deleted_at
  };
}

/**
 * Record a deletion in the manifest
 */
export async function recordDeletion(
  table: string,
  id: string,
  exportDir: string = getDefaultExportDir()
): Promise<void> {
  // Validate table name before recording
  validateDeletionTableName(table);

  const manifestPath = join(exportDir, ".deletions.jsonl");

  const entry: DeletionEntry = {
    table,
    id,
    deleted_at: new Date().toISOString()
  };

  const line = JSON.stringify(entry) + "\n";

  // Append to manifest (create if doesn't exist)
  appendFileSync(manifestPath, line, "utf-8");

  logger.debug("Deletion recorded", { table, id });
}

/**
 * Securely load and validate deletion manifest entries
 */
export async function loadDeletionManifest(
  manifestPath: string
): Promise<ValidatedDeletionEntry[]> {
  if (!existsSync(manifestPath)) {
    return [];
  }

  const content = await Bun.file(manifestPath).text();

  // Limit manifest size to prevent DoS
  const MAX_MANIFEST_SIZE = 10 * 1024 * 1024; // 10MB
  if (content.length > MAX_MANIFEST_SIZE) {
    throw new SecurityError(`Manifest file too large: ${content.length} bytes (max: ${MAX_MANIFEST_SIZE})`);
  }

  const lines = content.trim().split('\n').filter(Boolean);
  const entries: ValidatedDeletionEntry[] = [];
  const errors: string[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line) continue;
    try {
      const rawEntry = JSON.parse(line);
      const validatedEntry = validateDeletionEntry(rawEntry);
      entries.push(validatedEntry);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      errors.push(`Line ${idx + 1}: ${errorMsg}`);
      logger.warn('Invalid deletion entry, skipping', {
        line_number: idx + 1,
        error: errorMsg
      });
    }
  }

  // Fail fast if too many errors (potential attack)
  const errorRate = errors.length / lines.length;
  if (errorRate > 0.1 && errors.length > 10) {
    throw new SecurityError(`Too many invalid entries in manifest (${errors.length}/${lines.length}). Potential malicious file.`);
  }

  return entries;
}

/**
 * Apply deletions from manifest to database with security controls.
 *
 * NOTE: This function is a stub — JSONL sync has not been ported to
 * the SurrealDB backend. It will always return zero deletions.
 */
export async function applyDeletionManifest(
  _db: unknown,
  manifestPath: string
): Promise<{ deletedCount: number; errors: string[]; securityIssues: string[] }> {
  logger.warn('applyDeletionManifest: JSONL sync not yet implemented for SurrealDB backend. No deletions applied.', {
    manifestPath,
  });
  return { deletedCount: 0, errors: [], securityIssues: [] };
}

/**
 * Clear deletion manifest after successful import
 */
export async function clearDeletionManifest(
  exportDir: string = getDefaultExportDir()
): Promise<void> {
  const manifestPath = join(exportDir, ".deletions.jsonl");

  if (!existsSync(manifestPath)) {
    return;
  }

  await Bun.write(manifestPath, "");
  logger.info("Deletion manifest cleared");
}

/**
 * Hook into database operations to track deletions.
 *
 * NOTE: This function is a stub — JSONL sync has not been ported to
 * the SurrealDB backend.
 */
export function trackDeletions(
  _db: unknown,
  exportDir: string = getDefaultExportDir()
): void {
  logger.warn("Automatic deletion tracking not yet implemented for SurrealDB backend");
  logger.info(
    "Use recordDeletion(table, id) manually after deletions",
    { export_dir: exportDir }
  );
}
