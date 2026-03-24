/**
 * SchemaRegistry - Schema resolution and caching
 *
 * The registry holds a reference to the full spec and resolves
 * all JSON Pointers against it. This is THE source of truth for
 * schema resolution.
 *
 * Key principles:
 * - The spec is the root. All $refs resolve against it.
 * - Lazy processing with caching: only process what's needed
 * - Validators and generators receive registry access for ref following
 */

import {
  escapeSegment,
  type FragmentPointer,
  isFragmentPointer,
  isPlainObject,
  resolve as resolvePointer,
} from "@steady/json-pointer";
import { effectiveType } from "./schema-utils.ts";
import { isSchema } from "./types.ts";
import type { GenerateOptions, Schema } from "./types.ts";

/** Index built from a single walk of the spec. All consumers share this. */
export interface DocIndex {
  /** Map of $anchor value to fragment pointer. */
  anchors: Map<string, FragmentPointer>;
  /** Map of $id value to fragment pointer. */
  ids: Map<string, FragmentPointer>;
  /** All unique $ref values found in the spec. */
  refs: Set<string>;
  /** Fragment pointer -> set of $ref targets. */
  edges: Map<FragmentPointer, Set<string>>;
  /** Number of object nodes visited (proxy for schema count). */
  pointerCount: number;
}

export interface SchemaRegistryOptions {
  /** Base URI for resolution */
  baseUri?: string;
}

/**
 * A lightweight processed schema that references the registry for ref resolution
 */
export interface RegistrySchema {
  /** The raw schema object */
  raw: Schema | boolean;
  /** Fragment pointer to this schema in the spec */
  pointer: FragmentPointer;
}

export class SchemaRegistry {
  /** The full spec. All $refs resolve against this. */
  readonly spec: unknown;
  /** Pre-computed index from a single walk */
  readonly docIndex: DocIndex;
  /** Cached processed schemas by pointer */
  private cache = new Map<FragmentPointer, RegistrySchema>();
  /** Base URI for resolution */
  readonly baseUri: string;

  constructor(
    spec: unknown,
    docIndex: DocIndex,
    options: SchemaRegistryOptions = {},
  ) {
    this.spec = spec;
    this.docIndex = docIndex;
    this.baseUri = options.baseUri ?? "";
  }

  /**
   * Build a SchemaRegistry by walking the spec to extract ref data.
   * For tests and standalone usage where a pre-computed DocIndex is not available.
   */
  static fromSpec(
    spec: unknown,
    options: SchemaRegistryOptions = {},
  ): SchemaRegistry {
    const docIndex = SchemaRegistry.extractDocIndex(spec);
    return new SchemaRegistry(spec, docIndex, options);
  }

