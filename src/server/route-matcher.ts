import type {
  OpenAPIRaw,
  OperationObject,
  PathItemObject,
} from "@steady/openapi";
import { MatchError } from "../errors.ts";
import { HTTP_METHODS, type HttpMethod, isHttpMethod } from "../types.ts";
import {
  compilePathPattern,
  matchCompiledPath,
  type PathSegment,
} from "../path-matcher.ts";

export type { HttpMethod, PathItemObject };

/** Pre-compiled path pattern with associated path item */
export interface CompiledPath {
  pattern: string;
  pathItem: PathItemObject;
  segments: PathSegment[];
  segmentCount: number;
  requiredQuery?: Record<string, string>;
}

/**
 * Pre-compile all routes for efficient matching.
 * Returns exact routes (Map for O(1) lookup) and pattern routes (sorted by specificity).
 */
export function compileRoutes(spec: OpenAPIRaw): {
  exactRoutes: Map<string, CompiledPath[]>;
  patternRoutes: CompiledPath[];
} {
  const exactRoutes = new Map<string, CompiledPath[]>();
  const patternRoutes: CompiledPath[] = [];

  for (const [pattern, pathItem] of Object.entries(spec.paths)) {
    // Parse query string from path if present (e.g., /files?beta=true)
    const queryIndex = pattern.indexOf("?");
    const basePath = queryIndex >= 0 ? pattern.slice(0, queryIndex) : pattern;
    const requiredQuery = queryIndex >= 0
      ? Object.fromEntries(new URLSearchParams(pattern.slice(queryIndex + 1)))
      : undefined;

    if (!basePath.includes("{")) {
      // Exact path - store in map by base path
      const entry: CompiledPath = {
        pattern,
        pathItem,
        segments: [],
        segmentCount: 0,
        requiredQuery,
      };
      const existing = exactRoutes.get(basePath) ?? [];
      existing.push(entry);
      exactRoutes.set(basePath, existing);
    } else {
      // Parameterized path
      const compiled = compilePathPattern(basePath);
      patternRoutes.push({
        ...compiled,
        pattern,
        pathItem,
        requiredQuery,
      });
    }
  }

  // Sort exact route entries: routes with requiredQuery first (more specific)
  for (const entries of exactRoutes.values()) {
    entries.sort((a, b) => {
      if (a.requiredQuery && !b.requiredQuery) return -1;
      if (!a.requiredQuery && b.requiredQuery) return 1;
      return 0;
    });
  }

  // Sort pattern routes by specificity (more literal segments first)
  // Then by requiredQuery presence (more specific first)
  patternRoutes.sort((a, b) => {
    const aLiterals = a.segments.filter((s) => s.type === "literal").length;
    const bLiterals = b.segments.filter((s) => s.type === "literal").length;
    if (bLiterals !== aLiterals) return bLiterals - aLiterals;
    if (a.requiredQuery && !b.requiredQuery) return -1;
    if (!a.requiredQuery && b.requiredQuery) return 1;
    return 0;
  });

  return { exactRoutes, patternRoutes };
}

/**
 * Check if request query params satisfy route's required query params
 */
export function matchesQueryRequirements(
  requestQuery: URLSearchParams,
  requiredQuery?: Record<string, string>,
): boolean {
  if (!requiredQuery) return true;
  for (const [key, value] of Object.entries(requiredQuery)) {
    if (requestQuery.get(key) !== value) return false;
  }
  return true;
}

/**
 * Find matching operation using pre-compiled routes
 */
