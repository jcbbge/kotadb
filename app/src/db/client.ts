/**
 * Database client — SurrealDB.
 *
 * Primary entry point for SurrealDB database access.
 *
 * Backward-compat aliases: getGlobalDatabase → getDb, getClient → getDb
 */

import type { Surreal } from "surrealdb";

export { getDb, closeDb, initializeSchema } from "@db/surreal/client";

// ---------------------------------------------------------------------------
// DatabaseClient type
// ---------------------------------------------------------------------------

/**
 * The database client type for this installation.
 * All code that previously typed its db handle as `DatabaseClient` continues
 * to compile correctly — it now refers to the SurrealDB `Surreal` instance.
 */
export type DatabaseClient = Surreal;

// ---------------------------------------------------------------------------
// Backward-compat alias
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `getDb()` instead.
 */
export { getDb as getGlobalDatabase, getDb as getClient } from "@db/surreal/client";

/**
 * @deprecated Use `closeDb()` instead.
 */
export { closeDb as closeGlobalConnections } from "@db/surreal/client";

/**
 * @deprecated Use `DatabaseClient` instead.
 * Alias kept for backward compatibility.
 */
export type KotaDatabase = Surreal;
