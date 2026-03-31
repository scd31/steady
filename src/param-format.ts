/**
 * Shared parameter format parsing logic
 *
 * Used by both query parameter validation and form data parsing.
 * Handles array and object serialization formats per OpenAPI spec.
 */

import type { QueryArrayFormat, QueryObjectFormat } from "./types.ts";
import { isPlainObject } from "@steady/json-pointer";

// Re-export types for convenience
export type { QueryArrayFormat, QueryObjectFormat };

/**
 * Concrete format types (excludes 'auto')
 */
export type ConcreteArrayFormat = Exclude<QueryArrayFormat, "auto">;
export type ConcreteObjectFormat = Exclude<QueryObjectFormat, "auto">;

/**
 * A parameter's wire encoding, determined by (schema type + format flags).
 *
 * This is the single decision point for how a parameter appears on the wire.
 * All consumers (presence detection, parsing, expected-key registration) use
 * this instead of independently branching on isArray/isObject + format.
 */
export type ParamEncoding =
  | { kind: "scalar" }
  | { kind: "flat-array"; arrayFmt: ConcreteArrayFormat }
  | { kind: "flat-object"; objectFmt: "flat" | "flat-comma" }
  | { kind: "nested"; objectFmt: "dots" | "brackets" };

/**
 * Interface for key-value pair sources (URLSearchParams, FormData entries, etc.)
 */
export interface KeyValueSource {
  entries(): Iterable<[string, string]>;
  get(key: string): string | null;
  getAll(key: string): string[];
}

/**
 * Wrap URLSearchParams to implement KeyValueSource
 */
export function wrapURLSearchParams(params: URLSearchParams): KeyValueSource {
  return {
    entries: () => params.entries(),
    get: (key) => params.get(key),
    getAll: (key) => params.getAll(key),
  };
}

/**
 * Wrap a Map<string, string[]> to implement KeyValueSource
 */
export function wrapStringMap(map: Map<string, string[]>): KeyValueSource {
  return {
    entries: function* () {
      for (const [key, values] of map) {
        for (const value of values) {
          yield [key, value] as [string, string];
        }
      }
    },
    get: (key) => map.get(key)?.[0] ?? null,
    getAll: (key) => map.get(key) ?? [],
  };
}

// =============================================================================
// Format Resolution (auto -> concrete)
// =============================================================================

/**
 * Resolve array format from 'auto' to concrete format based on parameter spec.
 * When format is 'auto', reads from OpenAPI style/explode properties.
 */
export function resolveArrayFormat(
  format: QueryArrayFormat,
  style?: string,
  explode?: boolean,
): ConcreteArrayFormat {
  if (format !== "auto") {
    return format;
  }

  const s = style ?? "form";
  const e = explode ?? (s === "form");

  switch (s) {
    case "form":
      return e ? "repeat" : "comma";
    case "spaceDelimited":
      return "space";
    case "pipeDelimited":
      return "pipe";
    default:
      return "repeat";
  }
}

/**
 * Resolve object format from 'auto' to concrete format based on OpenAPI
 * style/explode. When format is not 'auto', returns it directly.
 */
export function resolveObjectFormat(
  format: QueryObjectFormat,
  style?: string,
  explode?: boolean,
): ConcreteObjectFormat {
  if (format !== "auto") {
    return format;
  }

  const s = style ?? "form";
  const e = explode ?? (s === "form");

  switch (s) {
    case "form":
      return e ? "flat" : "flat-comma";
    case "deepObject":
      return "brackets";
    default:
      return "flat";
  }
}

// =============================================================================
// Array Parsing
// =============================================================================

/**
 * Get array values from key-value source based on format.
 *
 * @param source - Key-value pair source
 * @param name - Parameter name
 * @param format - Array serialization format (must be concrete, not 'auto')
 * @returns Array of string values
 */
