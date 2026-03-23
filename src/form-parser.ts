/**
 * Form Data Parser - Handles multipart/form-data and application/x-www-form-urlencoded
 *
 * Uses Deno's native FormData API (web standard) for parsing, then converts
 * to plain objects with proper nested property handling.
 *
 * Supports:
 * - Dot notation: `user.name=sam` → `{user: {name: "sam"}}`
 * - Bracket notation: `user[name]=sam` → `{user: {name: "sam"}}`
 * - Array fields: `tags=a&tags=b` → `{tags: ["a", "b"]}`
 * - File uploads: Returns File objects for binary fields
 * - Type coercion: Converts strings to numbers/booleans based on schema
 */

import type { ReferenceObject, SchemaObject } from "@steady/openapi";
import {
  coerceScalar,
  effectiveItems,
  effectiveProperties,
  effectiveType,
  isArraySchema,
} from "@steady/json-schema";
import { isReference } from "./types.ts";
import {
  type ConcreteArrayFormat,
  type ConcreteObjectFormat,
  groupFormEntries,
  isNumericString,
  parseKeyToPath,
  setNestedValue,
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
  const {
    schema,
    formArrayFormat = "repeat",
    formObjectFormat = "flat",
    resolveSchema,
  } = options;
  const result: Record<string, unknown> = Object.create(null);
  const files = new Map<string, File | File[]>();

  // Track which fields are explicitly arrays (brackets notation)
  const explicitArrayFields = new Set<string>();

  // Group all values by field name (handles repeated fields)
  const fieldValues = new Map<string, (string | File)[]>();

  for (const [rawKey, value] of formData.entries()) {
    // Normalize key based on array format
    let key = rawKey;
    if (formArrayFormat === "brackets" && rawKey.endsWith("[]")) {
      key = rawKey.slice(0, -2);
      explicitArrayFields.add(key);
    }

    const existing = fieldValues.get(key) || [];
    existing.push(value);
    fieldValues.set(key, existing);
  }

  // Process each field
  for (const [key, values] of fieldValues) {
    // Separate files from regular values
    const fileValues = values.filter((v): v is File => v instanceof File);
    const stringValues = values.filter((v): v is string =>
      typeof v === "string"
    );

    // Handle file fields
    if (fileValues.length > 0) {
      const isExplicitArray = explicitArrayFields.has(key);
      const treatAsArray = isExplicitArray || fileValues.length > 1;
      const firstFile = fileValues[0];
      if (treatAsArray) {
        files.set(key, fileValues);
      } else if (firstFile !== undefined) {
        files.set(key, firstFile);
      }
      // Also set a placeholder in the data for schema validation
      const filePlaceholder = treatAsArray
        ? fileValues.map(() => "[File]")
        : "[File]";
      const path = parseKeyToPath(key, formObjectFormat);
      setNestedValue(result, path, filePlaceholder);
      continue;
    }

    // Handle string fields
    if (stringValues.length === 0) continue;

    // Get the schema for this property (for type coercion)
    const propertySchema = getPropertySchema(
      key,
      schema,
      formObjectFormat,
      resolveSchema,
    );

    // Determine if this should be an array
    const isExplicitArray = explicitArrayFields.has(key);
    const isArrayField = isExplicitArray ||
      (propertySchema ? isArraySchema(propertySchema) : false) ||
      stringValues.length > 1;

    // Handle comma format: split single value into array if schema expects array
    if (
      formArrayFormat === "comma" && stringValues.length === 1 &&
      propertySchema && effectiveType(propertySchema) === "array"
    ) {
      const first = stringValues[0];
      if (first === undefined) continue;
      const parts = first.split(",");
      const itemSchema = propertySchema ? effectiveItems(propertySchema) : null;
      const finalValue = parts.map((v) =>
        itemSchema ? coerceScalar(v.trim(), itemSchema) : v.trim()
      );
      const path = parseKeyToPath(key, formObjectFormat);
      setNestedValue(result, path, finalValue);
      continue;
    }

    // Coerce values based on schema
    let finalValue: unknown;
    if (isArrayField) {
      // When the schema describes an array, coerce each value using the
      // items schema (not the array schema itself, which would resolve to
      // type "array" and skip coercion).
      const itemSchema = propertySchema && isArraySchema(propertySchema)
        ? effectiveItems(propertySchema)
        : propertySchema;
      finalValue = stringValues.map((v) =>
        itemSchema ? coerceScalar(v, itemSchema) : v
      );
    } else {
      const firstValue = stringValues[0];
      finalValue = firstValue !== undefined
        ? (propertySchema
          ? coerceScalar(firstValue, propertySchema)
          : firstValue)
        : undefined;
    }

    const path = parseKeyToPath(key, formObjectFormat);
    setNestedValue(result, path, finalValue);
  }

  return { data: result, files };
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
  const {
    schema,
    formArrayFormat = "repeat",
    formObjectFormat = "flat",
    resolveSchema,
  } = options;
  const params = new URLSearchParams(body);
  const result: Record<string, unknown> = Object.create(null);

  // Use shared groupFormEntries for array format normalization
  const stringEntries: [string, string][] = [];
  for (const [key, value] of params.entries()) {
    stringEntries.push([key, value]);
  }
  const { groups, explicitArrays } = groupFormEntries(
    stringEntries,
    formArrayFormat,
  );

  // Process each field
  for (const [key, values] of groups) {
    const propertySchema = getPropertySchema(
      key,
      schema,
      formObjectFormat,
      resolveSchema,
    );
    const isExplicitArray = explicitArrays.has(key);
    const isArrayField = isExplicitArray ||
      (propertySchema ? isArraySchema(propertySchema) : false) ||
      values.length > 1;

    let finalValue: unknown;
    if (isArrayField) {
      const itemSchema = propertySchema && isArraySchema(propertySchema)
        ? effectiveItems(propertySchema)
        : propertySchema;
      finalValue = values.map((v) =>
        itemSchema ? coerceScalar(v, itemSchema) : v
      );
    } else {
      const firstValue = values[0];
      finalValue = firstValue !== undefined
        ? (propertySchema
          ? coerceScalar(firstValue, propertySchema)
          : firstValue)
        : undefined;
    }

    const path = parseKeyToPath(key, formObjectFormat);
    setNestedValue(result, path, finalValue);
  }

  return { data: result, files: new Map() };
}

