/**
 * JSON Pointer utilities for OpenAPI reference resolution
 */

/**
 * A JSON Pointer used as a URI fragment (RFC 3986 + RFC 6901).
 * Always starts with "#", e.g. "#/components/schemas/User" or "#" (root).
 *
 * Template literal type so bare pointers like "/foo" are a compile-time
 * error wherever a FragmentPointer is expected.
 */
export type FragmentPointer = `#${string}`;

/** Type guard: narrows a string to FragmentPointer if it starts with "#". */
export function isFragmentPointer(s: string): s is FragmentPointer {
  return s.startsWith("#");
}

export {
  escapeSegment,
  exists,
  formatPointer,
  JsonPointerError,
  listPointers,
  parsePointer,
  resolve,
  set,
  unescapeSegment,
} from "./json-pointer.ts";

export {
  findCircularReferences,
  getAllReferences,
  isValidReference,
  resolveReference,
} from "./resolver.ts";

export {
  explainInvalidRef,
  needsEscaping,
  type PointerValidationResult,
  validatePointer,
  validateRef,
  // Backwards compatibility alias
  type ValidationResult,
} from "./rfc6901-validator.ts";
