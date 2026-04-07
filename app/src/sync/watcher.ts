/**
 * File watcher for automatic JSONL import on git pull
 *
 * NOTE: JSONL sync is not yet implemented for the SurrealDB backend.
 * This module is a stub — start/stop are no-ops and will log a warning.
 *
 * @module @sync/watcher
 */

import { createLogger } from "@logging/logger.js";

const logger = createLogger({ module: "sync-watcher" });

/**
 * SyncWatcher - Watches JSONL export directory for changes.
 *
 * STUB: JSONL sync has not been implemented for the SurrealDB backend.
 * All methods are no-ops until the sync layer is ported.
 */
export class SyncWatcher {
  constructor(
    _exportDir?: string,
    _debounceMs?: number
  ) {
    logger.warn("SyncWatcher: JSONL sync is not yet implemented for the SurrealDB backend. Watcher is a no-op.");
  }

  start(): void {
    logger.warn("SyncWatcher.start(): JSONL sync not yet implemented for SurrealDB. No-op.");
  }

  stop(): void {
    // no-op
  }

  getState(): {
    isRunning: boolean;
    lastImportAt: string;
    pendingFiles: string[];
  } {
    return {
      isRunning: false,
      lastImportAt: new Date().toISOString(),
      pendingFiles: [],
    };
  }
}

/**
 * Factory function to create a watcher (stub — no-op for SurrealDB backend)
 */
export function createWatcher(
  exportDir?: string,
  debounceMs?: number
): SyncWatcher {
  const watcher = new SyncWatcher(exportDir, debounceMs);
  watcher.start();
  return watcher;
}