/**
 * Get the schema for a potentially nested property
 */
function getPropertySchema(
  key: string,
  schema: SchemaObject | ReferenceObject | undefined,
  objectFormat: ConcreteObjectFormat,
  resolveSchema?: (
    schema: SchemaObject | ReferenceObject,
  ) => SchemaObject | undefined,
): SchemaObject | undefined {
  if (!schema) return undefined;

  // Resolve reference if needed
  let resolved: SchemaObject | undefined;
  if (isReference(schema)) {
    resolved = resolveSchema?.(schema);
  } else {
    resolved = schema;
  }

  if (!resolved) return undefined;

  // Parse the key path using the specified format
  const path = parseKeyToPath(key, objectFormat);

  // Navigate to the nested property schema
  let current: SchemaObject | undefined = resolved;

  for (const segment of path) {
    if (!current) return undefined;

    if (effectiveType(current) === "array" && isNumericString(segment)) {
      // Array index - get items schema
      const itemSchema = effectiveItems(current);
      if (!itemSchema || typeof itemSchema === "boolean") {
        current = undefined;
      } else if (isReference(itemSchema)) {
        current = resolveSchema?.(itemSchema);
      } else {
        current = itemSchema;
      }
    } else {
      // Object property - walk through effective properties
      const props = effectiveProperties(current);
      if (!props) return undefined;
      const prop = props[segment];
      if (!prop) return undefined;
      if (isReference(prop)) {
        current = resolveSchema?.(prop);
      } else {
        current = prop;
      }
    }
  }

  return current;
}
