import { assertEquals } from "@std/assert";
import type { OpenAPIRaw } from "./openapi.ts";
import { OpenAPISpec } from "./spec.ts";
import { SchemaRegistry } from "@steady/json-schema";

/**
 * Helper to create a minimal valid OpenAPIRaw with given paths.
 */
function createSpec(
  overrides: Partial<OpenAPIRaw> = {},
): OpenAPIRaw {
  return {
    openapi: "3.1.0",
    info: { title: "Test", version: "1.0.0" },
    paths: {},
    ...overrides,
  };
}

Deno.test("OpenAPISpec", async (t) => {
  // ── paths ────────────────────────────────────────────────────────

  await t.step("paths returns spec.paths", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          get: { responses: { "200": { description: "OK" } } },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));

    assertEquals(Object.keys(doc.paths), ["/users"]);
  });

  // ── getParameters ────────────────────────────────────────────────

  await t.step("operation-level parameters", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          get: {
            parameters: [
              {
                name: "limit",
                in: "query",
                required: true,
                schema: { type: "integer" },
              },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const params = doc.getParameters("/users", "get");

    assertEquals(params.length, 1);
    assertEquals(params[0]!.name, "limit");
    assertEquals(params[0]!.in, "query");
    assertEquals(params[0]!.required, true);
  });

  await t.step("path-level parameters merge with operation-level", () => {
    const spec = createSpec({
      paths: {
        "/users/{id}": {
          parameters: [
            { name: "id", in: "path" },
          ],
          get: {
            parameters: [
              { name: "fields", in: "query" },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const params = doc.getParameters("/users/{id}", "get");

    assertEquals(params.length, 2);
    const names = params.map((p) => p.name);
    assertEquals(names.includes("id"), true);
    assertEquals(names.includes("fields"), true);
  });

  await t.step("operation-level overrides path-level (same name+in)", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          parameters: [
            { name: "limit", in: "query", schema: { type: "string" } },
          ],
          get: {
            parameters: [
              {
                name: "limit",
                in: "query",
                required: true,
                schema: { type: "integer" },
              },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const params = doc.getParameters("/users", "get");

    assertEquals(params.length, 1);
    assertEquals(params[0]!.name, "limit");
    assertEquals(params[0]!.required, true);
  });

  await t.step("path parameters are implicitly required", () => {
    const spec = createSpec({
      paths: {
        "/users/{id}": {
          get: {
            parameters: [
              { name: "id", in: "path" },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const params = doc.getParameters("/users/{id}", "get");

    assertEquals(params[0]!.required, true);
  });

  await t.step("$ref parameters are resolved", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          get: {
            parameters: [
              { $ref: "#/components/parameters/LimitParam" },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
      components: {
        parameters: {
          LimitParam: {
            name: "limit",
            in: "query",
            required: true,
            schema: { type: "integer" },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const params = doc.getParameters("/users", "get");

    assertEquals(params.length, 1);
    assertEquals(params[0]!.name, "limit");
    assertEquals(params[0]!.in, "query");
    assertEquals(params[0]!.required, true);
  });

  await t.step("parameter schemaPath points to schema location", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          get: {
            parameters: [
              { name: "limit", in: "query", schema: { type: "integer" } },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const params = doc.getParameters("/users", "get");

    assertEquals(params[0]!.schemaPath !== null, true);
    assertEquals(params[0]!.schema !== null, true);
  });

  await t.step("parameter without schema has null schema/schemaPath", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          get: {
            parameters: [
              { name: "limit", in: "query" },
            ],
            responses: { "200": { description: "OK" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const params = doc.getParameters("/users", "get");

    assertEquals(params[0]!.schema, null);
    assertEquals(params[0]!.schemaPath, null);
  });

  await t.step("no parameters → empty array", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          get: {
            responses: { "200": { description: "OK" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const params = doc.getParameters("/users", "get");

    assertEquals(params, []);
  });

  // ── getBodySchema ────────────────────────────────────────────────

  await t.step("returns body schema for application/json", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", required: ["name"] },
                },
              },
            },
            responses: { "201": { description: "Created" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const body = doc.getBodySchema("/users", "post");

    assertEquals(body !== null, true);
    assertEquals(body!.schema.type, "object");
    assertEquals(typeof body!.schemaPath, "string");
  });

  await t.step("no requestBody → null", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          get: {
            responses: { "200": { description: "OK" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));

    assertEquals(doc.getBodySchema("/users", "get"), null);
  });

  await t.step("$ref requestBody is resolved", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          post: {
            requestBody: { $ref: "#/components/requestBodies/CreateUser" },
            responses: { "201": { description: "Created" } },
          },
        },
      },
      components: {
        requestBodies: {
          CreateUser: {
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const body = doc.getBodySchema("/users", "post");

    assertEquals(body !== null, true);
    assertEquals(body!.schema.type, "object");
  });

  await t.step("returns body schema for QUERY method", () => {
    const spec = createSpec({
      paths: {
        "/search": {
          query: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", required: ["q"] },
                },
              },
            },
            responses: { "200": { description: "Results" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const body = doc.getBodySchema("/search", "query");

    assertEquals(body !== null, true);
    assertEquals(body!.schema.type, "object");
  });

  // ── hasResponses ─────────────────────────────────────────────────

  await t.step("returns true when responses exist", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          get: {
            responses: { "200": { description: "OK" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));

    assertEquals(doc.hasResponses("/users", "get"), true);
  });

  await t.step("returns false when responses is empty", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          get: {
            responses: {},
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));

    assertEquals(doc.hasResponses("/users", "get"), false);
  });

  // ── resolveSchema ────────────────────────────────────────────────

  await t.step("resolves schema by JSON pointer", () => {
    const spec = createSpec({
      components: {
        schemas: {
          User: { type: "object", properties: { name: { type: "string" } } },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const schema = doc.resolveSchema("#/components/schemas/User");

    assertEquals(schema.type, "object");
  });

  await t.step("resolves nested schema path", () => {
    const spec = createSpec({
      paths: {
        "/users": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string", minLength: 1 } },
                  },
                },
              },
            },
            responses: { "201": { description: "Created" } },
          },
        },
      },
    });
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const schema = doc.resolveSchema(
      "#/paths/~1users/post/requestBody/content/application~1json/schema/properties/name",
    );

    assertEquals(schema.type, "string");
    assertEquals(schema.minLength, 1);
  });

  await t.step("unresolvable path returns empty schema", () => {
    const spec = createSpec({});
    const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));
    const schema = doc.resolveSchema("#/nonexistent/path");

    assertEquals(schema, {});
  });
});
