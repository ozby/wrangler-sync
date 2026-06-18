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

export interface JsoncCustomDomainRoute {
  pattern: string;
  customDomain?: boolean;
}

export interface JsoncDurableObjectBinding {
  name: string;
  className: string;
  scriptName?: string;
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

/**
 * Upsert an env-specific custom-domain route inside `env.<name>.routes`.
 *
 * - If `routes` is missing, it is rendered into the env block.
 * - If a matching route already exists (same pattern or existing custom-domain route),
 *   its `pattern` / `custom_domain` fields are patched in place.
 * - Otherwise a new route object is appended to the env-specific routes array.
 */
export function upsertEnvCustomDomainRoute(
  content: string,
  env: string,
  route: JsoncCustomDomainRoute,
): string {
  const normalizedRoute: JsoncCustomDomainRoute = {
    pattern: route.pattern,
    customDomain: route.customDomain ?? true,
  };

  const envBlock = findEnvBlock(content, env, "wrangler.jsonc");
  const routesProperty = findTopLevelProperty(
    content,
    envBlock.spans,
    envBlock.openIdx,
    envBlock.closeIdx,
    "routes",
  );

  if (!routesProperty) {
    const propertyIndent = memberIndent(content, envBlock.start, envBlock.closeStart);
    const renderedRoutes = renderRoutesProperty(propertyIndent, normalizedRoute);
    return insertIntoObject(content, envBlock.start, envBlock.closeStart, renderedRoutes);
  }

  const routesValue = envBlock.spans[routesProperty.valueIdx]!;
  if (routesValue.kind !== "bracket_open") {
    throw new Error(`wrangler.jsonc: env.${env}.routes is not an array`);
  }

  const routesCloseIdx = matchingPair(envBlock.spans, routesProperty.valueIdx);
  const routeEntries = findDirectObjectEntriesInArray(
    envBlock.spans,
    routesProperty.valueIdx,
    routesCloseIdx,
  );

  const exactPatternEntry = routeEntries.find((entry) => {
    const entryText = content.slice(entry.start, entry.end);
    return readStringProperty(entryText, "pattern") === normalizedRoute.pattern;
  });
  const customDomainEntry = routeEntries.find((entry) => {
    const entryText = content.slice(entry.start, entry.end);
    return /"custom_domain"\s*:\s*true\b/u.test(entryText);
  });
  const targetEntry = exactPatternEntry ?? customDomainEntry;

  if (targetEntry) {
    const updatedEntry = upsertObjectPropertiesText(
      content.slice(targetEntry.start, targetEntry.end),
      lineIndentAt(content, targetEntry.start),
      [
        { key: "pattern", renderedValue: JSON.stringify(normalizedRoute.pattern) },
        {
          key: "custom_domain",
          renderedValue: normalizedRoute.customDomain ? "true" : "false",
        },
      ],
    );
    return replaceRange(content, targetEntry.start, targetEntry.end, updatedEntry);
  }

  const arrayIndent = memberIndent(
    content,
    routesValue.start,
    envBlock.spans[routesCloseIdx]!.start,
  );
  const renderedRoute = renderRouteObject(arrayIndent, normalizedRoute);
  return insertIntoArray(
    content,
    routesValue.start,
    envBlock.spans[routesCloseIdx]!.start,
    renderedRoute,
  );
}

/**
 * Upsert an env-specific Durable Object binding inside
 * `env.<name>.durable_objects.bindings`.
 *
 * - If `durable_objects` is missing, it is rendered into the env block.
 * - If `bindings` is missing, it is rendered into the durable_objects block.
 * - If a matching binding exists by `name`, its string fields are patched in place.
 * - Otherwise a new binding object is appended to the env-specific bindings array.
 */
export function upsertEnvDurableObjectBinding(
  content: string,
  env: string,
  binding: JsoncDurableObjectBinding,
): string {
  const envBlock = findEnvBlock(content, env, "wrangler.jsonc");
  const durableObjectsProperty = findTopLevelProperty(
    content,
    envBlock.spans,
    envBlock.openIdx,
    envBlock.closeIdx,
    "durable_objects",
  );

  if (!durableObjectsProperty) {
    const propertyIndent = memberIndent(content, envBlock.start, envBlock.closeStart);
    const renderedDurableObjects = renderDurableObjectsProperty(propertyIndent, binding);
    return insertIntoObject(
      content,
      envBlock.start,
      envBlock.closeStart,
      renderedDurableObjects,
    );
  }

  const durableObjectsValue = envBlock.spans[durableObjectsProperty.valueIdx]!;
  if (durableObjectsValue.kind !== "brace_open") {
    throw new Error(`wrangler.jsonc: env.${env}.durable_objects is not an object`);
  }

  const durableObjectsCloseIdx = matchingPair(
    envBlock.spans,
    durableObjectsProperty.valueIdx,
  );
  const bindingsProperty = findTopLevelProperty(
    content,
    envBlock.spans,
    durableObjectsProperty.valueIdx,
    durableObjectsCloseIdx,
    "bindings",
  );

  if (!bindingsProperty) {
    const propertyIndent = memberIndent(
      content,
      durableObjectsValue.start,
      envBlock.spans[durableObjectsCloseIdx]!.start,
    );
    const renderedBindings = renderDurableObjectBindingsProperty(propertyIndent, binding);
    return insertIntoObject(
      content,
      durableObjectsValue.start,
      envBlock.spans[durableObjectsCloseIdx]!.start,
      renderedBindings,
    );
  }

  const bindingsValue = envBlock.spans[bindingsProperty.valueIdx]!;
  if (bindingsValue.kind !== "bracket_open") {
    throw new Error(`wrangler.jsonc: env.${env}.durable_objects.bindings is not an array`);
  }

  const bindingsCloseIdx = matchingPair(envBlock.spans, bindingsProperty.valueIdx);
  const bindingEntries = findDirectObjectEntriesInArray(
    envBlock.spans,
    bindingsProperty.valueIdx,
    bindingsCloseIdx,
  );

  const existingBindingEntry = bindingEntries.find((entry) => {
    const entryText = content.slice(entry.start, entry.end);
    return readStringProperty(entryText, "name") === binding.name;
  });

  if (existingBindingEntry) {
    const renderedProps: Array<{ key: string; renderedValue: string }> = [
      { key: "name", renderedValue: JSON.stringify(binding.name) },
      { key: "class_name", renderedValue: JSON.stringify(binding.className) },
    ];

    if (binding.scriptName !== undefined) {
      renderedProps.push({
        key: "script_name",
        renderedValue: JSON.stringify(binding.scriptName),
      });
    }

    const updatedEntry = upsertObjectPropertiesText(
      content.slice(existingBindingEntry.start, existingBindingEntry.end),
      lineIndentAt(content, existingBindingEntry.start),
      renderedProps,
    );
    return replaceRange(content, existingBindingEntry.start, existingBindingEntry.end, updatedEntry);
  }

  const arrayIndent = memberIndent(
    content,
    bindingsValue.start,
    envBlock.spans[bindingsCloseIdx]!.start,
  );
  const renderedBinding = renderDurableObjectBindingObject(arrayIndent, binding);
  return insertIntoArray(
    content,
    bindingsValue.start,
    envBlock.spans[bindingsCloseIdx]!.start,
    renderedBinding,
  );
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
    | "bracket_close";
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

function matchingPair(spans: Span[], openIdx: number): number {
  const openKind = spans[openIdx]?.kind;
  const closeKind =
    openKind === "brace_open"
      ? "brace_close"
      : openKind === "bracket_open"
        ? "bracket_close"
        : null;

  if (closeKind === null) {
    throw new Error(`Expected brace/bracket open token at span index ${openIdx}`);
  }

  let depth = 0;
  for (let i = openIdx; i < spans.length; i++) {
    if (spans[i]!.kind === openKind) depth++;
    else if (spans[i]!.kind === closeKind) {
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

interface EnvBlockLocation {
  spans: Span[];
  openIdx: number;
  closeIdx: number;
  start: number;
  closeStart: number;
}

function findEnvBlock(content: string, env: string, filePath: string): EnvBlockLocation {
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
  const envBraceCloseIdx = matchingPair(spans, envBraceIdx);

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
  const envBlockBraceCloseIdx = matchingPair(spans, envBlockBraceIdx);

  return {
    spans,
    openIdx: envBlockBraceIdx,
    closeIdx: envBlockBraceCloseIdx,
    start: spans[envBlockBraceIdx]!.start,
    closeStart: spans[envBlockBraceCloseIdx]!.start,
  };
}

function findTopLevelProperty(
  content: string,
  spans: Span[],
  objectOpenIdx: number,
  objectCloseIdx: number,
  key: string,
): { keyIdx: number; valueIdx: number } | null {
  let depth = 0;

  for (let i = objectOpenIdx + 1; i < objectCloseIdx; i++) {
    const span = spans[i]!;

    if (span.kind === "brace_open" || span.kind === "bracket_open") {
      depth++;
      continue;
    }
    if (span.kind === "brace_close" || span.kind === "bracket_close") {
      depth--;
      continue;
    }
    if (depth !== 0 || span.kind !== "string") {
      continue;
    }

    const text = content.slice(span.start + 1, span.end - 1);
    if (text !== key) {
      continue;
    }

    const valueIdx = i + 1;
    if (valueIdx >= objectCloseIdx) {
      throw new Error(`Object property "${key}" has no value token`);
    }

    return { keyIdx: i, valueIdx };
  }

  return null;
}

interface ObjectEntryLocation {
  start: number;
  end: number;
}

function findDirectObjectEntriesInArray(
  spans: Span[],
  arrayOpenIdx: number,
  arrayCloseIdx: number,
): ObjectEntryLocation[] {
  const entries: ObjectEntryLocation[] = [];
  let depth = 0;

  for (let i = arrayOpenIdx + 1; i < arrayCloseIdx; i++) {
    const span = spans[i]!;

    if (span.kind === "brace_open" && depth === 0) {
      const closeIdx = matchingPair(spans, i);
      entries.push({ start: span.start, end: spans[closeIdx]!.end });
      i = closeIdx;
      continue;
    }

    if (span.kind === "brace_open" || span.kind === "bracket_open") {
      depth++;
      continue;
    }

    if (span.kind === "brace_close" || span.kind === "bracket_close") {
      depth--;
    }
  }

  return entries;
}

function lineIndentAt(content: string, pos: number): string {
  const lineStart = content.lastIndexOf("\n", pos - 1) + 1;
  const linePrefix = content.slice(lineStart, pos);
  const indentMatch = linePrefix.match(/^[ \t]*/u);
  return indentMatch?.[0] ?? "";
}

function memberIndent(content: string, containerStart: number, containerCloseStart: number): string {
  const containerIndent = lineIndentAt(content, containerStart);
  const body = content.slice(containerStart + 1, containerCloseStart);
  const lines = body.split("\n");

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const indentMatch = line.match(/^[ \t]*/u);
    return indentMatch?.[0] ?? `${containerIndent}  `;
  }

  return `${containerIndent}  `;
}

function insertIntoObject(
  content: string,
  objectStart: number,
  objectCloseStart: number,
  renderedProperty: string,
): string {
  const objectIndent = lineIndentAt(content, objectStart);
  const hasMembers = content.slice(objectStart + 1, objectCloseStart).trim().length > 0;
  const insert = hasMembers
    ? `,\n${renderedProperty}\n${objectIndent}`
    : `\n${renderedProperty}\n${objectIndent}`;

  return replaceRange(content, objectCloseStart, objectCloseStart, insert);
}

function insertIntoArray(
  content: string,
  arrayStart: number,
  arrayCloseStart: number,
  renderedEntry: string,
): string {
  const arrayIndent = lineIndentAt(content, arrayStart);
  const hasEntries = content.slice(arrayStart + 1, arrayCloseStart).trim().length > 0;
  const insert = hasEntries
    ? `,\n${renderedEntry}\n${arrayIndent}`
    : `\n${renderedEntry}\n${arrayIndent}`;

  return replaceRange(content, arrayCloseStart, arrayCloseStart, insert);
}

function replaceRange(content: string, start: number, end: number, replacement: string): string {
  return content.slice(0, start) + replacement + content.slice(end);
}

function upsertObjectPropertiesText(
  objectText: string,
  objectIndent: string,
  properties: Array<{ key: string; renderedValue: string }>,
): string {
  let result = objectText;
  const missing: Array<{ key: string; renderedValue: string }> = [];

  for (const property of properties) {
    const propertyPattern = new RegExp(
      `("${escapeRegExp(property.key)}"\\s*:\\s*)(?:"(?:\\\\.|[^"\\\\])*"|true|false|null|-?\\d+(?:\\.\\d+)?)`,
      "u",
    );

    if (!propertyPattern.test(result)) {
      missing.push(property);
      continue;
    }

    result = result.replace(propertyPattern, `$1${property.renderedValue}`);
  }

  if (missing.length === 0) {
    return result;
  }

  const propertyIndent = `${objectIndent}  `;
  const renderedMissing = missing
    .map((property) => `${propertyIndent}"${property.key}": ${property.renderedValue}`)
    .join(",\n");

  const closePos = result.lastIndexOf("}");
  const hasMembers = result.slice(1, closePos).trim().length > 0;
  const insert = hasMembers
    ? `,\n${renderedMissing}\n${objectIndent}`
    : `\n${renderedMissing}\n${objectIndent}`;

  return result.slice(0, closePos) + insert + result.slice(closePos);
}

function readStringProperty(objectText: string, key: string): string | null {
  const propertyPattern = new RegExp(
    `"${escapeRegExp(key)}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`,
    "u",
  );
  const match = propertyPattern.exec(objectText);
  return match?.[1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderRoutesProperty(indent: string, route: JsoncCustomDomainRoute): string {
  const itemIndent = `${indent}  `;
  return `${indent}"routes": [\n${renderRouteObject(itemIndent, route)}\n${indent}]`;
}

function renderRouteObject(indent: string, route: JsoncCustomDomainRoute): string {
  const propertyIndent = `${indent}  `;
  return [
    `${indent}{`,
    `${propertyIndent}"pattern": ${JSON.stringify(route.pattern)},`,
    `${propertyIndent}"custom_domain": ${route.customDomain ? "true" : "false"}`,
    `${indent}}`,
  ].join("\n");
}

function renderDurableObjectsProperty(
  indent: string,
  binding: JsoncDurableObjectBinding,
): string {
  const propertyIndent = `${indent}  `;
  return [
    `${indent}"durable_objects": {`,
    renderDurableObjectBindingsProperty(propertyIndent, binding),
    `${indent}}`,
  ].join("\n");
}

function renderDurableObjectBindingsProperty(
  indent: string,
  binding: JsoncDurableObjectBinding,
): string {
  const itemIndent = `${indent}  `;
  return [
    `${indent}"bindings": [`,
    renderDurableObjectBindingObject(itemIndent, binding),
    `${indent}]`,
  ].join("\n");
}

function renderDurableObjectBindingObject(
  indent: string,
  binding: JsoncDurableObjectBinding,
): string {
  const propertyIndent = `${indent}  `;
  const lines = [
    `${indent}{`,
    `${propertyIndent}"name": ${JSON.stringify(binding.name)},`,
    `${propertyIndent}"class_name": ${JSON.stringify(binding.className)}`,
  ];

  if (binding.scriptName !== undefined) {
    lines[lines.length - 1] = `${lines[lines.length - 1]},`;
    lines.push(`${propertyIndent}"script_name": ${JSON.stringify(binding.scriptName)}`);
  }

  lines.push(`${indent}}`);
  return lines.join("\n");
}

function applyPatch(
  content: string,
  env: string,
  patch: JsoncBindingPatch,
  filePath: string,
): { result: string; oldValue: string } {
  const envBlock = findEnvBlock(content, env, filePath);
  const { spans, openIdx, closeIdx } = envBlock;

  // Step 5: Within the env block, find `"binding"` key followed by value `"<bindingName>"`
  for (let i = openIdx + 1; i < closeIdx; i++) {
    const s = spans[i]!;
    if (s.kind !== "string") continue;
    const strVal = content.slice(s.start + 1, s.end - 1);
    if (strVal !== "binding") continue;

    // Next string should be the binding name
    const bindingValIdx = spans.findIndex(
      (sp, j) => j > i && j <= closeIdx && sp.kind === "string",
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
    const entryBraceCloseIdx = matchingPair(spans, entryBraceIdx);

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
        JSON.stringify(patch.value) +
        content.slice(valSpan.end);
      return { result, oldValue };
    }

    throw new Error(
      `${filePath}: env.${env} binding "${patch.bindingName}" has no key "${patch.key}"`,
    );
  }

  throw new Error(`${filePath}: env.${env} has no binding "${patch.bindingName}"`);
}
