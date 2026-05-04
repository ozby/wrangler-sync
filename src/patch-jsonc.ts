/**
 * Pure JSONC patching utilities — no file I/O, no side effects.
 *
 * Works on JSON/JSONC wrangler configs by doing targeted text-based patching
 * within a specific env block — same spirit as patch-toml.ts but for
 * JSON syntax instead of TOML block headers.
 *
 * Design: locate the `"<env>": {` section, then within it find each binding
 * by `"binding": "<name>"`, then replace the target key inside that binding
 * object. Preserves comments, whitespace, and ordering by staying text-based
 * (no JSON.parse — that would strip JSONC comments).
 */

import fs from "node:fs";

export interface JsoncBindingPatch {
  /** The `"binding"` value identifying the entry (e.g. "HYPERDRIVE", "GIT_STORAGE") */
  bindingName: string;
  /** The JSON key to replace within that entry (e.g. "id" or "bucket_name") */
  key: string;
  /** The new value to write */
  value: string;
}

export interface SyncJsoncOptions {
  /** Absolute path to the wrangler.jsonc file */
  wranglerPath: string;
  /** Environment block name ("preview" or "production") */
  env: string;
  /** Bindings to patch within that env block */
  patches: JsoncBindingPatch[];
  /** When true, don't write — just return what would change */
  dryRun?: boolean;
}

export interface SyncJsoncResult {
  changed: boolean;
  applied: Array<{
    bindingName: string;
    key: string;
    oldValue: string;
    newValue: string;
  }>;
}

/**
 * Patch binding values inside a specific `env.<name>` block of a wrangler.jsonc.
 *
 * Algorithm:
 *  1. Build a token stream (strings, braces, brackets, line-comment extents) to
 *     correctly track nesting and string boundaries.
 *  2. Locate `"env"` key, then the `"<env>"` sub-key, then its brace extent.
 *  3. Within that brace extent, find each `"binding": "<name>"` token and the
 *     enclosing object `{...}` (found by scanning backward for the `{` that
 *     opens the array entry containing the binding key).
 *  4. Within the entry object, replace `"<key>": "<oldValue>"` with the new value.
 *
 * Text-based (not JSON.parse) so JSONC comments are preserved verbatim.
 */
export function syncJsoncBindings(options: SyncJsoncOptions): SyncJsoncResult {
  const { wranglerPath, env, patches, dryRun } = options;

  const original = fs.readFileSync(wranglerPath, "utf-8");
  let current = original;
  const applied: SyncJsoncResult["applied"] = [];

  for (const patch of patches) {
    const { result, oldValue } = applyPatch(current, env, patch, wranglerPath);
    applied.push({
      bindingName: patch.bindingName,
      key: patch.key,
      oldValue,
      newValue: patch.value,
    });
    current = result;
  }

  const changed = current !== original;

  if (!dryRun && changed) {
    fs.writeFileSync(wranglerPath, current, "utf-8");
  }

  return { changed, applied };
}

// ============================================================================
// Token-aware text patching
// ============================================================================

/**
 * A lightweight lexer that yields character positions for meaningful tokens.
 * Returns a list of [start, end) spans for: string literals, `{`, `}`, `[`,
 * `]`, `:`, `,`, and skips JSONC line comments entirely.
 */
interface Span {
  kind:
    | "string"
    | "brace_open"
    | "brace_close"
    | "bracket_open"
    | "bracket_close"
    | "other";
  start: number;
  end: number; // exclusive
}