  /**
   * Walk a spec to build a DocIndex. Collects anchors, ids, refs,
   * and edges in a single pass. No cycle detection; that is a consumer
   * concern (processor.ts uses computeCyclicRefs, spec-analyzer uses
   * its own semantic DFS).
   */
  private static extractDocIndex(spec: unknown): DocIndex {
    const anchors = new Map<string, FragmentPointer>();
    const ids = new Map<string, FragmentPointer>();
    const refs = new Set<string>();
    const edges = new Map<FragmentPointer, Set<string>>();
    let pointerCount = 0;

    function walk(value: unknown, pointer: FragmentPointer): void {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i];
          if (item !== null && typeof item === "object") {
            walk(item, `${pointer}/${i}`);
          }
        }
        return;
      }

      if (!isPlainObject(value)) return;

      const obj = value;
      pointerCount++;

      // Collect $anchor and $id
      if (typeof obj.$anchor === "string") {
        anchors.set(obj.$anchor, pointer);
      }
      if (typeof obj.$id === "string") {
        ids.set(obj.$id, pointer);
      }

      // Collect $ref edges
      if (typeof obj.$ref === "string") {
        refs.add(obj.$ref);
        const existing = edges.get(pointer);
        if (existing) {
          existing.add(obj.$ref);
        } else {
          edges.set(pointer, new Set([obj.$ref]));
        }
      }

      for (const key of Object.keys(obj)) {
        if (key === "$ref") continue;
        const val = obj[key];
        if (val === null || typeof val !== "object") continue;
        walk(val, `${pointer}/${escapeSegment(key)}`);
      }
    }

    walk(spec, "#");

    return { anchors, ids, refs, edges, pointerCount };
  }

  /**
   * Resolve a JSON Pointer against the spec.
   * Delegates percent-decoding and "#" handling to resolvePointer().
   */
  resolve(pointer: FragmentPointer | string): unknown {
    if (pointer === "#" || pointer === "") {
      return this.spec;
    }

    try {
      return resolvePointer(this.spec, pointer);
    } catch {
      return undefined;
    }
  }

  /**
   * Get a schema by pointer. Returns undefined if not found.
   */
  get(pointer: FragmentPointer): RegistrySchema | undefined {
    // Check cache first
    const cached = this.cache.get(pointer);
    if (cached) {
      return cached;
    }

    // Resolve from spec
    const raw = this.resolve(pointer);
    if (raw === undefined) {
      return undefined;
    }

    // Validate it's a schema-like object (boolean or plain object)
    if (typeof raw !== "boolean" && !isSchema(raw)) {
      return undefined;
    }

    // Create and cache the registry schema
    const schema: RegistrySchema = {
      raw,
      pointer,
    };
    this.cache.set(pointer, schema);

    return schema;
  }

  /**
   * Resolve a $ref, following the reference chain.
   * Handles both internal (#/...) and anchor ($anchor) references.
   */
  resolveRef(ref: string): RegistrySchema | undefined {
    // Handle JSON Pointer references (e.g., "#/components/schemas/User")
    if (isFragmentPointer(ref)) {
      return this.get(ref);
    }

    // At this point, ref is a bare string (not starting with #)
    // Try $anchor lookup first (e.g., "myAnchor")
    const anchorSchema = this.findAnchor(ref);
    if (anchorSchema) {
      return anchorSchema;
    }

    // Handle $id references (e.g., "schema://example.com/user")
    const idSchema = this.findById(ref);
    if (idSchema) {
      return idSchema;
    }

    return undefined;
  }

  /**
   * Find a schema by $anchor value. O(1) via pre-computed index.
   */
  private findAnchor(anchor: string): RegistrySchema | undefined {
    const pointer = this.docIndex.anchors.get(anchor);
    if (pointer === undefined) return undefined;
    return this.get(pointer);
  }

  /**
   * Find a schema by $id value (exact match only). O(1) via pre-computed index.
   *
   * Per JSON Schema spec, $ref values are resolved as URI-references against
   * the base URI. We only match schemas whose $id exactly equals the reference.
   */
  private findById(id: string): RegistrySchema | undefined {
    const pointer = this.docIndex.ids.get(id);
    if (pointer === undefined) return undefined;
    return this.get(pointer);
  }

  /**
   * Get all component schemas (for OpenAPI specs)
   */
  getComponentSchemas(): Map<string, RegistrySchema> {
    const result = new Map<string, RegistrySchema>();
    const components = this.resolve("#/components/schemas");

    if (isPlainObject(components)) {
      for (const name of Object.keys(components)) {
        const pointer: FragmentPointer = `#/components/schemas/${
          escapeSegment(name)
        }`;
        const schema = this.get(pointer);
        if (schema) {
          result.set(name, schema);
        }
      }
    }

    return result;
  }

  /**
   * Get statistics about the registry
   */
  getStats(): {
    totalRefs: number;
    totalPointers: number;
    cachedSchemas: number;
  } {
    return {
      totalRefs: this.docIndex.refs.size,
      totalPointers: this.docIndex.pointerCount,
      cachedSchemas: this.cache.size,
    };
  }
}

/**
 * Response generator that uses the registry for ref resolution
 */
export class RegistryResponseGenerator {
  private visited = new Set<string>();
  private initialSeed: number;
  private seed: number;
  private arrayMin: number;
  private arrayMax: number;

