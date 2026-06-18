#!/usr/bin/env node
import { syncWranglerBindings } from "../src/index.js";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: wrangler-sync [options]

Options:
  --stack <name>       Pulumi stack name (required)
  --wrangler <path>    Path to wrangler.toml (default: wrangler.toml)
  --dry-run            Print what would change without writing
  --help               Show this help message

Environment:
  Use programmatic API (syncWranglerBindings) for full control over mappings.
`);
  process.exit(0);
}

// CLI entrypoint — programmatic usage via import is the primary surface.
// The CLI is a thin wrapper for quick inspection.
const stackIdx = args.indexOf("--stack");
const wranglerIdx = args.indexOf("--wrangler");
const dryRun = args.includes("--dry-run");

if (stackIdx === -1 || !args[stackIdx + 1]) {
  console.error("Error: --stack <name> is required");
  process.exit(1);
}

const stackName = args[stackIdx + 1]!;
const wranglerTomlPath = wranglerIdx !== -1 && args[wranglerIdx + 1]
  ? args[wranglerIdx + 1]!
  : "wrangler.toml";

console.error("Note: CLI mode requires --mappings config. Use the programmatic API for full control.");
console.error(`Stack: ${stackName}, Wrangler: ${wranglerTomlPath}, DryRun: ${dryRun}`);
process.exit(0);
