import type { ResponseObject } from "../types.ts";
import { HEADERS, isReference } from "../types.ts";
import type { ReferenceObject } from "@steady/openapi";
import { OpenAPISpec } from "@steady/openapi";
import { RegistryResponseGenerator } from "@steady/json-schema";
import type {
  GenerateOptions,
  Schema,
  SchemaRegistry,
} from "@steady/json-schema";
import {
  escapeSegment,
  isFragmentPointer,
  isPlainObject,
} from "@steady/json-pointer";
import type { Logger } from "../logging/logger.ts";
import type { Diagnostic } from "../diagnostic.ts";
import type { DiagnosticCollector } from "../diagnostics/collector.ts";
import { isMinimalResponse } from "../diagnostics/response-check.ts";
import {
  createStreamingResponse,
  getStreamFormat,
  isStreamingContentType,
  type StreamingOptions,
} from "../streaming.ts";

/** Status codes that MUST NOT have a response body (101, 204, 205, 304). */
const NULL_BODY_STATUS_STRINGS = new Set(["101", "204", "205", "304"]);

/**
 * Parse Accept header into array of media types, sorted by quality value (q).
 * Returns types in preference order (highest q first).
 */
export function parseAcceptHeader(header: string | null): string[] {
  if (!header) return [];

  const entries: { type: string; q: number }[] = [];
  for (const part of header.split(",")) {
    const segments = part.split(";");
    const type = segments[0]?.trim();
    if (!type) continue;

    let q = 1.0;
    for (let i = 1; i < segments.length; i++) {
      const param = segments[i]?.trim();
      if (param?.startsWith("q=")) {
        q = parseFloat(param.slice(2)) || 1.0;
        break;
      }
    }
    entries.push({ type, q });
  }

  entries.sort((a, b) => b.q - a.q);

  const result: string[] = [];
  for (const entry of entries) {
    result.push(entry.type);
  }
  return result;
}

/**
 * Check if Accept header types include JSON (application/json or wildcard).
 */
export function acceptsJson(acceptTypes: string[]): boolean {
  for (const t of acceptTypes) {
    if (t === "application/json" || t === "*/*") {
      return true;
    }
  }
  return false;
}

/**
 * Generate response from a resolved ResponseObject
 */
