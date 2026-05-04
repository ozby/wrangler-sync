/**
 * Pure TOML patching utilities — no file I/O, no side effects.
 *
 * Ported and generalised from:
 *   ozby/ingest-lens/infra/src/deploy/sync-wrangler-ids.ts
 */

/**
 * Locate `header` in `toml`, find `key = "..."` inside that block, and
 * replace the quoted value with `value`.
 *
 * Throws if `header` is not found, or if `key` is not present in the block.
 */
export function patchEnvBinding(
  toml: string,
  header: string,
  key: string,
  value: string,
): string {
  // Full-path TOML headers like `[[env.dev.hyperdrive]]` are unambiguous in
  // the file, so we search globally rather than scoping to a parent section
  // (sibling sub-tables like `[env.dev.vars]` close the parent, making
  // textual scoping error-prone).
  const blockStart = toml.indexOf(header);
  if (blockStart === -1) {
    throw new Error(`wrangler.toml missing ${header}`);
  }

  // Block ends at the next header of any kind (`\n[` or `\n[[`) or EOF.
  const nextHeader = toml.indexOf("\n[", blockStart + header.length);
  const blockEnd = nextHeader === -1 ? toml.length : nextHeader;

  const blockBody = toml.slice(blockStart, blockEnd);

  const keyRe = new RegExp(`(^|\\n)(\\s*${key}\\s*=\\s*)"[^"]*"`, "m");
  if (!keyRe.test(blockBody)) {
    throw new Error(`${header} has no "${key}" line to patch`);
  }

  const patchedBlock = blockBody.replace(keyRe, `$1$2"${value}"`);
  return toml.slice(0, blockStart) + patchedBlock + toml.slice(blockEnd);
}
