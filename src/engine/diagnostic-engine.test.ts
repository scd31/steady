import { assertEquals } from "@std/assert";
import type { OperationObject, PathsObject } from "@steady/openapi";
import type { Schema } from "@steady/json-schema";
import type { FragmentPointer } from "@steady/json-pointer";
import type { ValidationNode } from "./types.ts";
import {
  type BodySchemaInfo,
  DiagnosticEngine,
  type ResolvedParameter,
  type SchemaValidator,
  type Spec,
} from "./diagnostic-engine.ts";
import { Router } from "../router.ts";

// ── Test stubs ──────────────────────────────────────────────────────

/** Minimal valid operation for path routing. */
const OP: OperationObject = {
  responses: { "200": { description: "OK" } },
};

/**
 * Stub implementation of Spec for testing.
 *
 * Returns pre-configured data regardless of pathPattern/method.
 * Tests configure the stub with the data the engine should see.
 */
class StubSpec implements Spec {
  /** Paths used to construct the Router. Not part of the Spec interface. */
  readonly paths: PathsObject;
  parameters: ResolvedParameter[] = [];
  bodySchema: BodySchemaInfo | null = null;
  responses = true;
  schemas = new Map<string, Schema>();
  acceptedContentTypes: string[] | null = null;

  constructor(paths: PathsObject) {
    this.paths = paths;
  }

  getParameters(
    _pathPattern: string,
    _method: string,
  ): ResolvedParameter[] {
    return this.parameters;
  }

  getBodySchema(
    _pathPattern: string,
    _method: string,
    _contentType: string,
  ): BodySchemaInfo | null {
    return this.bodySchema;
  }

  hasResponses(
    _pathPattern: string,
    _method: string,
  ): boolean {
    return this.responses;
  }

  getAcceptedContentTypes(
    _pathPattern: string,
    _method: string,
  ): string[] | null {
    return this.acceptedContentTypes;
  }

  resolveSchema(schemaPath: string): Schema {
    return this.schemas.get(schemaPath) ?? {};
  }
}

/**
 * Stub validator that returns pre-configured trees by schema path.
 * Returns a valid tree by default if no tree is registered.
 */
class StubValidator implements SchemaValidator {
  private trees = new Map<string, ValidationNode>();

  register(schemaPath: string, tree: ValidationNode): void {
    this.trees.set(schemaPath, tree);
  }

  validate(
    _data: unknown,
    _schema: Schema,
    schemaPath: FragmentPointer,
    dataPath: string[],
  ): ValidationNode {
    return (
      this.trees.get(schemaPath) ?? {
        valid: true,
        path: dataPath,
        schemaPath,
      }
    );
  }
}

/** Helper: create a DiagnosticEngine with a Router from the StubSpec's paths. */
function createEngine(
  spec: StubSpec,
  validator: StubValidator = new StubValidator(),
): DiagnosticEngine {
  const router = new Router(spec.paths);
  return new DiagnosticEngine(spec, validator, router);
}

// ── Tests ───────────────────────────────────────────────────────────