export function generateResponseFromObject(
  specDoc: OpenAPISpec,
  logger: Logger,
  collector: DiagnosticCollector,
  requestAcceptHeader: string | null,
  responseObj: ResponseObject,
  statusCode: string,
  path: string,
  method: string,
  pathPattern: string,
  generatorOptions: GenerateOptions,
  streamingOptions: StreamingOptions,
): {
  response: Response;
  body?: unknown;
  minimal?: boolean;
  nullBodyStripped?: boolean;
} {
  const registry = specDoc.registry;
  let body: unknown = null;
  let contentType: string | null = null;
  let minimal = false;
  let nullBodyStripped = false;

  const acceptTypes = parseAcceptHeader(requestAcceptHeader);

  if (responseObj.content) {
    const contentKeys = Object.keys(responseObj.content);
    if (contentKeys.length === 0) {
      // Content object exists but is empty - this is unusual and likely a spec issue
      logger.warning(
        `Response for ${method.toUpperCase()} ${path} has empty content object. Using default application/json with no body.`,
      );
    }

    // Select content type based on Accept header
    // Priority: Accept header match > first content type in spec
    let selectedContentType: string | undefined;
    for (const acceptType of acceptTypes) {
      if (contentKeys.includes(acceptType)) {
        selectedContentType = acceptType;
        break;
      }
      // Handle wildcards like "*/*"
      if (acceptType === "*/*") {
        selectedContentType = contentKeys[0];
        break;
      }
    }
    // Default to first content type in spec
    if (!selectedContentType) {
      selectedContentType = contentKeys[0];
    }

    // Check if selected content type is streaming
    if (selectedContentType && isStreamingContentType(selectedContentType)) {
      const mediaType = responseObj.content[selectedContentType];
      if (mediaType?.schema || mediaType?.example) {
        // Pass example to streaming options for SSE event sequences
        if (mediaType.example !== undefined) {
          streamingOptions.example = mediaType.example;
        }
        // Streaming responses need a schema to generate from
        if (mediaType.schema) {
          return {
            response: generateStreamingResponse(
              registry,
              logger,
              mediaType.schema,
              pathPattern,
              method,
              statusCode,
              selectedContentType,
              streamingOptions,
            ),
            body: "[streaming]",
          };
        }
      }
    }

    // Use selected content type or fall back to JSON
    const mediaType = selectedContentType
      ? responseObj.content[selectedContentType]
      : responseObj.content["application/json"] ||
        Object.values(responseObj.content)[0];

    if (mediaType) {
      contentType = selectedContentType ?? "application/json";

      // Priority 1: Explicit example
      if (mediaType.example !== undefined) {
        body = mediaType.example;
      } // Priority 2: First example from examples map
      else if (
        mediaType.examples && Object.keys(mediaType.examples).length > 0
      ) {
        const firstExampleOrRef = Object.values(mediaType.examples)[0];
        if (firstExampleOrRef) {
          if (isReference(firstExampleOrRef)) {
            // Resolve $ref to ExampleObject and extract .value
            const resolved = specDoc.resolveRef(firstExampleOrRef.$ref);
            if (isPlainObject(resolved) && "value" in resolved) {
              body = resolved.value;
            }
          } else if (firstExampleOrRef.value !== undefined) {
            body = firstExampleOrRef.value;
          }
        }
      }

      // Priority 3: Generate from schema (also serves as fallback when
      // examples were all unresolvable $refs)
      if (body === null && mediaType.schema) {
        body = generateFromSchemaObject(
          registry,
          mediaType.schema,
          pathPattern,
          method,
          statusCode,
          generatorOptions,
        );

        if (isMinimalResponse(body, mediaType.schema)) {
          collector.trackGenerationWarning(method, pathPattern);
          minimal = true;
        }
      }
    }
  } else if (
    acceptsJson(acceptTypes) && !NULL_BODY_STATUS_STRINGS.has(statusCode)
  ) {
    // No content defined in spec, but client accepts JSON - return empty object
    // (except for null-body statuses which must not have a body)
    contentType = "application/json";
    body = {};
  }

  const headers = new Headers({
    [HEADERS.MATCHED_PATH]: pathPattern,
    [HEADERS.EXAMPLE_SOURCE]: body !== null ? "generated" : "none",
  });
  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  // 3xx redirects require a Location header per RFC 9110.
  // Priority: 1) header example, 2) schema default, 3) synthetic fallback.
  const numericStatus = parseInt(statusCode, 10);
  if (numericStatus >= 300 && numericStatus < 400) {
    const location = resolveLocationHeader(specDoc, responseObj);
    headers.set("Location", location);
  }

  // Null-body status codes must not have a body per HTTP semantics.
  // Some specs incorrectly define content for these. Strip it to avoid crashes.
  const isNullBodyStatus = NULL_BODY_STATUS_STRINGS.has(statusCode);
  if (isNullBodyStatus && body !== null) {
    body = null;
    contentType = null;
    headers.delete("Content-Type");
    nullBodyStripped = true;
  }

  // Safely stringify body - handle circular references and non-serializable values
  let bodyString: string | null = null;
  if (body !== null) {
    try {
      bodyString = JSON.stringify(body, null, 2);
    } catch (error) {
      // Handle non-serializable values (circular refs, BigInt, etc.)
      const errorMessage = error instanceof Error
        ? error.message
        : "Unknown serialization error";
      logger.warning(
        `Failed to serialize response body: ${errorMessage}`,
        {
          hint:
            "Response contains non-serializable values (circular references, BigInt, etc.)",
        },
      );
      bodyString = JSON.stringify(
        {
          error: "Response serialization failed",
          reason: errorMessage,
          hint:
            "The generated response contains non-serializable values (circular references, BigInt, etc.)",
        },
        null,
        2,
      );
      headers.set(HEADERS.SERIALIZATION_ERROR, "true");
    }
  }

  return {
    response: new Response(
      bodyString,
      {
        status: parseInt(statusCode, 10),
        headers,
      },
    ),
    body,
    minimal,
    nullBodyStripped,
  };
}

/**
 * Generate a streaming response (NDJSON or SSE)
 */
