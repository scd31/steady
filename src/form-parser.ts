/**
 * Form Data Parser - Handles multipart/form-data and application/x-www-form-urlencoded
 *
 * A thin adapter over the schema-driven kernel in `param-format.ts`. Each
 * wrapper collects entries from its data source and hands them to
 * `parseFormEntries`; the kernel takes care of segment parsing, recursion,
 * terminal coalescing, and type coercion. The only form-parser-specific
 * concern is extracting File instances from multipart data into a separate
 * Map with `"[File]"` placeholders.
 */

import type { ReferenceObject, SchemaObject } from "@steady/openapi";
import { isPlainObject } from "@steady/json-pointer";
import { isReference } from "./types.ts";
import {
  type ConcreteArrayFormat,
  type ConcreteObjectFormat,
  type FormFormat,
  parseFormEntries,
} from "./param-format.ts";

/**
 * Result of parsing form data
 */
export interface ParsedFormData {
  /** Parsed form fields as a nested object */
  data: Record<string, unknown>;
  /** Any files found in the form data, keyed by field name */
  files: Map<string, File | File[]>;
}

// Re-export format types for external use
export type { ConcreteArrayFormat, ConcreteObjectFormat };

/**
 * Options for form parsing
 */
export interface FormParserOptions {
  /** Schema for type coercion (optional) */
  schema?: SchemaObject | ReferenceObject;
  /** How array fields are serialized. Default: 'repeat' */
  formArrayFormat?: ConcreteArrayFormat;
  /** How object fields are serialized. Default: 'flat' */
  formObjectFormat?: ConcreteObjectFormat;
  /** Schema resolver function for $ref resolution */
  resolveSchema?: (
    schema: SchemaObject | ReferenceObject,
  ) => SchemaObject | undefined;
}

/**
 * Parse a native FormData object into a structured object
 *
 * @param formData - Native FormData from request.formData()
 * @param options - Parsing options including schema for type coercion
 * @returns Parsed form data with nested objects and type-coerced values
 */
export function parseFormData(
  formData: FormData,
  options: FormParserOptions = {},
): ParsedFormData {
  const { schema, resolveSchema } = options;
  const format: FormFormat = {
    array: options.formArrayFormat ?? "repeat",
    object: options.formObjectFormat ?? "flat",
  };

  const rootSchema = resolveRoot(schema, resolveSchema);
  const data = parseFormEntries(
    formData.entries(),
    rootSchema ?? null,
    format,
    resolveSchema,
  );
  const files = extractFiles(data);
  return { data, files };
}

/**
 * Parse a URL-encoded string into a structured object
 *
 * @param body - URL-encoded string (e.g., "name=sam&age=30")
 * @param options - Parsing options
 * @returns Parsed form data
 */
export function parseUrlEncoded(
  body: string,
  options: FormParserOptions = {},
): ParsedFormData {
  const { schema, resolveSchema } = options;
  const format: FormFormat = {
    array: options.formArrayFormat ?? "repeat",
    object: options.formObjectFormat ?? "flat",
  };

  const rootSchema = resolveRoot(schema, resolveSchema);
  const params = new URLSearchParams(body);
  const data = parseFormEntries(
    params.entries(),
    rootSchema ?? null,
    format,
    resolveSchema,
  );
  return { data, files: new Map() };
}

/**
 * Resolve the root body schema, following a top-level `$ref` if present.
 * The kernel walks composition keywords on its own, so only the top-level
 * reference is resolved here.
 */
function resolveRoot(
  schema: SchemaObject | ReferenceObject | undefined,
  resolveSchema?: (
    schema: SchemaObject | ReferenceObject,
  ) => SchemaObject | undefined,
): SchemaObject | undefined {
  if (!schema) return undefined;
  if (isReference(schema)) return resolveSchema?.(schema);
  return schema;
}

// =============================================================================
// File extraction post-walk
// =============================================================================

/**
 * Walk a parsed tree, replacing File instances with "[File]" placeholders
 * and collecting them into a files Map keyed by dot-joined path.
 */
function extractFiles(
  data: Record<string, unknown>,
  prefix = "",
): Map<string, File | File[]> {
  const files = new Map<string, File | File[]>();

  for (const key of Object.keys(data)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = data[key];

    if (value instanceof File) {
      files.set(fullKey, value);
      data[key] = "[File]";
    } else if (Array.isArray(value)) {
      const fileItems = value.filter((v): v is File => v instanceof File);
      if (fileItems.length > 0 && fileItems.length === value.length) {
        files.set(fullKey, fileItems);
        data[key] = fileItems.map(() => "[File]");
      } else {
        for (const item of value) {
          if (!(item instanceof File) && isPlainObject(item)) {
            const subFiles = extractFiles(item, fullKey);
            for (const [k, v] of subFiles) {
              files.set(k, v);
            }
          }
        }
      }
    } else if (!(value instanceof File) && isPlainObject(value)) {
      const subFiles = extractFiles(value, fullKey);
      for (const [k, v] of subFiles) {
        files.set(k, v);
      }
    }
  }

  return files;
}
