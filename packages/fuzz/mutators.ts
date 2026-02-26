/**
 * Mutation strategies for fuzz testing.
 *
 * Each mutator is an object with an `id` and an `apply` method.
 * `apply` takes an OperationInfo and a valid baseline FuzzRequest,
 * then returns MutatedCase[] where exactly one thing is broken.
 * If the mutator doesn't apply, it returns [].
 */

import { isSchema } from "@steady/json-schema";
import { isPlainObject } from "@steady/json-pointer";
import type { FuzzRequest, MutatedCase, Mutator } from "./types.ts";

function cloneRequest(req: FuzzRequest): FuzzRequest {
  return {
    path: req.path,
    method: req.method,
    headers: { ...req.headers },
    query: { ...req.query },
    body: req.body !== undefined ? structuredClone(req.body) : undefined,
  };
}

// ── Mutators ──────────────────────────────────────────────────────

export const removeRequiredQueryParam: Mutator = {
  id: "removeRequiredQueryParam",
  apply(op, baseline) {
    const cases: MutatedCase[] = [];
    for (const param of op.queryParams) {
      if (!param.required) continue;
      const req = cloneRequest(baseline);
      delete req.query[param.name];
      cases.push({
        mutation: `remove required query param '${param.name}'`,
        request: req,
        expectedCodes: ["E3002"],
        detail: { location: "query" },
      });
    }
    return cases;
  },
};

// Headers that the fetch() API manages automatically. Removing these from
// the headers object has no effect on the wire, so mutations targeting
// them would always be false positives.
const FETCH_MANAGED_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-length",
  "host",
  "transfer-encoding",
  "user-agent",
]);

export const removeRequiredHeaderParam: Mutator = {
  id: "removeRequiredHeaderParam",
  apply(op, baseline) {
    const cases: MutatedCase[] = [];
    for (const param of op.headerParams) {
      if (!param.required) continue;
      if (FETCH_MANAGED_HEADERS.has(param.name.toLowerCase())) continue;
      const req = cloneRequest(baseline);
      const lowerName = param.name.toLowerCase();
      for (const key of Object.keys(req.headers)) {
        if (key.toLowerCase() === lowerName) {
          delete req.headers[key];
        }
      }
      cases.push({
        mutation: `remove required header '${param.name}'`,
        request: req,
        expectedCodes: ["E3004"],
        detail: { location: "header" },
      });
    }
    return cases;
  },
};

export const wrongContentType: Mutator = {
  id: "wrongContentType",
  apply(op, baseline) {
    if (!op.bodyInfo) return [];
    if (op.bodyInfo.contentTypes.length === 0) return [];

    const accepted = new Set(
      op.bodyInfo.contentTypes.map((ct) => ct.toLowerCase()),
    );
    const wrong = "text/plain";
    if (accepted.has(wrong)) return [];

    const req = cloneRequest(baseline);
    req.headers["content-type"] = wrong;

    return [{
      mutation: `wrong Content-Type: '${wrong}' instead of '${
        op.bodyInfo.contentTypes[0]
      }'`,
      request: req,
      expectedCodes: ["E3006"],
      detail: { location: "contentType" },
    }];
  },
};

export const omitRequiredBody: Mutator = {
  id: "omitRequiredBody",
  apply(op, baseline) {
    if (!op.bodyInfo) return [];
    if (!op.bodyInfo.required) return [];

    const req = cloneRequest(baseline);
    delete req.body;
    delete req.headers["content-type"];

    return [{
      mutation: "omit required request body",
      request: req,
      expectedCodes: ["E3005"],
      detail: { location: "body" },
    }];
  },
};

export const omitRequiredBodyField: Mutator = {
  id: "omitRequiredBodyField",
  apply(op, baseline) {
    if (!op.bodyInfo) return [];
    const schema = op.bodyInfo.schema;
    const requiredFields = schema.required;
    if (!requiredFields || requiredFields.length === 0) return [];
    if (!isPlainObject(baseline.body)) return [];

    const cases: MutatedCase[] = [];
    for (const field of requiredFields) {
      const req = cloneRequest(baseline);
      if (isPlainObject(req.body)) {
        delete req.body[field];
      }
      // readOnly fields are excluded from required checks during request
      // validation, so omitting them should be accepted as valid.
      const readOnly = isReadOnlyField(schema, field);
      cases.push({
        mutation: `omit required body field '${field}'`,
        request: req,
        expectedCodes: readOnly ? [] : ["E3008"],
        detail: { location: "body", fieldDepth: 0 },
      });
    }
    return cases;
  },
};

