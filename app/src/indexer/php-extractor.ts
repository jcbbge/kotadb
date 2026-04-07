/**
 * Regex-based symbol extraction for PHP files.
 *
 * Extracts functions, methods, classes, interfaces, traits, and constants
 * from PHP source files. Used in place of AST-based extraction since
 * @typescript-eslint/parser does not support PHP.
 *
 * @module @indexer/php-extractor
 */

import type { Symbol, SymbolKind } from "./symbol-extractor.js";
import { createLogger } from "@logging/logger.js";

const logger = createLogger({ module: "indexer-php-extractor" });

// ============================================================================
// Regex Patterns
// ============================================================================

/**
 * Top-level function declarations.
 * Matches: [public|protected|private] [static] function name(
 * Groups: 1=visibility?, 2=static?, 3=name
 */
const FUNCTION_REGEX =
	/^[ \t]*(?:(public|protected|private)\s+)?(?:(static)\s+)?function\s+(\w+)\s*\(/gm;

/**
 * Class declarations (including abstract).
 * Matches: [abstract|final] class Name
 * Groups: 1=modifier?, 2=name
 */
const CLASS_REGEX =
	/^[ \t]*(?:(abstract|final)\s+)?class\s+(\w+)/gm;

/**
 * Interface declarations.
 * Groups: 1=name
 */
const INTERFACE_REGEX = /^[ \t]*interface\s+(\w+)/gm;

/**
 * Trait declarations.
 * Groups: 1=name
 */
const TRAIT_REGEX = /^[ \t]*trait\s+(\w+)/gm;

/**
 * Class constants: const NAME =
 * Groups: 1=name
 */
const CLASS_CONST_REGEX = /^[ \t]*(?:public\s+|protected\s+|private\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*=/gm;

/**
 * define() constants: define('NAME', ...) or define("NAME", ...)
 * Groups: 1=name
 */
const DEFINE_REGEX = /^[ \t]*define\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/gm;

// ============================================================================
// Helpers
// ============================================================================

function computeLineStarts(content: string): number[] {
	const lineStarts: number[] = [0];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\n") {
			lineStarts.push(i + 1);
		}
	}
	return lineStarts;
}

function offsetToLine(offset: number, lineStarts: number[]): number {
	let low = 0;
	let high = lineStarts.length - 1;
	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const midStart = lineStarts[mid];
		const nextStart = lineStarts[mid + 1];
		if (midStart !== undefined && midStart <= offset) {
			if (mid === lineStarts.length - 1 || (nextStart !== undefined && nextStart > offset)) {
				return mid + 1;
			}
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}
	return 1;
}

function makeSymbol(
	name: string,
	kind: SymbolKind,
	lineNumber: number,
	isExported = true,
): Symbol {
	return {
		name,
		kind,
		lineStart: lineNumber,
		lineEnd: lineNumber,
		columnStart: 0,
		columnEnd: 0,
		signature: null,
		documentation: null,
		isExported,
		isAsync: false,
	};
}

// ============================================================================
// Main export
// ============================================================================

/**
 * Extract symbols from PHP source using regex patterns.
 *
 * @param content - PHP file content
 * @param filePath - File path (for logging)
 * @returns Array of extracted symbols
 */
export function extractPhpSymbols(content: string, filePath: string): Symbol[] {
	const symbols: Symbol[] = [];
	const lineStarts = computeLineStarts(content);
	let match: RegExpExecArray | null;

	// Functions and methods
	FUNCTION_REGEX.lastIndex = 0;
	while ((match = FUNCTION_REGEX.exec(content)) !== null) {
		const name = match[3];
		if (!name) continue;
		// Skip PHP magic methods (__construct, __get, etc.) — they're noise for search
		if (name.startsWith("__")) continue;
		const lineNumber = offsetToLine(match.index, lineStarts);
		symbols.push(makeSymbol(name, "function", lineNumber));
	}

	// Classes
	CLASS_REGEX.lastIndex = 0;
	while ((match = CLASS_REGEX.exec(content)) !== null) {
		const name = match[2];
		if (!name) continue;
		const lineNumber = offsetToLine(match.index, lineStarts);
		symbols.push(makeSymbol(name, "class", lineNumber));
	}

	// Interfaces
	INTERFACE_REGEX.lastIndex = 0;
	while ((match = INTERFACE_REGEX.exec(content)) !== null) {
		const name = match[1];
		if (!name) continue;
		const lineNumber = offsetToLine(match.index, lineStarts);
		symbols.push(makeSymbol(name, "interface", lineNumber));
	}

	// Traits
	TRAIT_REGEX.lastIndex = 0;
	while ((match = TRAIT_REGEX.exec(content)) !== null) {
		const name = match[1];
		if (!name) continue;
		const lineNumber = offsetToLine(match.index, lineStarts);
		// Use "class" kind — traits are structurally similar; no dedicated SymbolKind for trait
		symbols.push(makeSymbol(name, "class", lineNumber));
	}

	// Constants (class-level const and define())
	CLASS_CONST_REGEX.lastIndex = 0;
	while ((match = CLASS_CONST_REGEX.exec(content)) !== null) {
		const name = match[1];
		if (!name) continue;
		const lineNumber = offsetToLine(match.index, lineStarts);
		symbols.push(makeSymbol(name, "constant", lineNumber));
	}

	DEFINE_REGEX.lastIndex = 0;
	while ((match = DEFINE_REGEX.exec(content)) !== null) {
		const name = match[1];
		if (!name) continue;
		const lineNumber = offsetToLine(match.index, lineStarts);
		symbols.push(makeSymbol(name, "constant", lineNumber));
	}

	logger.info(`PHP extractor found ${symbols.length} symbols`, {
		file_path: filePath,
		symbol_count: symbols.length,
	});

	return symbols;
}