function tokenize(content: string): Span[] {
  const spans: Span[] = [];
  let i = 0;

  while (i < content.length) {
    const ch = content[i]!;

    // Skip JSONC line comments
    if (ch === "/" && content[i + 1] === "/") {
      const end = content.indexOf("\n", i);
      i = end === -1 ? content.length : end + 1;
      continue;
    }

    // Skip block comments (/* ... */)
    if (ch === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? content.length : end + 2;
      continue;
    }

    if (ch === '"') {
      // Scan to end of string, handling escapes
      const start = i;
      i++; // skip opening quote
      while (i < content.length) {
        if (content[i] === "\\") {
          i += 2; // skip escaped char
        } else if (content[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          i++;
        }
      }
      spans.push({ kind: "string", start, end: i });
      continue;
    }

    if (ch === "{") {
      spans.push({ kind: "brace_open", start: i, end: i + 1 });
    } else if (ch === "}") {
      spans.push({ kind: "brace_close", start: i, end: i + 1 });
    } else if (ch === "[") {
      spans.push({ kind: "bracket_open", start: i, end: i + 1 });
    } else if (ch === "]") {
      spans.push({ kind: "bracket_close", start: i, end: i + 1 });
    }
    // whitespace, commas, colons → ignored (not needed for our use)

    i++;
  }

  return spans;
}

/**
 * Given the token list and the index of a `brace_open` span,
 * return the index (in spans array) of its matching `brace_close`.
 */
function matchingClose(spans: Span[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < spans.length; i++) {
    if (spans[i]!.kind === "brace_open") depth++;
    else if (spans[i]!.kind === "brace_close") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return spans.length - 1;
}

/**
 * Find the index in `spans` of the `brace_open` that directly contains the
 * span at `targetIdx`. "Directly contains" means the brace_open is the
 * nearest enclosing `{` that encompasses targetIdx in character space.
 */
function enclosingBraceOpen(spans: Span[], targetIdx: number): number {
  // Walk backward from targetIdx-1, tracking depth
  let depth = 0;
  for (let i = targetIdx - 1; i >= 0; i--) {
    if (spans[i]!.kind === "brace_close") depth++;
    else if (spans[i]!.kind === "brace_open") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return 0;
}

function applyPatch(
  content: string,
  env: string,
  patch: JsoncBindingPatch,
  filePath: string,
): { result: string; oldValue: string } {
  const spans = tokenize(content);

  // Step 1: Find the `"env"` string span
  const envSpanIdx = spans.findIndex(
    (s) => s.kind === "string" && content.slice(s.start + 1, s.end - 1) === "env",
  );
  if (envSpanIdx === -1) {
    throw new Error(`${filePath}: missing "env" key`);
  }

  // Step 2: Find the `{` that opens the env object (the brace_open after "env": {)
  const envBraceIdx = spans.findIndex(
    (s, i) => i > envSpanIdx && s.kind === "brace_open",
  );
  if (envBraceIdx === -1) {
    throw new Error(`${filePath}: "env" has no opening brace`);
  }
  const envBraceCloseIdx = matchingClose(spans, envBraceIdx);

  // Step 3: Within env object, find `"<env>"` string
  const envKeyIdx = spans.findIndex(
    (s, i) =>
      i > envBraceIdx &&
      i < envBraceCloseIdx &&
      s.kind === "string" &&
      content.slice(s.start + 1, s.end - 1) === env,
  );
  if (envKeyIdx === -1) {
    throw new Error(`${filePath}: missing env.${env} block`);
  }

  // Step 4: Find the `{` that opens the env-specific block
  const envBlockBraceIdx = spans.findIndex(
    (s, i) => i > envKeyIdx && i <= envBraceCloseIdx && s.kind === "brace_open",
  );
  if (envBlockBraceIdx === -1) {
    throw new Error(`${filePath}: env.${env} has no opening brace`);
  }
  const envBlockBraceCloseIdx = matchingClose(spans, envBlockBraceIdx);

  // Step 5: Within the env block, find `"binding"` key followed by value `"<bindingName>"`
  for (let i = envBlockBraceIdx + 1; i < envBlockBraceCloseIdx; i++) {
    const s = spans[i]!;
    if (s.kind !== "string") continue;
    const strVal = content.slice(s.start + 1, s.end - 1);
    if (strVal !== "binding") continue;

    // Next string should be the binding name
    const bindingValIdx = spans.findIndex(
      (sp, j) => j > i && j <= envBlockBraceCloseIdx && sp.kind === "string",
    );
    if (bindingValIdx === -1) continue;
    const bindingVal = content.slice(
      spans[bindingValIdx]!.start + 1,
      spans[bindingValIdx]!.end - 1,
    );
    if (bindingVal !== patch.bindingName) {
      i = bindingValIdx; // skip to binding value span
      continue;
    }

    // Found the binding! Step 6: find the enclosing entry object `{...}`
    const entryBraceIdx = enclosingBraceOpen(spans, i);
    const entryBraceCloseIdx = matchingClose(spans, entryBraceIdx);

    // Step 7: Within the entry, find `"<key>"` and the following string value
    for (let j = entryBraceIdx + 1; j < entryBraceCloseIdx; j++) {
      const ks = spans[j]!;
      if (ks.kind !== "string") continue;
      const keyStr = content.slice(ks.start + 1, ks.end - 1);
      if (keyStr !== patch.key) continue;

      // Next string is the value
      const valIdx = spans.findIndex(
        (vs, k) => k > j && k <= entryBraceCloseIdx && vs.kind === "string",
      );
      if (valIdx === -1) {
        throw new Error(
          `${filePath}: env.${env} binding "${patch.bindingName}" key "${patch.key}" has no string value`,
        );
      }
      const valSpan = spans[valIdx]!;
      const oldValue = content.slice(valSpan.start + 1, valSpan.end - 1);
      const result =
        content.slice(0, valSpan.start) +
        `"${patch.value}"` +
        content.slice(valSpan.end);
      return { result, oldValue };
    }

    throw new Error(
      `${filePath}: env.${env} binding "${patch.bindingName}" has no key "${patch.key}"`,
    );
  }

  throw new Error(
    `${filePath}: env.${env} has no binding "${patch.bindingName}"`,
  );
}