export function getArrayValues(
  source: KeyValueSource,
  name: string,
  format: ConcreteArrayFormat,
): string[] {
  switch (format) {
    case "repeat":
      // colors=red&colors=green
      return source.getAll(name);
    case "comma": {
      // colors=red,green,blue
      const value = source.get(name);
      return value ? value.split(",") : [];
    }
    case "space": {
      // colors=red%20green%20blue
      const value = source.get(name);
      return value ? value.split(" ") : [];
    }
    case "pipe": {
      // colors=red|green|blue
      const value = source.get(name);
      return value ? value.split("|") : [];
    }
    case "brackets": {
      // colors[]=red&colors[]=green
      return source.getAll(`${name}[]`);
    }
  }
}

/**
 * Check if a parameter has a value in the source.
 */
export function hasParamValue(
  source: KeyValueSource,
  name: string,
  encoding: ParamEncoding,
): boolean {
  switch (encoding.kind) {
    case "scalar":
      return source.get(name) !== null;

    case "flat-array":
      return getArrayValues(source, name, encoding.arrayFmt).length > 0;

    case "flat-object":
      if (encoding.objectFmt === "flat") {
        return source.get(name) !== null;
      }
      // flat-comma: value must contain a comma
      {
        const value = source.get(name);
        return value !== null && value.includes(",");
      }

    case "nested": {
      const prefix = encoding.objectFmt === "dots" ? `${name}.` : `${name}[`;
      for (const [key] of source.entries()) {
        if (key.startsWith(prefix)) return true;
      }
      return false;
    }
  }
}

// =============================================================================
// Nested Array Parsing
// =============================================================================

/**
 * Parse an array of objects from prefixed query keys.
 *
 * Handles two encoding patterns:
 *
 * 1. Repeated keys (repeat + dots/brackets):
 *    search.field=a&search.op=eq&search.field=b&search.op=ne
 *    -> [{field: "a", op: "eq"}, {field: "b", op: "ne"}]
 *
 *    Keys repeat for each array item. Items are reconstructed by grouping
 *    values positionally: the Nth occurrence of each key belongs to item N.
 *
 * 2. Single item (same encoding, single occurrence):
 *    search.field=a&search.op=eq
 *    -> [{field: "a", op: "eq"}]
 *
 * Returns an empty array if no prefixed keys are found.
 */
export function parseNestedArrayValues(
  source: KeyValueSource,
  name: string,
  format: "dots" | "brackets",
): Record<string, unknown>[] {
  const prefix = format === "dots" ? `${name}.` : `${name}[`;

  // Collect all prefixed entries in order, extracting the sub-path
  const entries: { path: string[]; value: string }[] = [];
  for (const [key, value] of source.entries()) {
    if (!key.startsWith(prefix)) continue;

    if (format === "dots") {
      const path = key.slice(prefix.length).split(".");
      entries.push({ path, value });
    } else {
      const path = parseBracketPath(key, name);
      if (path.length > 0) {
        entries.push({ path, value });
      }
    }
  }

  if (entries.length === 0) return [];

  // Check if the first path segment is numeric (indexed encoding).
  // Indexed: search.0.field=a  -> path ["0", "field"]
  // Flat:    search.field=a    -> path ["field"]
  const firstSegment = entries[0]?.path[0];
  if (firstSegment !== undefined && isNumericString(firstSegment)) {
    return parseIndexedEntries(entries);
  }

  return parseRepeatedEntries(entries);
}

/**
 * Parse indexed entries: search.0.field=a&search.0.op=eq&search.1.field=b
 * Path segments start with a numeric index.
 */
function parseIndexedEntries(
  entries: { path: string[]; value: string }[],
): Record<string, unknown>[] {
  const byIndex = new Map<number, { path: string[]; value: string }[]>();
  for (const entry of entries) {
    const indexStr = entry.path[0];
    if (indexStr === undefined) continue;
    const index = parseInt(indexStr, 10);
    if (isNaN(index) || index < 0) continue;
    const group = byIndex.get(index) ?? [];
    group.push({ path: entry.path.slice(1), value: entry.value });
    byIndex.set(index, group);
  }

  const result: Record<string, unknown>[] = [];
  for (const idx of [...byIndex.keys()].sort((a, b) => a - b)) {
    const group = byIndex.get(idx);
    if (!group) continue;
    const obj: Record<string, unknown> = Object.create(null);
    for (const entry of group) {
      setNestedValue(obj, entry.path, entry.value);
    }
    result.push(obj);
  }
  return result;
}