Deno.test("DiagnosticEngine", async (t) => {
  // ── Routing integration ─────────────────────────────────────────

  await t.step("route not found → E2001", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    const engine = createEngine(spec);

    const result = engine.analyze({ path: "/posts", method: "get" });

    assertEquals(result.length, 1);
    assertEquals(result[0]!.code, "E2001");
  });

  await t.step("method not allowed → E2002", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    const engine = createEngine(spec);

    const result = engine.analyze({ path: "/users", method: "delete" });

    assertEquals(result.length, 1);
    assertEquals(result[0]!.code, "E2002");
  });

  // ── Spec issues ─────────────────────────────────────────────────

  await t.step("no responses → E1010", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.responses = false;
    const engine = createEngine(spec);

    const result = engine.analyze({ path: "/users", method: "get" });

    assertEquals(result.length, 1);
    assertEquals(result[0]!.code, "E1010");
    assertEquals(result[0]!.category, "spec-issue");
  });

  // ── Parameter presence ──────────────────────────────────────────

  await t.step("missing required query param → E3002", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "limit",
        in: "query",
        required: true,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const result = engine.analyze({ path: "/users", method: "get" });

    assertEquals(result.length, 1);
    assertEquals(result[0]!.code, "E3002");
    assertEquals(result[0]!.category, "sdk-issue");
    assertEquals(result[0]!.requestPath, "query.limit");
  });

  await t.step("missing required header → E3004", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "X-Api-Key",
        in: "header",
        required: true,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const result = engine.analyze({ path: "/users", method: "get" });

    assertEquals(result.length, 1);
    assertEquals(result[0]!.code, "E3004");
    assertEquals(result[0]!.category, "sdk-issue");
    assertEquals(result[0]!.requestPath, "header.X-Api-Key");
  });

  await t.step("optional param missing → no diagnostic", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "limit",
        in: "query",
        required: false,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const result = engine.analyze({ path: "/users", method: "get" });

    assertEquals(result.length, 0);
  });

  await t.step("required params present → no diagnostic", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "limit",
        in: "query",
        required: true,
        schema: null,
        schemaPath: null,
      },
      {
        name: "X-Api-Key",
        in: "header",
        required: true,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const queryParams = new URLSearchParams();
    queryParams.set("limit", "10");

    const result = engine.analyze({
      path: "/users",
      method: "get",
      queryParams,
      headers: { "x-api-key": "secret" },
    });

    assertEquals(result.length, 0);
  });

  await t.step("header matching is case-insensitive", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "X-Api-Key",
        in: "header",
        required: true,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "get",
      headers: { "x-api-key": "secret" },
    });

    assertEquals(result.length, 0);
  });

  await t.step("multiple missing params → multiple diagnostics", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "limit",
        in: "query",
        required: true,
        schema: null,
        schemaPath: null,
      },
      {
        name: "offset",
        in: "query",
        required: true,
        schema: null,
        schemaPath: null,
      },
      {
        name: "X-Api-Key",
        in: "header",
        required: true,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const result = engine.analyze({ path: "/users", method: "get" });

    assertEquals(result.length, 3);
    const codes = result.map((d) => d.code);
    assertEquals(codes.filter((c) => c === "E3002").length, 2);
    assertEquals(codes.filter((c) => c === "E3004").length, 1);
  });

  // ── Body validation ─────────────────────────────────────────────

  await t.step("body validation: tree with failure → diagnostic", () => {
    const bodySchemaPath =
      "#/paths/~1users/post/requestBody/content/application~1json/schema";
    const leafSchemaPath: FragmentPointer = `${bodySchemaPath}/properties/name`;

    const bodySchema: Schema = {
      type: "object",
      required: ["name"],
    };

    const validator = new StubValidator();
    validator.register(bodySchemaPath, {
      valid: false,
      path: ["body"],
      schemaPath: bodySchemaPath,
      children: [
        {
          valid: false,
          keyword: "required",
          path: ["body", "name"],
          schemaPath: leafSchemaPath,
          field: "name",
        },
      ],
    });

    const spec = new StubSpec({ "/users": { post: OP } });
    spec.bodySchema = {
      schema: bodySchema,
      schemaPath: bodySchemaPath,
      required: true,
    };
    spec.schemas.set(leafSchemaPath, {});

    const engine = createEngine(spec, validator);

    const result = engine.analyze({
      path: "/users",
      method: "post",
      body: {},
    });

    assertEquals(result.length, 1);
    assertEquals(result[0]!.code, "E3007");
  });

  await t.step("no body schema → no body diagnostics", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    // bodySchema is null by default
    const engine = createEngine(spec);

    const result = engine.analyze({ path: "/users", method: "get" });

    assertEquals(result.length, 0);
  });

  await t.step("required body missing → E3005", () => {
    const spec = new StubSpec({ "/users": { post: OP } });
    spec.bodySchema = {
      schema: { type: "object" },
      schemaPath: "#/paths/~1users/post/requestBody/...",
      required: true,
    };
    const engine = createEngine(spec);

    // No body in request
    const result = engine.analyze({ path: "/users", method: "post" });

    assertEquals(result.length, 1);
    assertEquals(result[0]!.code, "E3005");
    assertEquals(result[0]!.category, "sdk-issue");
  });

  await t.step(
    "optional body missing → no diagnostics",
    () => {
      const spec = new StubSpec({ "/users": { post: OP } });
      spec.bodySchema = {
        schema: { type: "object" },
        schemaPath: "#/paths/~1users/post/requestBody/...",
        required: false,
      };
      const engine = createEngine(spec);

      const result = engine.analyze({ path: "/users", method: "post" });

      assertEquals(result.length, 0);
    },
  );

  await t.step("body schema but no body in request → no diagnostics", () => {
    const spec = new StubSpec({ "/users": { post: OP } });
    spec.bodySchema = {
      schema: { type: "object" },
      schemaPath: "#/paths/~1users/post/requestBody/...",
      required: false,
    };
    const engine = createEngine(spec);

    // No body in request
    const result = engine.analyze({ path: "/users", method: "post" });

    assertEquals(result.length, 0);
  });

  // ── Full flow ───────────────────────────────────────────────────

  await t.step("full flow: param missing + body error → both", () => {
    const bodySchemaPath =
      "#/paths/~1users/post/requestBody/content/application~1json/schema";
    const leafSchemaPath: FragmentPointer =
      `${bodySchemaPath}/properties/email`;

    const validator = new StubValidator();
    validator.register(bodySchemaPath, {
      valid: false,
      path: ["body"],
      schemaPath: bodySchemaPath,
      children: [
        {
          valid: false,
          keyword: "pattern",
          path: ["body", "email"],
          schemaPath: leafSchemaPath,
        },
      ],
    });

    const spec = new StubSpec({ "/users": { post: OP } });
    spec.parameters = [
      {
        name: "X-Api-Key",
        in: "header",
        required: true,
        schema: null,
        schemaPath: null,
      },
    ];
    spec.bodySchema = {
      schema: { type: "object" },
      schemaPath: bodySchemaPath,
      required: true,
    };
    spec.schemas.set(leafSchemaPath, { pattern: "^.+@.+$" });

    const engine = createEngine(spec, validator);

    const result = engine.analyze({
      path: "/users",
      method: "post",
      body: { email: "bad" },
    });

    assertEquals(result.length, 2);
    assertEquals(result[0]!.code, "E3004"); // missing header
    assertEquals(result[1]!.code, "E4002"); // pattern mismatch
  });

  // ── Parameter value validation ──────────────────────────────────

  await t.step(
    "present query param with schema: validation failure → diagnostic",
    () => {
      const paramSchemaPath = "#/paths/~1users/get/parameters/0/schema";

      const validator = new StubValidator();
      validator.register(paramSchemaPath, {
        valid: false,
        path: ["query", "limit"],
        schemaPath: paramSchemaPath,
        keyword: "type",
        expected: "integer",
        actual: "string",
      });

      const spec = new StubSpec({ "/users": { get: OP } });
      spec.parameters = [
        {
          name: "limit",
          in: "query",
          required: true,
          schema: { type: "integer" },
          schemaPath: paramSchemaPath,
        },
      ];
      spec.schemas.set(paramSchemaPath, { type: "integer" });

      const engine = createEngine(spec, validator);
      const queryParams = new URLSearchParams();
      queryParams.set("limit", "abc");

      const result = engine.analyze({
        path: "/users",
        method: "get",
        queryParams,
      });

      assertEquals(result.length, 1);
      assertEquals(result[0]!.code, "E3003");
    },
  );

  await t.step(
    "present query param with no schema → no value validation",
    () => {
      const spec = new StubSpec({ "/users": { get: OP } });
      spec.parameters = [
        {
          name: "limit",
          in: "query",
          required: true,
          schema: null,
          schemaPath: null,
        },
      ];
      const engine = createEngine(spec);

      const queryParams = new URLSearchParams();
      queryParams.set("limit", "abc");

      const result = engine.analyze({
        path: "/users",
        method: "get",
        queryParams,
      });

      assertEquals(result.length, 0);
    },
  );

  await t.step(
    "present header param with schema: validation failure → diagnostic",
    () => {
      const paramSchemaPath = "#/paths/~1users/get/parameters/0/schema";

      const validator = new StubValidator();
      validator.register(paramSchemaPath, {
        valid: false,
        path: ["header", "X-Count"],
        schemaPath: paramSchemaPath,
        keyword: "enum",
        actual: "bad",
        expected: ["a", "b"],
      });

      const spec = new StubSpec({ "/users": { get: OP } });
      spec.parameters = [
        {
          name: "X-Count",
          in: "header",
          required: false,
          schema: { enum: ["a", "b"] },
          schemaPath: paramSchemaPath,
        },
      ];
      spec.schemas.set(paramSchemaPath, { enum: ["a", "b"] });

      const engine = createEngine(spec, validator);

      const result = engine.analyze({
        path: "/users",
        method: "get",
        headers: { "x-count": "bad" },
      });

      assertEquals(result.length, 1);
      assertEquals(result[0]!.code, "E3016");
    },
  );

  await t.step(
    "missing required param skips value validation (only E3002)",
    () => {
      const paramSchemaPath = "#/paths/~1users/get/parameters/0/schema";

      const spec = new StubSpec({ "/users": { get: OP } });
      spec.parameters = [
        {
          name: "limit",
          in: "query",
          required: true,
          schema: { type: "integer" },
          schemaPath: paramSchemaPath,
        },
      ];
      const engine = createEngine(spec);

      // No queryParams at all. Param is missing
      const result = engine.analyze({ path: "/users", method: "get" });

      assertEquals(result.length, 1);
      assertEquals(result[0]!.code, "E3002");
    },
  );

  // ── Path parameter value validation ─────────────────────────────

  await t.step(
    "path param with wrong type → diagnostic when pathParams provided",
    () => {
      const paramSchemaPath = "#/paths/~1users~1{id}/get/parameters/0/schema";

      const validator = new StubValidator();
      validator.register(paramSchemaPath, {
        valid: false,
        path: ["path", "id"],
        schemaPath: paramSchemaPath,
        keyword: "type",
        expected: "integer",
        actual: "string",
      });

      const spec = new StubSpec({ "/users/{id}": { get: OP } });
      spec.parameters = [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "integer" },
          schemaPath: paramSchemaPath,
        },
      ];
      spec.schemas.set(paramSchemaPath, { type: "integer" });

      const engine = createEngine(spec, validator);

      const result = engine.analyze({
        path: "/users/not-a-number",
        method: "get",
        pathParams: { id: "not-a-number" },
      });

      assertEquals(result.length, 1);
      assertEquals(result[0]?.code, "E3001");
    },
  );

  await t.step(
    "path param with valid value → no diagnostic",
    () => {
      const paramSchemaPath = "#/paths/~1users~1{id}/get/parameters/0/schema";

      const spec = new StubSpec({ "/users/{id}": { get: OP } });
      spec.parameters = [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "integer" },
          schemaPath: paramSchemaPath,
        },
      ];
      spec.schemas.set(paramSchemaPath, { type: "integer" });

      const engine = createEngine(spec);

      const result = engine.analyze({
        path: "/users/123",
        method: "get",
        pathParams: { id: "123" },
      });

      assertEquals(result.length, 0);
    },
  );

  await t.step(
    "path param without pathParams in request → no value validation",
    () => {
      const paramSchemaPath = "#/paths/~1users~1{id}/get/parameters/0/schema";

      const spec = new StubSpec({ "/users/{id}": { get: OP } });
      spec.parameters = [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "integer" },
          schemaPath: paramSchemaPath,
        },
      ];

      const engine = createEngine(spec);

      // No pathParams. Engine can't validate, should produce no diagnostic
      const result = engine.analyze({
        path: "/users/not-a-number",
        method: "get",
      });

      assertEquals(result.length, 0);
    },
  );

  // ── Cookie parameter support ────────────────────────────────────

  await t.step("missing required cookie → E3007", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "session",
        in: "cookie",
        required: true,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    // No Cookie header at all
    const result = engine.analyze({ path: "/users", method: "get" });

    assertEquals(result.length, 1);
    assertEquals(result[0]?.code, "E3007");
    assertEquals(result[0]?.category, "sdk-issue");
    assertEquals(result[0]?.requestPath, "cookie.session");
  });

  await t.step(
    "missing required cookie (other cookies present) → E3007",
    () => {
      const spec = new StubSpec({ "/users": { get: OP } });
      spec.parameters = [
        {
          name: "session",
          in: "cookie",
          required: true,
          schema: null,
          schemaPath: null,
        },
      ];
      const engine = createEngine(spec);

      // Cookie header present but doesn't contain "session"
      const result = engine.analyze({
        path: "/users",
        method: "get",
        headers: { cookie: "theme=dark; lang=en" },
      });

      assertEquals(result.length, 1);
      assertEquals(result[0]?.code, "E3007");
    },
  );

  await t.step("optional cookie missing → no diagnostic", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "theme",
        in: "cookie",
        required: false,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const result = engine.analyze({ path: "/users", method: "get" });

    assertEquals(result.length, 0);
  });

  await t.step("required cookie present → no diagnostic", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "session",
        in: "cookie",
        required: true,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "get",
      headers: { cookie: "session=abc123" },
    });

    assertEquals(result.length, 0);
  });

  await t.step("cookie type mismatch → E3008", () => {
    const paramSchemaPath = "#/paths/~1users/get/parameters/0/schema";

    const validator = new StubValidator();
    validator.register(paramSchemaPath, {
      valid: false,
      path: ["cookie", "max_age"],
      schemaPath: paramSchemaPath,
      keyword: "type",
      expected: "integer",
      actual: "string",
    });

    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "max_age",
        in: "cookie",
        required: false,
        schema: { type: "integer" },
        schemaPath: paramSchemaPath,
      },
    ];
    spec.schemas.set(paramSchemaPath, { type: "integer" });

    const engine = createEngine(spec, validator);

    const result = engine.analyze({
      path: "/users",
      method: "get",
      headers: { cookie: "max_age=not-a-number" },
    });

    assertEquals(result.length, 1);
    assertEquals(result[0]?.code, "E3008");
  });

  await t.step("cookie with valid value → no diagnostic", () => {
    const paramSchemaPath = "#/paths/~1users/get/parameters/0/schema";

    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "max_age",
        in: "cookie",
        required: false,
        schema: { type: "integer" },
        schemaPath: paramSchemaPath,
      },
    ];
    spec.schemas.set(paramSchemaPath, { type: "integer" });

    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "get",
      headers: { cookie: "max_age=30" },
    });

    assertEquals(result.length, 0);
  });

  // ── Content-Type validation ─────────────────────────────────────

  await t.step("wrong Content-Type → E3006", () => {
    const spec = new StubSpec({ "/users": { post: OP } });
    spec.bodySchema = {
      schema: { type: "object" },
      schemaPath:
        "#/paths/~1users/post/requestBody/content/application~1json/schema",
      required: true,
    };
    spec.acceptedContentTypes = ["application/json"];
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "post",
      headers: { "content-type": "text/plain" },
      body: {},
    });

    const e3006 = result.find((d) => d.code === "E3006");
    assertEquals(e3006 !== undefined, true);
    assertEquals(e3006?.category, "sdk-issue");
    assertEquals(e3006?.severity, "error");
  });

  await t.step("matching Content-Type → no E3006", () => {
    const spec = new StubSpec({ "/users": { post: OP } });
    spec.bodySchema = {
      schema: { type: "object" },
      schemaPath:
        "#/paths/~1users/post/requestBody/content/application~1json/schema",
      required: true,
    };
    spec.acceptedContentTypes = ["application/json"];
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "post",
      headers: { "content-type": "application/json" },
      body: {},
    });

    assertEquals(result.filter((d) => d.code === "E3006").length, 0);
  });

  await t.step("Content-Type with parameters matches → no E3006", () => {
    const spec = new StubSpec({ "/users": { post: OP } });
    spec.bodySchema = {
      schema: { type: "object" },
      schemaPath:
        "#/paths/~1users/post/requestBody/content/application~1json/schema",
      required: true,
    };
    spec.acceptedContentTypes = ["application/json"];
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "post",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: {},
    });

    assertEquals(result.filter((d) => d.code === "E3006").length, 0);
  });

  await t.step("no Content-Type header → no E3006", () => {
    const spec = new StubSpec({ "/users": { post: OP } });
    spec.bodySchema = {
      schema: { type: "object" },
      schemaPath:
        "#/paths/~1users/post/requestBody/content/application~1json/schema",
      required: true,
    };
    spec.acceptedContentTypes = ["application/json"];
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "post",
      body: {},
    });

    assertEquals(result.filter((d) => d.code === "E3006").length, 0);
  });

  await t.step("no requestBody in spec → no E3006", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    // acceptedContentTypes is null by default (no requestBody)
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "get",
      headers: { "content-type": "text/plain" },
    });

    assertEquals(result.filter((d) => d.code === "E3006").length, 0);
  });

  // ── Malformed Content-Type ──────────────────────────────────────

  await t.step("malformed Content-Type → E3020", () => {
    const spec = new StubSpec({ "/users": { post: OP } });
    spec.bodySchema = {
      schema: { type: "object" },
      schemaPath:
        "#/paths/~1users/post/requestBody/content/application~1json/schema",
      required: true,
    };
    spec.acceptedContentTypes = ["application/json"];
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "post",
      headers: { "content-type": "; utf-8" },
      body: {},
    });

    const e3020 = result.find((d) => d.code === "E3020");
    assertEquals(e3020 !== undefined, true);
    assertEquals(e3020?.category, "sdk-issue");
    assertEquals(e3020?.severity, "error");
  });

  await t.step(
    "malformed Content-Type without requestBody in spec → E3020",
    () => {
      const spec = new StubSpec({ "/users": { post: OP } });
      // No acceptedContentTypes set (null) - E3020 fires regardless
      const engine = createEngine(spec);

      const result = engine.analyze({
        path: "/users",
        method: "post",
        headers: { "content-type": "; utf-8" },
        body: {},
      });

      const e3020 = result.find((d) => d.code === "E3020");
      assertEquals(e3020 !== undefined, true);
    },
  );

  await t.step("valid Content-Type → no E3020", () => {
    const spec = new StubSpec({ "/users": { post: OP } });
    spec.acceptedContentTypes = ["application/json"];
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "post",
      headers: { "content-type": "application/json" },
      body: {},
    });

    assertEquals(result.filter((d) => d.code === "E3020").length, 0);
  });

  await t.step("no Content-Type header → no E3020", () => {
    const spec = new StubSpec({ "/users": { post: OP } });
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "post",
      body: {},
    });

    assertEquals(result.filter((d) => d.code === "E3020").length, 0);
  });

  // ── Malformed Accept header ───────────────────────────────────────

  await t.step("fully malformed Accept header → E3022", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "get",
      headers: { "accept": ";;;" },
    });

    const e3022 = result.find((d) => d.code === "E3022");
    assertEquals(e3022 !== undefined, true);
    assertEquals(e3022?.category, "sdk-issue");
    assertEquals(e3022?.severity, "warning");
  });

  await t.step("Accept with one valid entry → no E3022", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "get",
      headers: { "accept": "garbage, application/json" },
    });

    assertEquals(result.filter((d) => d.code === "E3022").length, 0);
  });

  await t.step("no Accept header → no E3022", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "get",
    });

    assertEquals(result.filter((d) => d.code === "E3022").length, 0);
  });

  // ── Unknown query parameter detection ──────────────────────────

  await t.step("bracket param when spec defines base name → E3014", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "items",
        in: "query",
        required: false,
        schema: { type: "array" },
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const queryParams = new URLSearchParams();
    queryParams.append("items[]", "a");
    queryParams.append("items[]", "b");

    const result = engine.analyze({
      path: "/users",
      method: "get",
      queryParams,
    });

    const e3014 = result.filter((d) => d.code === "E3014");
    assertEquals(e3014.length, 1);
    assertEquals(e3014[0]?.category, "sdk-issue");
    assertEquals(e3014[0]?.severity, "warning");
  });

  await t.step("dot-notation param when spec defines base name → E3014", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "user",
        in: "query",
        required: false,
        schema: { type: "object" },
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const queryParams = new URLSearchParams();
    queryParams.set("user.name", "alice");

    const result = engine.analyze({
      path: "/users",
      method: "get",
      queryParams,
    });

    const e3014 = result.filter((d) => d.code === "E3014");
    assertEquals(e3014.length, 1);
  });

  await t.step("truly undocumented query param → E3015", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "limit",
        in: "query",
        required: false,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const queryParams = new URLSearchParams();
    queryParams.set("limit", "10");
    queryParams.set("debug_mode", "true");

    const result = engine.analyze({
      path: "/users",
      method: "get",
      queryParams,
    });

    const e3015 = result.filter((d) => d.code === "E3015");
    assertEquals(e3015.length, 1);
    assertEquals(e3015[0]?.category, "ambiguous");
    assertEquals(e3015[0]?.severity, "info");
  });

  await t.step("known query params → no E3014/E3015", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "limit",
        in: "query",
        required: false,
        schema: null,
        schemaPath: null,
      },
      {
        name: "page",
        in: "query",
        required: false,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const queryParams = new URLSearchParams();
    queryParams.set("limit", "10");
    queryParams.set("page", "1");

    const result = engine.analyze({
      path: "/users",
      method: "get",
      queryParams,
    });

    assertEquals(result.filter((d) => d.code === "E3014").length, 0);
    assertEquals(result.filter((d) => d.code === "E3015").length, 0);
  });

  await t.step("no query params → no E3014/E3015", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "limit",
        in: "query",
        required: false,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const result = engine.analyze({
      path: "/users",
      method: "get",
    });

    assertEquals(result.filter((d) => d.code === "E3014").length, 0);
    assertEquals(result.filter((d) => d.code === "E3015").length, 0);
  });

  // ── Valid request ───────────────────────────────────────────────

  await t.step("valid request → no diagnostics", () => {
    const spec = new StubSpec({ "/users": { get: OP } });
    spec.parameters = [
      {
        name: "limit",
        in: "query",
        required: true,
        schema: null,
        schemaPath: null,
      },
    ];
    const engine = createEngine(spec);

    const queryParams = new URLSearchParams();
    queryParams.set("limit", "10");

    const result = engine.analyze({
      path: "/users",
      method: "get",
      queryParams,
    });

    assertEquals(result.length, 0);
  });
});
