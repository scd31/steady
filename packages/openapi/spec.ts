/**
 * Spec implementation. Structured access to an OpenAPI spec.
 *
 * The single facade for all OpenAPI resolution. Wraps a SchemaRegistry
 * and provides:
 * - Typed accessors: parameters, body schemas, responses
 * - Universal $ref resolution via resolveRef() (schemas, parameters,
 *   responses, headers, examples, anything)
 * - Schema registry access for schema-specific operations
 *
 * The engine works against the Spec interface, not raw OpenAPI types.
 */

import { isSchema, SchemaRegistry } from "@steady/json-schema";
import type { Schema } from "@steady/json-schema";
import {
  escapeSegment,
  type FragmentPointer,
  isFragmentPointer,
  isPlainObject,
} from "@steady/json-pointer";
import type {
  OpenAPIRaw,
  OperationObject,
  ParameterObject,
  PathItemObject,
  PathsObject,
  ReferenceObject,
  RequestBodyObject,
  ResponseObject,
} from "./openapi.ts";

// ── Local types ────────────────────────────────────────────────────
// These describe the shape of this module's output. The canonical
// contract types (Spec, ResolvedParameter, BodySchemaInfo)
// live in src/engine/diagnostic-engine.ts. A compile-time test
// verifies that OpenAPISpec satisfies Spec.

interface ResolvedParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema: Schema | null;
  schemaPath: FragmentPointer | null;
  style?: string;
  explode?: boolean;
}

interface BodySchemaInfo {
  schema: Schema;
  schemaPath: FragmentPointer;
  required: boolean;
}

// ── Type guards ────────────────────────────────────────────────────

/**
 * Type guard for ParameterObject resolved from a $ref.
 * Checks the essential discriminating properties (name, in).
 */
function isParameterLike(value: unknown): value is ParameterObject {
  if (!isPlainObject(value)) return false;
  return typeof value["name"] === "string" && typeof value["in"] === "string";
}

/**
 * Type guard for RequestBodyObject resolved from a $ref.
 * Checks for the essential `content` property.
 */
function isRequestBodyLike(value: unknown): value is RequestBodyObject {
  if (!isPlainObject(value)) return false;
  return "content" in value && isPlainObject(value["content"]);
}

/**
 * Type guard for ResponseObject resolved from a $ref.
 */
function isResponseLike(value: unknown): value is ResponseObject {
  if (!isPlainObject(value)) return false;
  return typeof value["description"] === "string";
}

/**
 * Type guard for OpenAPIRaw shape. Used to narrow SchemaRegistry.spec
 * (which is `unknown`) to `OpenAPIRaw` without an `as` cast.
 */