/**
 * Parse repeated entries: search.field=a&search.op=eq&search.field=b&search.op=ne
 * Same property keys repeat for each item. Group by position.
 */
function parseRepeatedEntries(
  entries: { path: string[]; value: string }[],
): Record<string, unknown>[] {
  // Track occurrence count per top-level key to assign items by position
  const keyCounts = new Map<string, number>();
  const itemEntries = new Map<number, { path: string[]; value: string }[]>();

  for (const entry of entries) {
    const topKey = entry.path[0];
    if (topKey === undefined) continue;
    const count = keyCounts.get(topKey) ?? 0;
    keyCounts.set(topKey, count + 1);

    const group = itemEntries.get(count) ?? [];
    group.push(entry);
    itemEntries.set(count, group);
  }

  const result: Record<string, unknown>[] = [];
  for (const idx of [...itemEntries.keys()].sort((a, b) => a - b)) {
    const group = itemEntries.get(idx);
    if (!group) continue;
    const obj: Record<string, unknown> = Object.create(null);
    for (const entry of group) {
      setNestedValue(obj, entry.path, entry.value);
    }
    result.push(obj);
  }
  return result;
}

// =============================================================================
// Object Parsing
// =============================================================================

/**
 * Parse bracket notation path: filter[meta][level] -> ["meta", "level"]
 */
export function parseBracketPath(key: string, baseName: string): string[] {
  const path: string[] = [];
  const prefix = `${baseName}[`;

  if (!key.startsWith(prefix)) return path;

  const rest = key.slice(baseName.length);
  const bracketRegex = /\[([^\]]*)\]/g;
  let match: RegExpExecArray | null;

  while ((match = bracketRegex.exec(rest)) !== null) {
    const segment = match[1];
    if (segment !== undefined) {
      path.push(segment);
    }
  }

  return path;
}

/**
 * Set a value at a nested path in an object.
 * Creates intermediate objects/arrays as needed.
 *
 * Safe from prototype pollution when obj is created with Object.create(null).
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  if (path.length === 0) return;

  let current: unknown = obj;

  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    const nextSegment = path[i + 1];

    if (segment === undefined || nextSegment === undefined) continue;

    if (isPlainObject(current)) {
      // Ensure container exists at this segment
      if (!(segment in current)) {
        current[segment] = isNumericString(nextSegment)
          ? []
          : Object.create(null);
      }
      const next = current[segment];
      if (typeof next !== "object" || next === null) {
        current[segment] = isNumericString(nextSegment)
          ? []
          : Object.create(null);
      }
      current = current[segment];
    } else if (Array.isArray(current)) {
      const idx = parseInt(segment, 10);
      if (isNaN(idx) || idx < 0) break;
      current = current[idx];
    } else {
      break;
    }
  }

  // Set the final value
  const lastKey = path[path.length - 1];
  if (lastKey !== undefined) {
    if (isPlainObject(current)) {
      current[lastKey] = value;
    } else if (Array.isArray(current)) {
      const idx = parseInt(lastKey, 10);
      if (!isNaN(idx) && idx >= 0) {
        current[idx] = value;
      }
    }
  }
}

/**
 * Check if a string is a numeric index (for array detection)
 */
export function isNumericString(s: string): boolean {
  return /^\d+$/.test(s);
}

/**
 * Parse object parameter from key-value source based on format.
 * Returns a nested object structure.
 *
 * Note: This is the basic parsing without schema-based type coercion.
 * The caller should apply type coercion based on schema if needed.
 *
 * @param source - Key-value pair source
 * @param name - Parameter name (base name for nested formats)
 * @param format - Object serialization format (must be concrete, not 'auto')
 * @returns Parsed object
 */