export const wrongBodyFieldType: Mutator = {
  id: "wrongBodyFieldType",
  apply(op, baseline) {
    if (!op.bodyInfo) return [];
    const properties = op.bodyInfo.schema.properties;
    if (!properties) return [];
    if (!isPlainObject(baseline.body)) return [];

    const cases: MutatedCase[] = [];
    for (const [field, propSchemaRaw] of Object.entries(properties)) {
      if (!isSchema(propSchemaRaw)) continue;
      const type = Array.isArray(propSchemaRaw.type)
        ? propSchemaRaw.type[0]
        : propSchemaRaw.type;
      if (!type) continue;

      const wrongValue = getWrongTypeValue(type);
      if (wrongValue === undefined) continue;

      const req = cloneRequest(baseline);
      if (isPlainObject(req.body)) {
        req.body[field] = wrongValue;
      }

      cases.push({
        mutation:
          `wrong type for body field '${field}': sent ${typeof wrongValue} instead of ${type}`,
        request: req,
        expectedCodes: ["E3008"],
        detail: { location: "body", fieldType: type, fieldDepth: 0 },
      });
    }
    return cases;
  },
};

export const extraProperty: Mutator = {
  id: "extraProperty",
  apply(op, baseline) {
    if (!op.bodyInfo) return [];
    if (op.bodyInfo.schema.additionalProperties !== false) return [];
    if (!isPlainObject(baseline.body)) return [];

    const req = cloneRequest(baseline);
    if (isPlainObject(req.body)) {
      req.body["__fuzz_extra_field__"] = "should-not-be-allowed";
    }

    return [{
      mutation: "add extra property when additionalProperties: false",
      request: req,
      expectedCodes: ["E3009"],
      detail: { location: "body" },
    }];
  },
};

export const wrongEnumValue: Mutator = {
  id: "wrongEnumValue",
  apply(op, baseline) {
    if (!op.bodyInfo) return [];
    const properties = op.bodyInfo.schema.properties;
    if (!properties) return [];
    if (!isPlainObject(baseline.body)) return [];

    const cases: MutatedCase[] = [];
    for (const [field, propSchemaRaw] of Object.entries(properties)) {
      if (!isSchema(propSchemaRaw)) continue;
      if (!propSchemaRaw.enum || propSchemaRaw.enum.length === 0) continue;

      const req = cloneRequest(baseline);
      if (isPlainObject(req.body)) {
        req.body[field] = "__FUZZ_NOT_IN_ENUM__";
      }

      cases.push({
        mutation: `wrong enum value for body field '${field}'`,
        request: req,
        expectedCodes: ["E3011", "E3016"],
        detail: { location: "body" },
      });
    }
    return cases;
  },
};

/** All built-in mutators in priority order. */
export const ALL_MUTATORS: Mutator[] = [
  removeRequiredQueryParam,
  removeRequiredHeaderParam,
  wrongContentType,
  omitRequiredBody,
  omitRequiredBodyField,
  wrongBodyFieldType,
  extraProperty,
  wrongEnumValue,
];

// ── Helpers ───────────────────────────────────────────────────────

/** Check if a field in a schema is marked readOnly. */
function isReadOnlyField(
  schema: { properties?: unknown },
  field: string,
): boolean {
  const props = schema.properties;
  if (!props || typeof props !== "object") return false;
  const propSchema = (props as Record<string, unknown>)[field];
  if (!propSchema || typeof propSchema !== "object") return false;
  return (propSchema as Record<string, unknown>).readOnly === true;
}

function getWrongTypeValue(
  expectedType: string,
): string | number | boolean | unknown[] | Record<string, unknown> | undefined {
  switch (expectedType) {
    case "string":
      return 99999;
    case "integer":
    case "number":
      return "not-a-number";
    case "boolean":
      return "not-a-boolean";
    case "array":
      return "not-an-array";
    case "object":
      return "not-an-object";
    default:
      return undefined;
  }
}