function isOpenAPISpecLike(value: unknown): value is OpenAPIRaw {
  if (!isPlainObject(value)) return false;
  return typeof value["openapi"] === "string" &&
    isPlainObject(value["info"]) &&
    isPlainObject(value["paths"]);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

// ── Implementation ─────────────────────────────────────────────────

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
  "query",
] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export class OpenAPISpec {
  private readonly spec: OpenAPIRaw;
  readonly registry: SchemaRegistry;

  constructor(registry: SchemaRegistry) {
    if (!isOpenAPISpecLike(registry.spec)) {
      throw new Error("Registry spec is not a valid OpenAPI spec");
    }
    this.spec = registry.spec;
    this.registry = registry;
  }

  get paths(): PathsObject {
    return this.spec.paths;
  }

  /** The underlying raw spec object. */
  get rawSpec(): OpenAPIRaw {
    return this.spec;
  }

  /**
   * Resolved parameters for an operation.
   *
   * Merges path-level and operation-level parameters. Operation-level
   * overrides path-level when name+in match. Resolves $refs.
   * Path parameters have required=true (implicit per OpenAPI spec).
   */
  getParameters(pathPattern: string, method: string): ResolvedParameter[] {
    const pathItem = this.spec.paths[pathPattern];
    if (!pathItem) return [];

    const operation = this.getOperation(pathItem, method);
    if (!operation) return [];

    // Collect raw params: path-level first, then operation-level
    const pathLevelParams = pathItem.parameters ?? [];
    const operationParams = operation.parameters ?? [];

    // Resolve all $refs
    const resolvedPathLevel = pathLevelParams.map((p, i) =>
      this.resolveParamRef(p, pathPattern, "pathItem", undefined, i)
    ).filter(isDefined);

    const resolvedOpLevel = operationParams.map((p, i) =>
      this.resolveParamRef(p, pathPattern, "operation", method, i)
    ).filter(isDefined);

    // Merge: operation overrides path-level (by name + in)
    const merged = new Map<
      string,
      { param: ParameterObject; pointer: FragmentPointer }
    >();

    for (const entry of resolvedPathLevel) {
      const key = `${entry.param.in}:${entry.param.name}`;
      merged.set(key, entry);
    }
    for (const entry of resolvedOpLevel) {
      const key = `${entry.param.in}:${entry.param.name}`;
      merged.set(key, entry);
    }

    // Map to ResolvedParameter (resolving schema $refs via registry)
    return Array.from(merged.values()).map(({ param, pointer }) => {
      const { schema, schemaPath } = this.resolveSchemaRef(
        param.schema,
        `${pointer}/schema`,
      );

      return {
        name: param.name,
        in: param.in,
        // Path parameters are implicitly required per OpenAPI spec
        required: param.in === "path" ? true : param.required === true,
        schema,
        schemaPath,
        style: param.style,
        explode: param.explode,
      };
    });
  }

  /**
   * Body schema for an operation. null if no requestBody defined.
   * Currently supports application/json content type.
   */
  getBodySchema(pathPattern: string, method: string): BodySchemaInfo | null {
    const pathItem = this.spec.paths[pathPattern];
    if (!pathItem) return null;

    const operation = this.getOperation(pathItem, method);
    if (!operation) return null;

    if (!operation.requestBody) return null;

    // Resolve $ref if needed
    let requestBody: RequestBodyObject;
    if ("$ref" in operation.requestBody) {
      const resolved = this.resolveRef(operation.requestBody.$ref);
      if (!isRequestBodyLike(resolved)) return null;
      requestBody = resolved;
    } else {
      requestBody = operation.requestBody;
    }

    // Find application/json content
    const jsonContent = requestBody.content["application/json"];
    if (!jsonContent?.schema) return null;

    const escapedPath = escapeSegment(pathPattern);
    const inlinePointer: FragmentPointer =
      `#/paths/${escapedPath}/${method}/requestBody/content/application~1json/schema`;

    const { schema, schemaPath } = this.resolveSchemaRef(
      jsonContent.schema,
      inlinePointer,
    );
    if (!schema) return null;

    return {
      schema,
      schemaPath: schemaPath ?? inlinePointer,
      required: requestBody.required === true,
    };
  }

  /**
   * Whether an operation has at least one response defined.
   */
  hasResponses(pathPattern: string, method: string): boolean {
    const pathItem = this.spec.paths[pathPattern];
    if (!pathItem) return false;

    const operation = this.getOperation(pathItem, method);
    if (!operation) return false;

    return Object.keys(operation.responses).length > 0;
  }

  /**
   * Accepted content types for a request body.
   * Returns the keys of requestBody.content, or null if no requestBody.
   */
  getAcceptedContentTypes(
    pathPattern: string,
    method: string,
  ): string[] | null {
    const pathItem = this.spec.paths[pathPattern];
    if (!pathItem) return null;

    const operation = this.getOperation(pathItem, method);
    if (!operation) return null;

    if (!operation.requestBody) return null;

    // Resolve $ref if needed
    let requestBody: RequestBodyObject;
    if ("$ref" in operation.requestBody) {
      const resolved = this.resolveRef(operation.requestBody.$ref);
      if (!isRequestBodyLike(resolved)) return null;
      requestBody = resolved;
    } else {
      requestBody = operation.requestBody;
    }

    const keys = Object.keys(requestBody.content);
    return keys.length > 0 ? keys : null;
  }

  /**
   * Resolved response object for an operation and status code.
   * Handles $ref resolution. Returns null if not found.
   */
  getResponseObject(
    pathPattern: string,
    method: string,
    statusCode: string,
  ): ResponseObject | null {
    const pathItem = this.spec.paths[pathPattern];
    if (!pathItem) return null;

    const operation = this.getOperation(pathItem, method);
    if (!operation) return null;

    // Try exact code, then wildcard (e.g. "2XX"), then "default"
    const wildcard = statusCode.slice(0, 1) + "XX";
    const responseObjOrRef = operation.responses[statusCode] ??
      operation.responses[wildcard] ??
      operation.responses["default"];
    if (!responseObjOrRef) return null;

    // Resolve $ref if needed
    if ("$ref" in responseObjOrRef) {
      const resolved = this.resolveRef(responseObjOrRef.$ref);
      if (!isResponseLike(resolved)) return null;
      return resolved;
    }

    return responseObjOrRef;
  }

  /**
   * Resolve a schema by its fragment pointer in the spec.
   * Returns empty schema {} if the pointer can't be resolved.
   */
  resolveSchema(schemaPath: string): Schema {
    if (!isFragmentPointer(schemaPath)) return {};
    const result = this.registry.get(schemaPath);
    if (result && typeof result.raw === "object" && result.raw !== null) {
      return result.raw;
    }
    return {};
  }

  /**
   * Resolve any $ref in the spec. Works for schemas, parameters,
   * responses, headers, examples, or any other referenceable object.
   */
  resolveRef(ref: string): unknown {
    const result = this.registry.resolveRef(ref);
    if (result) return result.raw;
    return undefined;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private getOperation(
    pathItem: PathItemObject,
    method: string,
  ): OperationObject | undefined {
    const lower = method.toLowerCase();
    if (!isHttpMethod(lower)) return undefined;
    const ops: Pick<PathItemObject, HttpMethod> = pathItem;
    return ops[lower];
  }

  /**
   * Resolve a parameter that may be a $ref.
   * Returns the resolved ParameterObject and its JSON pointer in the spec.
   */
  private resolveParamRef(
    paramOrRef: ParameterObject | ReferenceObject,
    pathPattern: string,
    level: "pathItem" | "operation",
    method: string | undefined,
    index: number,
  ): { param: ParameterObject; pointer: FragmentPointer } | undefined {
    if ("$ref" in paramOrRef) {
      const resolved = this.resolveRef(paramOrRef.$ref);
      if (!isParameterLike(resolved)) return undefined;
      // Pointer for the $ref target (already a fragment pointer like #/components/...)
      const pointer: FragmentPointer = isFragmentPointer(paramOrRef.$ref)
        ? paramOrRef.$ref
        : `#${paramOrRef.$ref}`;
      return { param: resolved, pointer };
    }

    // Inline parameter. Compute its pointer
    const escapedPath = escapeSegment(pathPattern);
    let pointer: FragmentPointer;
    if (level === "pathItem") {
      pointer = `#/paths/${escapedPath}/parameters/${index}`;
    } else {
      pointer = `#/paths/${escapedPath}/${method}/parameters/${index}`;
    }

    return { param: paramOrRef, pointer };
  }

  /**
   * Resolve a schema that may be a $ref, following the reference
   * through the registry. Used for parameter and body schemas.
   */
  private resolveSchemaRef(
    rawSchema: ParameterObject["schema"],
    inlinePointer: FragmentPointer,
  ): { schema: Schema | null; schemaPath: FragmentPointer | null } {
    if (!rawSchema) return { schema: null, schemaPath: null };

    // If schema is a $ref, resolve through the registry
    if ("$ref" in rawSchema && typeof rawSchema.$ref === "string") {
      const resolved = this.resolveRef(rawSchema.$ref);
      if (isSchema(resolved)) {
        const schemaPath: FragmentPointer = isFragmentPointer(rawSchema.$ref)
          ? rawSchema.$ref
          : inlinePointer;
        return { schema: resolved, schemaPath };
      }
      return { schema: null, schemaPath: null };
    }

    // Inline schema
    if (!isSchema(rawSchema)) return { schema: null, schemaPath: null };
    return { schema: rawSchema, schemaPath: inlinePointer };
  }
}

// ── Utility functions ──────────────────────────────────────────────

function isHttpMethod(method: string): method is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(method);
}
