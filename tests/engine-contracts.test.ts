/**
 * Compile-time contract checks: verify that package implementations
 * satisfy the engine's interfaces. If signatures drift, these fail
 * at type-check time.
 */
import { assertEquals } from "@std/assert";
import type {
  SchemaValidator,
  SpecDocument,
} from "../src/engine/diagnostic-engine.ts";
import { OpenAPISpecDocument } from "../packages/openapi/document.ts";
import { TreeValidator } from "../packages/json-schema/tree-validator.ts";

Deno.test("Engine contracts", async (t) => {
  await t.step("OpenAPISpecDocument satisfies SpecDocument", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "Test", version: "1.0" },
      paths: {
        "/users": {
          get: { responses: { "200": { description: "OK" } } },
        },
      },
    };

    const doc: SpecDocument = new OpenAPISpecDocument(spec);
    assertEquals(Object.keys(doc.paths).length, 1);
  });

  await t.step("TreeValidator satisfies SchemaValidator", () => {
    const validator: SchemaValidator = new TreeValidator();

    const tree = validator.validate(
      "hello",
      { type: "string" },
      "#/schema",
      ["body"],
    );
    assertEquals(tree.valid, true);
  });
});
