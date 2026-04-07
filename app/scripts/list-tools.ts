#!/usr/bin/env bun
/**
 * List all available MCP tools in KotaDB
 *
 * Usage: bun run scripts/list-tools.ts
 */

import { getToolDefinitions, filterToolsByTier } from "../src/mcp/tools.js";

const tools = getToolDefinitions();

console.log("\n=== KotaDB MCP Tools ===\n");

const tiers = ["core", "sync", "memory", "expertise"] as const;

for (const tier of tiers) {
  const tierTools = tools.filter((t) => t.tier === tier);
  console.log(`\n${tier.toUpperCase()} (${tierTools.length} tools):`);
  console.log("-".repeat(40));
  
  for (const tool of tierTools) {
    const desc = tool.description?.split("\n")[0] || "No description";
    console.log(`  ${tool.name}`);
    console.log(`    ${desc.substring(0, 60)}${desc.length > 60 ? "..." : ""}`);
  }
}

console.log(`\n\nTotal: ${tools.length} tools\n`);

// Summary by tier
console.log("By Tier:");
console.log(`  Core:      ${filterToolsByTier("core").length}`);
console.log(`  Default:   ${filterToolsByTier("default").length} (core + sync)`);
console.log(`  Memory:    ${filterToolsByTier("memory").length} (core + sync + memory)`);
console.log(`  Full:      ${filterToolsByTier("full").length} (all tiers)`);
console.log();