export function parseObjectValue(
  source: KeyValueSource,
  name: string,
  format: ConcreteObjectFormat,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);

  switch (format) {
    case "flat": {
      // In flat format, we can't know which top-level params belong to this object
      // without schema info. Return the single value if present.
      const value = source.get(name);
      if (value !== null) {
        result[name] = value;
      }
      return result;
    }

    case "flat-comma": {
      // id=role,admin,firstName,Alex -> {role: "admin", firstName: "Alex"}
      const value = source.get(name);
      if (!value) return result;

      const parts = value.split(",");
      for (let i = 0; i < parts.length - 1; i += 2) {
        const key = parts[i];
        const val = parts[i + 1];
        if (key !== undefined && val !== undefined) {
          result[key] = val;
        }
      }
      return result;
    }

    case "brackets": {
      // id[role]=admin&id[firstName]=Alex -> {role: "admin", firstName: "Alex"}
      const prefix = `${name}[`;

      for (const [key, value] of source.entries()) {
        if (key.startsWith(prefix)) {
          const path = parseBracketPath(key, name);
          if (path.length > 0) {
            setNestedValue(result, path, value);
          }
        }
      }
      return result;
    }

    case "dots": {
      // id.role=admin&id.firstName=Alex -> {role: "admin", firstName: "Alex"}
      const prefix = `${name}.`;

      for (const [key, value] of source.entries()) {
        if (key.startsWith(prefix)) {
          const path = key.slice(prefix.length).split(".");
          if (path.length > 0) {
            setNestedValue(result, path, value);
          }
        }
      }
      return result;
    }
  }
}

// =============================================================================
// Key Path Parsing
// =============================================================================

/**
 * Parse a key into path segments based on object format.
 *
 * @param key - The key to parse (e.g., "user[address][city]" or "user.address.city")
 * @param format - Object serialization format
 * @returns Array of path segments
 *
 * Examples:
 * - parseKeyToPath("user", "flat") → ["user"]
 * - parseKeyToPath("user[address][city]", "brackets") → ["user", "address", "city"]
 * - parseKeyToPath("user.address.city", "dots") → ["user", "address", "city"]
 * - parseKeyToPath("items[0]", "brackets") → ["items", "0"]
 */
export function parseKeyToPath(
  key: string,
  format: ConcreteObjectFormat,
): string[] {
  switch (format) {
    case "flat":
    case "flat-comma":
      // No nesting - key is used as-is
      return [key];

    case "brackets": {
      // Parse bracket notation: user[address][city] → ["user", "address", "city"]
      const result: string[] = [];

      // Match: base name, then any number of [segment] parts
      const match = key.match(/^([^\[]+)(.*)$/);
      if (!match || match[1] === undefined) return [key];

      result.push(match[1]);

      // Extract all bracketed segments
      const brackets = match[2] ?? "";
      const bracketRegex = /\[([^\]]*)\]/g;
      let bracketMatch: RegExpExecArray | null;

      while ((bracketMatch = bracketRegex.exec(brackets)) !== null) {
        const segment = bracketMatch[1];
        if (segment !== undefined) {
          result.push(segment);
        }
      }

      return result;
    }

    case "dots":
      // Split by dots: user.address.city → ["user", "address", "city"]
      return key.split(".");
  }
}

// =============================================================================
// Form Data Helpers
// =============================================================================

/**
 * Group form data entries by field name, handling array format normalization.
 *
 * For brackets format, strips [] suffix and tracks explicit array fields.
 *
 * @param entries - Iterable of [key, value] pairs
 * @param arrayFormat - Array serialization format
 * @returns Object with grouped values and explicit array field names
 */
export function groupFormEntries(
  entries: Iterable<[string, string]>,
  arrayFormat: ConcreteArrayFormat,
): {
  groups: Map<string, string[]>;
  explicitArrays: Set<string>;
} {
  const groups = new Map<string, string[]>();
  const explicitArrays = new Set<string>();

  for (const [rawKey, value] of entries) {
    let key = rawKey;

    // Normalize array notation
    if (arrayFormat === "brackets" && rawKey.endsWith("[]")) {
      key = rawKey.slice(0, -2);
      explicitArrays.add(key);
    }

    const existing = groups.get(key) || [];
    existing.push(value);
    groups.set(key, existing);
  }

  return { groups, explicitArrays };
}