export function findOperation(
  path: string,
  method: string,
  query: URLSearchParams,
  exactRoutes: Map<string, CompiledPath[]>,
  patternRoutes: CompiledPath[],
  spec: OpenAPIRaw,
): {
  operation: OperationObject;
  statusCode: string;
  pathPattern: string;
  pathParams: Record<string, string>;
  consumedQueryParams?: string[];
} {
  // Try exact match first (O(1) lookup)
  const exactMatches = exactRoutes.get(path);
  if (exactMatches) {
    // Routes are sorted: requiredQuery first, then no requiredQuery
    for (const entry of exactMatches) {
      if (matchesQueryRequirements(query, entry.requiredQuery)) {
        const operation = getOperationForMethod(
          entry.pathItem,
          method,
          entry.pattern,
        );
        const statusCode = selectStatusCode(operation);
        return {
          operation,
          statusCode,
          pathPattern: entry.pattern,
          pathParams: {},
          consumedQueryParams: entry.requiredQuery
            ? Object.keys(entry.requiredQuery)
            : undefined,
        };
      }
    }
  }

  // Try pattern matching with pre-compiled routes using shared utility
  // Track first path match for better error reporting when method not found
  let firstPathMatch: {
    pathItem: PathItemObject;
    pattern: string;
  } | null = null;

  for (const compiled of patternRoutes) {
    const params = matchCompiledPath(path, compiled);
    if (
      params && matchesQueryRequirements(query, compiled.requiredQuery)
    ) {
      // Path matches - check if method exists
      const operation = isHttpMethod(method)
        ? compiled.pathItem[method]
        : undefined;

      if (operation) {
        // Found a matching path AND method
        const statusCode = selectStatusCode(operation);
        return {
          operation,
          statusCode,
          pathPattern: compiled.pattern,
          pathParams: params,
          consumedQueryParams: compiled.requiredQuery
            ? Object.keys(compiled.requiredQuery)
            : undefined,
        };
      }

      // Path matches but method doesn't exist on this path item
      // Keep searching - another path with the same pattern might have the method
      // (e.g., /secrets/{secret_id} DELETE vs /secrets/{secret_key} POST)
      if (!firstPathMatch) {
        firstPathMatch = {
          pathItem: compiled.pathItem,
          pattern: compiled.pattern,
        };
      }
    }
  }

  // If we found at least one path match but no method match, report "method not allowed"
  if (firstPathMatch) {
    const availableMethods = getMethodsForPath(firstPathMatch.pathItem);
    throw new MatchError("Method not allowed", {
      httpPath: firstPathMatch.pattern,
      httpMethod: method.toUpperCase(),
      errorType: "match",
      reason:
        `Method ${method.toUpperCase()} not defined for path "${firstPathMatch.pattern}"`,
      suggestion: `Available methods: ${
        availableMethods.map((m) => m.toUpperCase()).join(", ")
      }`,
    });
  }

  // No match found
  const availablePaths = Object.keys(spec.paths);
  throw new MatchError("Path not found", {
    httpPath: path,
    httpMethod: method.toUpperCase(),
    errorType: "match",
    reason: `No path definition found for "${path}"`,
    suggestion: availablePaths.length > 0
      ? `Available paths: ${availablePaths.slice(0, 5).join(", ")}${
        availablePaths.length > 5 ? "..." : ""
      }`
      : "No paths defined in the OpenAPI spec",
  });
}

/**
 * Get operation for HTTP method with helpful error if not found
 */
export function getOperationForMethod(
  pathItem: PathItemObject,
  method: string,
  pathPattern: string,
): OperationObject {
  const operation = isHttpMethod(method) ? pathItem[method] : undefined;

  if (!operation) {
    const availableMethods = getMethodsForPath(pathItem);
    throw new MatchError("Method not allowed", {
      httpPath: pathPattern,
      httpMethod: method.toUpperCase(),
      errorType: "match",
      reason:
        `Method ${method.toUpperCase()} not defined for path "${pathPattern}"`,
      suggestion: `Available methods: ${
        availableMethods.map((m) => m.toUpperCase()).join(", ")
      }`,
    });
  }

  return operation;
}

/**
 * Select the best status code to return (prefer 200, then first available)
 *
 * OpenAPI allows "default" and "1XX", "2XX", etc. as response keys.
 * We only select numeric status codes; fallback to 200 if none found.
 */
export function selectStatusCode(operation: OperationObject): string {
  if (operation.responses["200"]) return "200";
  if (operation.responses["201"]) return "201";
  if (operation.responses["204"]) return "204";

  // Find first numeric status code, skip "default", "1XX", etc.
  const numericCode = Object.keys(operation.responses).find(
    (code) => /^\d{3}$/.test(code),
  );
  return numericCode || "200";
}

/**
 * Get available HTTP methods for a path item
 */
export function getMethodsForPath(pathItem: PathItemObject): HttpMethod[] {
  return HTTP_METHODS.filter((method) => pathItem[method] !== undefined);
}