  constructor(
    private registry: SchemaRegistry,
    private options: GenerateOptions = {},
  ) {
    this.initialSeed = options.seed ?? Math.random() * 1000000;
    this.seed = this.initialSeed;
    // Default to exactly 1 item (no randomness)
    // If only min is set: exact count (min=max=value)
    // If only max is set: range from default 1 to max
    const minVal = options.arrayMin;
    const maxVal = options.arrayMax;
    if (minVal !== undefined && maxVal !== undefined) {
      this.arrayMin = minVal;
      this.arrayMax = maxVal;
    } else if (minVal !== undefined) {
      // Only min set: exact count
      this.arrayMin = minVal;
      this.arrayMax = minVal;
    } else if (maxVal !== undefined) {
      // Only max set: range from 1 to max
      this.arrayMin = 1;
      this.arrayMax = maxVal;
    } else {
      // Neither set: exactly 1 item
      this.arrayMin = 1;
      this.arrayMax = 1;
    }
  }

  /**
   * Generate data for a schema at the given pointer
   */
  generate(pointer: FragmentPointer): unknown {
    const schema = this.registry.get(pointer);
    if (!schema) {
      return null;
    }
    // Reset RNG state for deterministic output per-call
    this.seed = this.initialSeed;
    this.visited.clear();
    return this.generateFromSchema(schema.raw, pointer);
  }

  /**
   * Generate data from a schema object
   */
  generateFromSchema(
    schema: Schema | boolean,
    pointer: string,
  ): unknown {
    // Handle boolean schemas
    if (typeof schema === "boolean") {
      return schema ? {} : null;
    }

    // Handle $ref - use registry to resolve
    if (schema.$ref) {
      const ref = schema.$ref;

      // Check for cycles
      if (this.visited.has(ref)) {
        return { "$comment": `Circular reference to ${ref}` };
      }

      // Resolve via registry
      const resolved = this.registry.resolveRef(ref);
      if (!resolved) {
        return { "$comment": `Unresolved reference: ${ref}` };
      }

      this.visited.add(ref);
      const result = this.generateFromSchema(resolved.raw, ref);
      this.visited.delete(ref);
      return result;
    }

    // Priority 1: Use explicit example (skip if type doesn't match schema)
    if (schema.example !== undefined && this.options.useExamples !== false) {
      if (this.exampleMatchesType(schema.example, schema)) {
        return schema.example;
      }
    }

    // Priority 2: Use first example from examples array (skip if type doesn't match)
    if (schema.examples?.length && this.options.useExamples !== false) {
      const first = schema.examples[0];
      if (this.exampleMatchesType(first, schema)) {
        return first;
      }
    }

    // Priority 3: Use default
    if (schema.default !== undefined) {
      return schema.default;
    }

    // Priority 4: const
    if (schema.const !== undefined) {
      return schema.const;
    }

    // Priority 5: enum
    if (schema.enum?.length) {
      return this.pick(schema.enum);
    }

    // Priority 6: Handle composition keywords (anyOf, oneOf, allOf)
    if (schema.anyOf?.length) {
      // Pick first non-null option, or null if only null available
      const nonNullOptions = schema.anyOf.filter(
        (s) => typeof s !== "boolean" && s.type !== "null",
      );
      const first = nonNullOptions[0] ?? schema.anyOf[0];
      if (first === undefined) return {};
      return this.generateFromSchema(first, `${pointer}/anyOf/0`);
    }

    if (schema.oneOf?.length) {
      const first = schema.oneOf[0];
      if (first === undefined) return {};
      return this.generateFromSchema(first, `${pointer}/oneOf/0`);
    }

    if (schema.allOf?.length) {
      // Merge all subschemas into one combined schema, then generate from it
      const merged: Schema = {};
      this.mergeAllOfInto(merged, schema.allOf, 0);
      // Generate from merged schema (remove allOf to avoid infinite recursion)
      const { allOf: _, ...mergedWithoutAllOf } = merged;
      return this.generateFromSchema(mergedWithoutAllOf, pointer);
    }

    // Priority 7: Generate based on type
    const type = effectiveType(schema);

    switch (type) {
      case "null":
        return null;
      case "boolean":
        return this.random() > 0.5;
      case "integer":
        return this.generateInteger(schema);
      case "number":
        return this.generateNumber(schema);
      case "string":
        return this.generateString(schema);
      case "array":
        return this.generateArray(schema, pointer);
      case "object":
        return this.generateObject(schema, pointer);
      default:
        // Infer from structure
        if (schema.properties || schema.additionalProperties) {
          return this.generateObject(schema, pointer);
        }
        if (schema.items || schema.prefixItems) {
          return this.generateArray(schema, pointer);
        }
        // Schema with nullable: true but no type - return null
        // This handles OpenAPI 3.0 style nullable modifiers in allOf
        if (schema.nullable === true) {
          return null;
        }
        return {};
    }
  }

