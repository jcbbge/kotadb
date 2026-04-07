/**
 * Regex-based symbol extraction for Zig files.
 *
 * Extracts functions, structs, enums, unions, error sets, and constants
 * from Zig source files. Used in place of AST-based extraction since
 * @typescript-eslint/parser does not support Zig.
 *
 * Zig has no explicit export keyword — pub is the visibility modifier.
 *
 * @module @indexer/zig-extractor
 */

import type { Symbol, SymbolKind } from "./symbol-extractor.js";
import { createLogger } from "@logging/logger.js";

const logger = createLogger({ module: "indexer-zig-extractor" });

// ============================================================================
// Regex Patterns
// ============================================================================

/**
 * Function declarations.
 * Matches: [pub] fn name(
 * Groups: 1=pub?, 2=name
 */
const FN_REGEX = /^[ \t]*(?:(pub)\s+)?fn\s+(\w+)\s*[(<(]/gm;

/**
 * Struct declarations assigned to const.
 * Matches: [pub] const Name = struct {
 * Groups: 1=pub?, 2=name
 */
const STRUCT_REGEX = /^[ \t]*(?:(pub)\s+)?const\s+(\w+)\s*=\s*struct\s*\{/gm;

/**
 * Enum declarations assigned to const.
 * Matches: [pub] const Name = enum {
 * Groups: 1=pub?, 2=name
 */
const ENUM_REGEX = /^[ \t]*(?:(pub)\s+)?const\s+(\w+)\s*=\s*(?:packed\s+)?enum\s*[({]/gm;

/**
 * Union declarations assigned to const.
 * Matches: [pub] const Name = union {  OR  union(enum) {
 * Groups: 1=pub?, 2=name
 */
const UNION_REGEX = /^[ \t]*(?:(pub)\s+)?const\s+(\w+)\s*=\s*(?:packed\s+|extern\s+)?union\s*[({]/gm;

/**
 * Error set declarations.
 * Matches: [pub] const Name = error {
 * Groups: 1=pub?, 2=name
 */
const ERROR_SET_REGEX = /^[ \t]*(?:(pub)\s+)?const\s+(\w+)\s*=\s*error\s*\{/gm;

/**
 * Exported constants (non-type values).
 * Matches: pub const NAME = <non-struct/enum/union>
 * Groups: 1=name
 * Note: filtered post-match to exclude type declarations caught above.
 */
const CONST_REGEX = /^[ \t]*(pub)\s+const\s+(\w+)\s*[=:]/gm;

// ============================================================================
// Main Extraction Function
// ============================================================================

/**
 * Extract symbols from Zig source using regex patterns.
 *
 * @param content - Source code content
 * @param filePath - File path (for logging)
 * @returns Array of extracted symbols
 */
export function extractZigSymbols(
	content: string,
	filePath: string,
): Symbol[] {
	const symbols: Symbol[] = [];
	const seen = new Set<string>(); // dedupe by "name:line"

	const lineStarts = computeLineStarts(content);

	extractFunctions(content, lineStarts, symbols, seen);
	extractStructs(content, lineStarts, symbols, seen);
	extractEnums(content, lineStarts, symbols, seen);
	extractUnions(content, lineStarts, symbols, seen);
	extractErrorSets(content, lineStarts, symbols, seen);
	extractConsts(content, lineStarts, symbols, seen);

	logger.info(`Zig extractor found ${symbols.length} symbols`, {
		file_path: filePath,
		symbol_count: symbols.length,
	});

	return symbols;
}

// ============================================================================
// Helpers
// ============================================================================

function computeLineStarts(content: string): number[] {
	const lineStarts: number[] = [0];
	for (let i = 0; i < content.length; i++) {
		if (content[i] === "\n") lineStarts.push(i + 1);
	}
	return lineStarts;
}

function offsetToLine(offset: number, lineStarts: number[]): number {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo <= hi) {
		const mid = Math.floor((lo + hi) / 2);
		const start = lineStarts[mid]!;
		const next = lineStarts[mid + 1];
		if (start <= offset) {
			if (mid === lineStarts.length - 1 || (next !== undefined && next > offset)) {
				return mid + 1;
			}
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return 1;
}

function makeSymbol(
	name: string,
	kind: SymbolKind,
	line: number,
	isExported: boolean,
): Symbol {
	return {
		name,
		kind,
		lineStart: line,
		lineEnd: line,
		columnStart: 0,
		columnEnd: 0,
		signature: null,
		documentation: null,
		isExported,
	};
}

function add(
	symbols: Symbol[],
	seen: Set<string>,
	sym: Symbol,
): void {
	const key = `${sym.name}:${sym.lineStart}`;
	if (!seen.has(key)) {
		seen.add(key);
		symbols.push(sym);
	}
}

// ============================================================================
// Per-kind extractors
// ============================================================================

function extractFunctions(
	content: string,
	lineStarts: number[],
	symbols: Symbol[],
	seen: Set<string>,
): void {
	FN_REGEX.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = FN_REGEX.exec(content)) !== null) {
		const name = m[2];
		if (!name) continue;
		add(symbols, seen, makeSymbol(name, "function", offsetToLine(m.index, lineStarts), !!m[1]));
	}
}

function extractStructs(
	content: string,
	lineStarts: number[],
	symbols: Symbol[],
	seen: Set<string>,
): void {
	STRUCT_REGEX.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = STRUCT_REGEX.exec(content)) !== null) {
		const name = m[2];
		if (!name) continue;
		add(symbols, seen, makeSymbol(name, "class", offsetToLine(m.index, lineStarts), !!m[1]));
	}
}

function extractEnums(
	content: string,
	lineStarts: number[],
	symbols: Symbol[],
	seen: Set<string>,
): void {
	ENUM_REGEX.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ENUM_REGEX.exec(content)) !== null) {
		const name = m[2];
		if (!name) continue;
		add(symbols, seen, makeSymbol(name, "enum", offsetToLine(m.index, lineStarts), !!m[1]));
	}
}

function extractUnions(
	content: string,
	lineStarts: number[],
	symbols: Symbol[],
	seen: Set<string>,
): void {
	UNION_REGEX.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = UNION_REGEX.exec(content)) !== null) {
		const name = m[2];
		if (!name) continue;
		add(symbols, seen, makeSymbol(name, "type", offsetToLine(m.index, lineStarts), !!m[1]));
	}
}

function extractErrorSets(
	content: string,
	lineStarts: number[],
	symbols: Symbol[],
	seen: Set<string>,
): void {
	ERROR_SET_REGEX.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = ERROR_SET_REGEX.exec(content)) !== null) {
		const name = m[2];
		if (!name) continue;
		add(symbols, seen, makeSymbol(name, "type", offsetToLine(m.index, lineStarts), !!m[1]));
	}
}

/**
 * Extract pub const declarations that aren't struct/enum/union/error (those are caught above).
 * Skips names that are already in seen (dedupes against type declarations).
 */
function extractConsts(
	content: string,
	lineStarts: number[],
	symbols: Symbol[],
	seen: Set<string>,
): void {
	CONST_REGEX.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = CONST_REGEX.exec(content)) !== null) {
		const name = m[2];
		if (!name) continue;
		const line = offsetToLine(m.index, lineStarts);
		const key = `${name}:${line}`;
		if (seen.has(key)) continue; // already captured as struct/enum/etc
		add(symbols, seen, makeSymbol(name, "constant", line, true));
	}
}
