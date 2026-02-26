/**
 * Body Parser - Extract and parse HTTP request bodies.
 *
 * Handles HTTP-level concerns that happen before schema validation:
 * - Content-Length validation
 * - JSON parsing
 * - Form data parsing (multipart, URL-encoded)
 *
 * Returns either a parsed body or Diagnostic[] on failure.
 */

import type { Diagnostic } from "./diagnostic.ts";
import { getCode } from "./codes/registry.ts";
import {
  getMediaType,
  isFormMediaType,
  isJsonMediaType,
  parseFormData,
  parseUrlEncoded,
} from "./form-parser.ts";

export interface BodyParseResult {
  body: unknown;
  contentType: string;
}

export interface BodyParseError {
  diagnostics: Diagnostic[];
}

export type ParseResult = BodyParseResult | BodyParseError;

export function isParseError(r: ParseResult): r is BodyParseError {
  return "diagnostics" in r;
}

/**
 * Parse the request body, returning either the parsed body or diagnostics.
 *
 * @param req - The incoming Request
 * @param _acceptedContentTypes - Content types the operation accepts, or null to skip content-type checking
 */
export async function parseRequestBody(
  req: Request,
  _acceptedContentTypes: string[] | null,
): Promise<ParseResult> {
  // No Content-Type means no body to parse. Deno's HTTP server may set
  // req.body to an empty ReadableStream even for bodyless requests, so we
  // cannot rely on !req.body alone.
  if (!req.headers.get("content-type")) {
    return { body: undefined, contentType: "" };
  }

  // Check Content-Length header validity
  const contentLength = req.headers.get("content-length");
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (isNaN(size) || size < 0) {
      const def = getCode("E3019");
      return {
        diagnostics: [{
          code: "E3019",
          severity: def.severity,
          category: def.category,
          requestPath: "body",
          specPointer: "",
          message:
            `Invalid Content-Length header: "${contentLength}" is not a valid non-negative integer`,
          expected: "valid non-negative integer",
          actual: contentLength,
          attribution: {
            confidence: 0.95,
            reasoning: [
              "Content-Length must be a non-negative integer per HTTP/1.1 (RFC 9110)",
            ],
          },
          suggestion:
            "Ensure the HTTP client sets a valid Content-Length header",
        }],
      };
    }
  }

  const contentType = req.headers.get("content-type") ?? "";
  const mediaType = getMediaType(contentType);

  try {
    let parsedBody: unknown;

    if (isFormMediaType(mediaType)) {
      parsedBody = await parseFormBody(req.clone(), mediaType);
    } else if (isJsonMediaType(mediaType)) {
      const body = await readBody(req.clone());
      if (body === "") {
        // Empty body with JSON content-type: treat as "no body provided."
        // SDKs commonly set Content-Type: application/json on all requests,
        // including DELETE/cancel endpoints that have no body.
        // The diagnostic engine will emit E3005 if the spec requires a body.
        return { body: undefined, contentType: "" };
      }
      parsedBody = JSON.parse(body);
    } else {
      // Other content types: read as raw string
      parsedBody = await readBody(req.clone());
    }

    return { body: parsedBody, contentType: mediaType };
  } catch (error) {
    if (error instanceof SyntaxError) {
      const def = getCode("E3021");
      return {
        diagnostics: [{
          code: "E3021",
          severity: def.severity,
          category: def.category,
          requestPath: "body",
          specPointer: "",
          message: `Invalid ${mediaType} format: ${error.message}`,
          expected: `valid ${mediaType}`,
          attribution: {
            confidence: 0.95,
            reasoning: [
              `Request body could not be parsed as ${mediaType}`,
            ],
          },
          suggestion:
            "Ensure the request body is well-formed JSON or matches the declared content type",
        }],
      };
    }

    const def = getCode("E3021");
    return {
      diagnostics: [{
        code: "E3021",
        severity: def.severity,
        category: def.category,
        requestPath: "body",
        specPointer: "",
        message: `Failed to read request body: ${
          error instanceof Error ? error.message : String(error)
        }`,
        expected: "readable request body",
        attribution: {
          confidence: 0.8,
          reasoning: [
            "Request body could not be read from the stream",
          ],
        },
        suggestion: "Check the request encoding and content type",
      }],
    };
  }
}

/**
 * Read request body as a string.
 */
async function readBody(req: Request): Promise<string> {
  return await req.text();
}

/**
 * Parse form data body (multipart/form-data or application/x-www-form-urlencoded).
 * Uses simple defaults for array/object formats since the engine handles schema validation.
 */
async function parseFormBody(
  req: Request,
  mediaType: string,
): Promise<unknown> {
  if (mediaType === "multipart/form-data") {
    const formData = await req.formData();
    const parsed = parseFormData(formData, {
      formArrayFormat: "repeat",
      formObjectFormat: "flat",
    });
    return parsed.data;
  }

  // application/x-www-form-urlencoded
  const body = await readBody(req);
  const parsed = parseUrlEncoded(body, {
    formArrayFormat: "repeat",
    formObjectFormat: "flat",
  });
  return parsed.data;
}