function generateStreamingResponse(
  registry: SchemaRegistry,
  logger: Logger,
  schema: Schema | ReferenceObject,
  pathPattern: string,
  method: string,
  statusCode: string,
  contentType: string,
  streamingOptions: StreamingOptions,
): Response {
  const format = getStreamFormat(contentType);
  if (!format) {
    // Fallback to JSON if format detection fails
    throw new Error(`Unknown streaming format: ${contentType}`);
  }

  const schemaPointer = `#/paths/${
    escapeSegment(pathPattern)
  }/${method}/responses/${statusCode}/content/${
    escapeSegment(contentType)
  }/schema`;

  const { stream, warnings } = createStreamingResponse(
    registry,
    schema,
    schemaPointer,
    format,
    streamingOptions,
  );
  for (const w of warnings) {
    logger.warning(w);
  }

  const headers = new Headers({
    "Content-Type": contentType,
    [HEADERS.MATCHED_PATH]: pathPattern,
    [HEADERS.EXAMPLE_SOURCE]: "generated",
    [HEADERS.STREAMING]: "true",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  // For SSE, add specific headers
  if (format === "sse") {
    headers.set("X-Accel-Buffering", "no"); // Disable nginx buffering
  }

  return new Response(stream, {
    status: parseInt(statusCode, 10),
    headers,
  });
}

/**
 * Generate data from a schema object using the registry
 */
function generateFromSchemaObject(
  registry: SchemaRegistry,
  schema: Schema | ReferenceObject,
  pathPattern: string,
  method: string,
  statusCode: string,
  generatorOptions: GenerateOptions,
): unknown {
  const generator = new RegistryResponseGenerator(registry, generatorOptions);

  // If schema is a $ref, resolve and generate via the registry
  if (
    "$ref" in schema && typeof schema.$ref === "string" &&
    isFragmentPointer(schema.$ref)
  ) {
    return generator.generate(schema.$ref);
  }

  // Inline schema: generate directly
  return generator.generateFromSchema(
    schema,
    `#/paths/${
      escapeSegment(pathPattern)
    }/${method}/responses/${statusCode}/content/application~1json/schema`,
  );
}

/**
 * Resolve a Location header value for 3xx responses.
 * Priority: 1) header example, 2) schema default, 3) /_x-steady/redirected.
 */
function resolveLocationHeader(
  specDoc: OpenAPISpec,
  responseObj: ResponseObject,
): string {
  if (responseObj.headers) {
    // Find Location header (case-insensitive)
    const locationKey = Object.keys(responseObj.headers).find(
      (h) => h.toLowerCase() === "location",
    );
    if (locationKey) {
      let headerDef = responseObj.headers[locationKey];

      // Resolve header-level $ref
      if (headerDef && isReference(headerDef)) {
        const resolved = specDoc.resolveRef(headerDef.$ref);
        if (isPlainObject(resolved)) {
          headerDef = resolved;
        }
      }

      if (headerDef && !isReference(headerDef)) {
        // 1) Explicit example on the header
        if (headerDef.example !== undefined) {
          return String(headerDef.example);
        }
        // 2) Default from the schema
        if (headerDef.schema) {
          let schemaDef = headerDef.schema;

          // Resolve schema-level $ref
          if (isReference(schemaDef)) {
            const resolved = specDoc.resolveRef(schemaDef.$ref);
            if (isPlainObject(resolved)) {
              schemaDef = resolved;
            }
          }

          if (!isReference(schemaDef) && schemaDef.default !== undefined) {
            return String(schemaDef.default);
          }
        }
      }
    }
  }
  // 3) Synthetic fallback
  return "/_x-steady/redirected";
}

/**
 * Add X-Steady-* diagnostic headers to a response.
 * X-Steady-Request-Valid is false when any sdk-issue diagnostic is present.
 */
export function addDiagnosticHeaders(
  response: Response,
  diagnostics: Diagnostic[],
): Response {
  const newHeaders = new Headers(response.headers);
  const hasSdkIssues = diagnostics.some((d) => d.category === "sdk-issue");

  newHeaders.set("X-Steady-Request-Valid", hasSdkIssues ? "false" : "true");
  newHeaders.set("X-Steady-Error-Count", String(diagnostics.length));

  diagnostics.forEach((d, i) => {
    const n = i + 1;
    newHeaders.set(`X-Steady-Error-${n}-Code`, d.code);
    newHeaders.set(`X-Steady-Error-${n}-Path`, d.requestPath);
    newHeaders.set(`X-Steady-Error-${n}-Message`, d.message);
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