  /** Recursively flatten allOf members into `merged`, resolving $refs. */
  private mergeAllOfInto(
    merged: Schema,
    members: ReadonlyArray<Schema | boolean>,
    depth: number,
  ): void {
    if (depth > 10) return; // guard against pathological specs

    for (const subSchema of members) {
      if (typeof subSchema === "boolean") continue;

      // Resolve $ref to get the actual schema
      let resolved: Schema = subSchema;
      if (subSchema.$ref) {
        const refResult = this.registry.resolveRef(subSchema.$ref);
        if (refResult && typeof refResult.raw !== "boolean") {
          resolved = refResult.raw;
        }
      }

      // Destructure fields that need special handling.
      // - allOf/properties/required: merged with union semantics
      // - example/examples: member-scoped, not whole-schema-scoped;
      //   copying them would let a partial example from one member
      //   shadow properties contributed by other members
      const {
        allOf,
        properties,
        required,
        example: _example,
        examples: _examples,
        ...rest
      } = resolved;
      Object.assign(merged, rest);

      if (allOf) {
        this.mergeAllOfInto(merged, allOf, depth + 1);
      }
      if (properties) {
        merged.properties = merged.properties
          ? { ...merged.properties, ...properties }
          : { ...properties };
      }
      if (required) {
        merged.required = merged.required
          ? [...new Set([...merged.required, ...required])]
          : [...required];
      }
    }
  }

  /**
   * Check whether a candidate example value is type-compatible with the schema.
   * Returns true when the schema has no declared type (permissive) or when
   * the JS runtime type of the value matches the JSON Schema type.
   * This prevents returning e.g. a plain object for an array-typed schema
   * when the spec author put item-level examples in the `examples` array.
   */
  private exampleMatchesType(value: unknown, schema: Schema): boolean {
    const type = effectiveType(schema);
    if (type === null) return true;

    switch (type) {
      case "array":
        return Array.isArray(value);
      case "object":
        return typeof value === "object" && value !== null &&
          !Array.isArray(value);
      case "string":
        return typeof value === "string";
      case "number":
      case "integer":
        return typeof value === "number";
      case "boolean":
        return typeof value === "boolean";
      case "null":
        return value === null;
      default:
        return true;
    }
  }

  private generateInteger(schema: Schema): number {
    const min = typeof schema.exclusiveMinimum === "number"
      ? schema.exclusiveMinimum + 1
      : schema.exclusiveMinimum === true
      ? (schema.minimum ?? 0) + 1
      : (schema.minimum ?? 0);
    const max = typeof schema.exclusiveMaximum === "number"
      ? schema.exclusiveMaximum - 1
      : schema.exclusiveMaximum === true
      ? (schema.maximum ?? 100) - 1
      : (schema.maximum ?? 100);
    let num = Math.floor(min + this.random() * (max - min + 1));
    if (schema.multipleOf && schema.multipleOf > 0) {
      num = Math.floor(num / schema.multipleOf) * schema.multipleOf;
    }
    return num;
  }

  private generateNumber(schema: Schema): number {
    const min = typeof schema.exclusiveMinimum === "number"
      ? schema.exclusiveMinimum + Number.EPSILON
      : schema.exclusiveMinimum === true
      ? (schema.minimum ?? 0) + Number.EPSILON
      : (schema.minimum ?? 0);
    const max = typeof schema.exclusiveMaximum === "number"
      ? schema.exclusiveMaximum - Number.EPSILON
      : schema.exclusiveMaximum === true
      ? (schema.maximum ?? 100) - Number.EPSILON
      : (schema.maximum ?? 100);
    let num = min + this.random() * (max - min);
    if (schema.multipleOf && schema.multipleOf > 0) {
      num = Math.floor(num / schema.multipleOf) * schema.multipleOf;
    }
    return num;
  }