// =============================================================================
// Bracket Notation: Stateful Tree Builder
// =============================================================================

/** A single segment in a bracket-notation path. */
export type BracketSegment =
  | { type: "key"; name: string }
  | { type: "index"; index: number }
  | { type: "append" };

/**
 * Parse a bracket-notation key into typed segments.
 *
 * "name"           -> [key("name")]
 * "tags[]"         -> [key("tags"), append]
 * "assoc[][id]"    -> [key("assoc"), append, key("id")]
 * "items[0][name]" -> [key("items"), index(0), key("name")]
 * "a[][b][c]"      -> [key("a"), append, key("b"), key("c")]
 */
export function parseBracketSegments(rawKey: string): BracketSegment[] {
  const match = rawKey.match(/^([^[]+)(.*)/);
  if (!match || match[1] === undefined) {
    return rawKey.length > 0 ? [{ type: "key", name: rawKey }] : [];
  }

  const segments: BracketSegment[] = [{ type: "key", name: match[1] }];
  const rest = match[2] ?? "";
  const bracketRegex = /\[([^\]]*)\]/g;
  let bracketMatch: RegExpExecArray | null;

  while ((bracketMatch = bracketRegex.exec(rest)) !== null) {
    const content = bracketMatch[1];
    if (content === undefined) continue;

    if (content === "") {
      segments.push({ type: "append" });
    } else if (isNumericString(content)) {
      segments.push({ type: "index", index: parseInt(content, 10) });
    } else {
      segments.push({ type: "key", name: content });
    }
  }

  return segments;
}

/**
 * Build a nested object from an ordered list of bracket-notation entries.
 *
 * Handles the full bracket grammar: key, key[], key[prop], key[][prop],
 * key[0][prop], and arbitrary nesting depth.
 *
 * The [] (append) semantics are stateful: a new array element starts when
 * the next property to be set already exists on the current last element.
 */
export function buildBracketObject(
  entries: Iterable<[string, string | File]>,
): Record<string, unknown> {
  const root: Record<string, unknown> = Object.create(null);

  for (const [rawKey, value] of entries) {
    const segments = parseBracketSegments(rawKey);
    if (segments.length === 0) continue;

    let current: unknown = root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === undefined) break;
      const isLast = i === segments.length - 1;
      const nextSeg = segments[i + 1];

      if (seg.type === "key") {
        if (!isPlainObject(current)) break;
        if (isLast) {
          current[seg.name] = value;
        } else {
          if (!(seg.name in current)) {
            current[seg.name] = createContainer(nextSeg);
          }
          current = current[seg.name];
        }
      } else if (seg.type === "index") {
        if (!Array.isArray(current)) break;
        if (isLast) {
          current[seg.index] = value;
        } else {
          if (current[seg.index] === undefined) {
            current[seg.index] = createContainer(nextSeg);
          }
          current = current[seg.index];
        }
      } else {
        // seg.type === "append"
        if (!Array.isArray(current)) break;
        if (isLast) {
          // Terminal append: tags[]=a -> push value
          current.push(value);
        } else {
          // Non-terminal append: assoc[][id]=1
          // Continue last element or start a new one?
          const lastEl = current.length > 0
            ? current[current.length - 1]
            : undefined;
          const shouldStartNew = lastEl === undefined ||
            (nextSeg !== undefined && nextSeg.type === "key" &&
              isPlainObject(lastEl) && nextSeg.name in lastEl);

          if (shouldStartNew) {
            const newEl = createContainer(nextSeg);
            current.push(newEl);
            current = newEl;
          } else {
            current = lastEl;
          }
        }
      }
    }
  }

  return root;
}

/** Create the right container type based on what the next segment expects. */
function createContainer(
  nextSeg: BracketSegment | undefined,
): unknown[] | Record<string, unknown> {
  if (!nextSeg || nextSeg.type === "key") return Object.create(null);
  // "index" and "append" both navigate into arrays
  return [];
}