  private generateString(schema: Schema): string {
    // Format-specific generation
    if (schema.format) {
      const formatted = this.generateFormat(schema.format);
      if (formatted !== null) return formatted;
    }

    const minLength = schema.minLength ?? 1;
    const maxLength = schema.maxLength ?? 10;
    const length = minLength +
      Math.floor(this.random() * (maxLength - minLength + 1));
    return this.randomString(length);
  }

  private generateFormat(format: string): string | null {
    switch (format) {
      case "date-time":
        return new Date(
          Date.now() - Math.floor(this.random() * 365 * 24 * 60 * 60 * 1000),
        ).toISOString();
      case "date": {
        const iso = new Date(
          Date.now() - Math.floor(this.random() * 365 * 24 * 60 * 60 * 1000),
        ).toISOString();
        return iso.split("T")[0] ?? iso;
      }
      case "time": {
        const h = Math.floor(this.random() * 24).toString().padStart(2, "0");
        const m = Math.floor(this.random() * 60).toString().padStart(2, "0");
        const s = Math.floor(this.random() * 60).toString().padStart(2, "0");
        return `${h}:${m}:${s}`;
      }
      case "email":
        return `user${Math.floor(this.random() * 1000)}@example.com`;
      case "hostname":
        return `host${Math.floor(this.random() * 1000)}.example.com`;
      case "ipv4":
        return Array(4).fill(0).map(() => Math.floor(this.random() * 256)).join(
          ".",
        );
      case "ipv6":
        return Array(8).fill(0).map(() =>
          Math.floor(this.random() * 65536).toString(16).padStart(4, "0")
        ).join(":");
      case "uri":
        return `https://example.com/path${Math.floor(this.random() * 1000)}`;
      case "uuid":
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
          const r = Math.floor(this.random() * 16);
          const v = c === "x" ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      default:
        return null;
    }
  }

  private generateArray(schema: Schema, pointer: string): unknown[] {
    // Use generator options, which override schema constraints
    const minItems = this.arrayMin;
    const maxItems = this.arrayMax;
    const length = minItems <= 0
      ? 0
      : minItems + Math.floor(this.random() * (maxItems - minItems + 1));

    const array: unknown[] = [];

    // Generate prefix items first
    if (schema.prefixItems) {
      for (let i = 0; i < schema.prefixItems.length && i < length; i++) {
        const item = schema.prefixItems[i];
        if (item === undefined) continue;
        array.push(
          this.generateFromSchema(item, `${pointer}/prefixItems/${i}`),
        );
      }
    }

    // Generate remaining items
    if (schema.items && !Array.isArray(schema.items) && array.length < length) {
      for (let i = array.length; i < length; i++) {
        array.push(
          this.generateFromSchema(schema.items, `${pointer}/items`),
        );
      }
    }

    return array;
  }

  private generateObject(
    schema: Schema,
    pointer: string,
  ): Record<string, unknown> {
    const obj: Record<string, unknown> = {};

    // Generate required properties
    if (schema.required) {
      for (const prop of schema.required) {
        const propSchema = schema.properties?.[prop];
        if (propSchema) {
          obj[prop] = this.generateFromSchema(
            propSchema,
            `${pointer}/properties/${prop}`,
          );
        } else {
          obj[prop] = this.pick(["value", 123, true, null]);
        }
      }
    }

    // TODO: Revisit optional property generation strategy.
    // Only required properties are generated. Optional properties are omitted
    // to ensure consistent, minimal responses. This avoids flaky SDK tests
    // (e.g., pagination responses randomly missing `items` array).
    // Options to consider:
    // - Always include arrays (even empty) but skip other optionals
    // - Add a "minimal" vs "full" generation mode
    // - Let users configure which optional fields to include

    return obj;
  }

  // Simple seeded random
  private random(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  private randomString(length: number): string {
    const chars =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars[Math.floor(this.random() * chars.length)];
    }
    return result;
  }

  private pick<T>(array: T[]): T {
    const index = Math.floor(this.random() * array.length);
    const picked = array[index];
    if (picked === undefined) {
      throw new Error("pick() called on empty array");
    }
    return picked;
  }
}
