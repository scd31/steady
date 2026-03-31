/**
 * Tests for form-parser.ts
 *
 * Tests URL-encoded and multipart form data parsing including:
 * - Basic field parsing
 * - Nested paths (dot and bracket notation)
 * - Array fields
 * - Type coercion
 * - File handling
 * - Media type utilities
 */

import { assert, assertEquals } from "@std/assert";
import { parseFormData, parseUrlEncoded } from "./form-parser.ts";

// =============================================================================
// parseUrlEncoded - Basic parsing
// =============================================================================

Deno.test("parseUrlEncoded: parses simple key-value pairs", () => {
  const result = parseUrlEncoded("name=sam&age=30");

  assertEquals(result.data, { name: "sam", age: "30" });
  assertEquals(result.files.size, 0);
});

Deno.test("parseUrlEncoded: handles empty input", () => {
  const result = parseUrlEncoded("");

  assertEquals(result.data, {});
  assertEquals(result.files.size, 0);
});

Deno.test("parseUrlEncoded: handles URL-encoded values", () => {
  const result = parseUrlEncoded(
    "message=hello%20world&email=user%40example.com",
  );

  assertEquals(result.data, {
    message: "hello world",
    email: "user@example.com",
  });
});

// =============================================================================
// parseUrlEncoded - Nested dot notation
// =============================================================================

Deno.test("parseUrlEncoded: parses nested dot notation", () => {
  const result = parseUrlEncoded("user.name=sam&user.email=sam@example.com", {
    formObjectFormat: "dots",
  });

  assertEquals(result.data, {
    user: {
      name: "sam",
      email: "sam@example.com",
    },
  });
});

Deno.test("parseUrlEncoded: parses deeply nested dot notation", () => {
  const result = parseUrlEncoded(
    "user.address.city=NYC&user.address.zip=10001",
    {
      formObjectFormat: "dots",
    },
  );

  assertEquals(result.data, {
    user: {
      address: {
        city: "NYC",
        zip: "10001",
      },
    },
  });
});

// =============================================================================
// parseUrlEncoded - Nested bracket notation
// =============================================================================

Deno.test("parseUrlEncoded: parses bracket notation", () => {
  const result = parseUrlEncoded("user[name]=sam&user[email]=sam@example.com", {
    formObjectFormat: "brackets",
  });

  assertEquals(result.data, {
    user: {
      name: "sam",
      email: "sam@example.com",
    },
  });
});

Deno.test("parseUrlEncoded: parses deeply nested bracket notation", () => {
  const result = parseUrlEncoded(
    "user[address][city]=NYC&user[address][zip]=10001",
    {
      formObjectFormat: "brackets",
    },
  );

  assertEquals(result.data, {
    user: {
      address: {
        city: "NYC",
        zip: "10001",
      },
    },
  });
});

Deno.test("parseUrlEncoded: parses array indices in bracket notation", () => {
  const result = parseUrlEncoded(
    "items[0]=first&items[1]=second&items[2]=third",
    {
      formObjectFormat: "brackets",
    },
  );

  assertEquals(result.data, {
    items: ["first", "second", "third"],
  });
});

// =============================================================================
// parseUrlEncoded - Array fields (repeated keys)
// =============================================================================

Deno.test("parseUrlEncoded: handles repeated keys as arrays", () => {
  const result = parseUrlEncoded("tags=red&tags=green&tags=blue");

  assertEquals(result.data, {
    tags: ["red", "green", "blue"],
  });
});

Deno.test("parseUrlEncoded: single value remains as string without schema", () => {
  const result = parseUrlEncoded("tag=red");

  assertEquals(result.data, { tag: "red" });
});

// =============================================================================
// parseUrlEncoded - Type coercion with schema
// =============================================================================

Deno.test("parseUrlEncoded: coerces integer values with schema", () => {
  const result = parseUrlEncoded("count=42", {
    schema: {
      type: "object",
      properties: {
        count: { type: "integer" },
      },
    },
  });

  assertEquals(result.data, { count: 42 });
  assertEquals(typeof result.data.count, "number");
});

Deno.test("parseUrlEncoded: coerces number values with schema", () => {
  const result = parseUrlEncoded("price=19.99", {
    schema: {
      type: "object",
      properties: {
        price: { type: "number" },
      },
    },
  });

  assertEquals(result.data, { price: 19.99 });
  assertEquals(typeof result.data.price, "number");
});

Deno.test("parseUrlEncoded: coerces boolean true with schema", () => {
  const result = parseUrlEncoded("active=true", {
    schema: {
      type: "object",
      properties: {
        active: { type: "boolean" },
      },
    },
  });

  assertEquals(result.data, { active: true });
  assertEquals(typeof result.data.active, "boolean");
});

Deno.test("parseUrlEncoded: coerces boolean false with schema", () => {
  const result = parseUrlEncoded("active=false", {
    schema: {
      type: "object",
      properties: {
        active: { type: "boolean" },
      },
    },
  });

  assertEquals(result.data, { active: false });
  assertEquals(typeof result.data.active, "boolean");
});

Deno.test("parseUrlEncoded: invalid boolean stays as string", () => {
  const result = parseUrlEncoded("active=yes", {
    schema: {
      type: "object",
      properties: {
        active: { type: "boolean" },
      },
    },
  });

  assertEquals(result.data, { active: "yes" });
  assertEquals(typeof result.data.active, "string");
});

Deno.test("parseUrlEncoded: handles nested schema for type coercion", () => {
  const result = parseUrlEncoded("user.age=30&user.active=true", {
    formObjectFormat: "dots",
    schema: {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            age: { type: "integer" },
            active: { type: "boolean" },
          },
        },
      },
    },
  });

  assertEquals(result.data, {
    user: {
      age: 30,
      active: true,
    },
  });
});

// =============================================================================
// parseFormData - Basic parsing
// =============================================================================

Deno.test("parseFormData: parses simple form data", () => {
  const formData = new FormData();
  formData.append("name", "sam");
  formData.append("email", "sam@example.com");

  const result = parseFormData(formData);

  assertEquals(result.data, {
    name: "sam",
    email: "sam@example.com",
  });
  assertEquals(result.files.size, 0);
});

Deno.test("parseFormData: handles empty form data", () => {
  const formData = new FormData();

  const result = parseFormData(formData);

  assertEquals(result.data, {});
  assertEquals(result.files.size, 0);
});

Deno.test("parseFormData: handles repeated fields as arrays", () => {
  const formData = new FormData();
  formData.append("tags", "red");
  formData.append("tags", "green");
  formData.append("tags", "blue");

  const result = parseFormData(formData);

  assertEquals(result.data, {
    tags: ["red", "green", "blue"],
  });
});

// =============================================================================
// parseFormData - Nested paths
// =============================================================================

Deno.test("parseFormData: parses nested dot notation", () => {
  const formData = new FormData();
  formData.append("user.name", "sam");
  formData.append("user.email", "sam@example.com");

  const result = parseFormData(formData, { formObjectFormat: "dots" });

  assertEquals(result.data, {
    user: {
      name: "sam",
      email: "sam@example.com",
    },
  });
});

Deno.test("parseFormData: parses nested bracket notation", () => {
  const formData = new FormData();
  formData.append("user[name]", "sam");
  formData.append("user[email]", "sam@example.com");

  const result = parseFormData(formData, { formObjectFormat: "brackets" });

  assertEquals(result.data, {
    user: {
      name: "sam",
      email: "sam@example.com",
    },
  });
});

// =============================================================================
// parseFormData - File handling
// =============================================================================

Deno.test("parseFormData: handles file uploads", () => {
  const formData = new FormData();
  formData.append("name", "document");
  const file = new File(["test content"], "test.txt", { type: "text/plain" });
  formData.append("attachment", file);

  const result = parseFormData(formData);

  assertEquals(result.data.name, "document");
  assertEquals(result.data.attachment, "[File]");
  assertEquals(result.files.size, 1);
  assertEquals(result.files.get("attachment"), file);
});

Deno.test("parseFormData: handles multiple file uploads", () => {
  const formData = new FormData();
  const file1 = new File(["content1"], "file1.txt", { type: "text/plain" });
  const file2 = new File(["content2"], "file2.txt", { type: "text/plain" });
  formData.append("files", file1);
  formData.append("files", file2);

  const result = parseFormData(formData);

  assertEquals(result.data.files, ["[File]", "[File]"]);
  assertEquals(result.files.size, 1);

  const uploadedFiles = result.files.get("files");
  assertEquals(Array.isArray(uploadedFiles), true);
  assertEquals((uploadedFiles as File[]).length, 2);
});

// =============================================================================
// parseFormData - Type coercion
// =============================================================================

Deno.test("parseFormData: coerces types with schema", () => {
  const formData = new FormData();
  formData.append("count", "42");
  formData.append("active", "true");
  formData.append("price", "19.99");

  const result = parseFormData(formData, {
    schema: {
      type: "object",
      properties: {
        count: { type: "integer" },
        active: { type: "boolean" },
        price: { type: "number" },
      },
    },
  });

  assertEquals(result.data, {
    count: 42,
    active: true,
    price: 19.99,
  });
});

// =============================================================================
// Edge cases
// =============================================================================

Deno.test("parseUrlEncoded: handles mixed nested formats", () => {
  // When format is 'dots', brackets are treated literally
  const result = parseUrlEncoded("user.info[0]=test", {
    formObjectFormat: "dots",
  });

  assertEquals(result.data, {
    user: {
      "info[0]": "test",
    },
  });
});

Deno.test("parseUrlEncoded: creates null-prototype objects", () => {
  const result = parseUrlEncoded("name=sam");

  // Should not have Object.prototype methods on the result
  assertEquals(Object.getPrototypeOf(result.data), null);
});

// =============================================================================
// anyOf/oneOf schema coercion
// =============================================================================

Deno.test("parseUrlEncoded: coerces boolean with anyOf schema", () => {
  // OpenAI's stream property uses anyOf: [{type: boolean}, {type: null}]
  const result = parseUrlEncoded("stream=true", {
    schema: {
      type: "object",
      properties: {
        stream: {
          anyOf: [{ type: "boolean" }, { type: "null" }],
        },
      },
    },
  });

  assertEquals(result.data, { stream: true });
  assertEquals(typeof result.data.stream, "boolean");
});

Deno.test("parseFormData: coerces boolean with anyOf schema", () => {
  const formData = new FormData();
  formData.append("stream", "false");

  const result = parseFormData(formData, {
    schema: {
      type: "object",
      properties: {
        stream: {
          anyOf: [{ type: "boolean" }, { type: "null" }],
        },
      },
    },
  });

  assertEquals(result.data, { stream: false });
  assertEquals(typeof result.data.stream, "boolean");
});

Deno.test("parseUrlEncoded: coerces number with oneOf schema", () => {
  const result = parseUrlEncoded("value=42", {
    schema: {
      type: "object",
      properties: {
        value: {
          oneOf: [{ type: "integer" }, { type: "string" }],
        },
      },
    },
  });

  assertEquals(result.data, { value: 42 });
  assertEquals(typeof result.data.value, "number");
});

Deno.test("parseUrlEncoded: coerces integer with allOf property schema", () => {
  // Property-level allOf: the property itself is described via allOf
  const result = parseUrlEncoded("count=42", {
    schema: {
      type: "object",
      properties: {
        count: {
          allOf: [{ type: "integer" }],
        },
      },
    },
  });

  assertEquals(result.data, { count: 42 });
  assertEquals(typeof result.data.count, "number");
});

Deno.test("parseUrlEncoded: coerces through allOf on root schema", () => {
  // Root-level allOf: properties spread across allOf members.
  // getPropertySchema uses effectiveProperties to find "bar" across members.
  const result = parseUrlEncoded("foo=hello&bar=0", {
    schema: {
      allOf: [
        { type: "object", properties: { foo: { type: "string" } } },
        { type: "object", properties: { bar: { type: "integer" } } },
      ],
    },
  });

  assertEquals(result.data.bar, 0);
  assertEquals(typeof result.data.bar, "number");
  assertEquals(result.data.foo, "hello");
});

Deno.test("parseUrlEncoded: coerces boolean with allOf schema", () => {
  const result = parseUrlEncoded("active=true", {
    schema: {
      type: "object",
      properties: {
        active: {
          allOf: [{ type: "boolean" }],
        },
      },
    },
  });

  assertEquals(result.data, { active: true });
  assertEquals(typeof result.data.active, "boolean");
});

// =============================================================================
// Form array formats (formArrayFormat option)
// =============================================================================

Deno.test("parseFormData: formArrayFormat=repeat parses repeated keys (default)", () => {
  const formData = new FormData();
  formData.append("tags", "red");
  formData.append("tags", "green");

  const result = parseFormData(formData, { formArrayFormat: "repeat" });

  assertEquals(result.data, { tags: ["red", "green"] });
});

Deno.test("parseFormData: formArrayFormat=brackets parses PHP-style notation", () => {
  const formData = new FormData();
  formData.append("tags[]", "red");
  formData.append("tags[]", "green");

  const result = parseFormData(formData, { formArrayFormat: "brackets" });

  assertEquals(result.data, { tags: ["red", "green"] });
});

Deno.test("parseFormData: formArrayFormat=comma parses comma-separated values", () => {
  const formData = new FormData();
  formData.append("tags", "red,green,blue");

  const result = parseFormData(formData, {
    formArrayFormat: "comma",
    schema: {
      type: "object",
      properties: { tags: { type: "array", items: { type: "string" } } },
    },
  });

  assertEquals(result.data, { tags: ["red", "green", "blue"] });
});

Deno.test("parseUrlEncoded: formArrayFormat=brackets parses PHP-style notation", () => {
  const result = parseUrlEncoded("tags[]=red&tags[]=green", {
    formArrayFormat: "brackets",
  });

  assertEquals(result.data, { tags: ["red", "green"] });
});

Deno.test("parseUrlEncoded: formArrayFormat=brackets with single value", () => {
  const result = parseUrlEncoded("include[]=logprobs", {
    formArrayFormat: "brackets",
  });

  assertEquals(result.data, { include: ["logprobs"] });
});

// =============================================================================
// Form object formats (formObjectFormat option)
// =============================================================================

Deno.test("parseFormData: formObjectFormat=brackets parses deepObject notation", () => {
  const formData = new FormData();
  formData.append("user[name]", "sam");
  formData.append("user[age]", "30");

  const result = parseFormData(formData, { formObjectFormat: "brackets" });

  assertEquals(result.data, { user: { name: "sam", age: "30" } });
});

Deno.test("parseFormData: formObjectFormat=dots parses dot notation", () => {
  const formData = new FormData();
  formData.append("user.name", "sam");
  formData.append("user.age", "30");

  const result = parseFormData(formData, { formObjectFormat: "dots" });

  assertEquals(result.data, { user: { name: "sam", age: "30" } });
});

Deno.test("parseUrlEncoded: formObjectFormat=brackets parses deepObject notation", () => {
  const result = parseUrlEncoded("user[name]=sam&user[age]=30", {
    formObjectFormat: "brackets",
  });

  assertEquals(result.data, { user: { name: "sam", age: "30" } });
});

// =============================================================================
// Combined array + object formats
// =============================================================================

Deno.test("parseFormData: brackets for both arrays and objects", () => {
  const formData = new FormData();
  formData.append("user[name]", "sam");
  formData.append("tags[]", "admin");
  formData.append("tags[]", "active");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
  });

  assertEquals(result.data, {
    user: { name: "sam" },
    tags: ["admin", "active"],
  });
});

Deno.test("parseUrlEncoded: dots for objects, brackets for arrays", () => {
  const result = parseUrlEncoded("user.name=sam&tags[]=red&tags[]=green", {
    formArrayFormat: "brackets",
    formObjectFormat: "dots",
  });

  assertEquals(result.data, {
    user: { name: "sam" },
    tags: ["red", "green"],
  });
});

// =============================================================================
// Indexed bracket arrays (include[0]=value style)
// =============================================================================

Deno.test("parseFormData: indexed brackets should create flat array", () => {
  // This is how httpx serializes arrays: include[0]=logprobs
  const formData = new FormData();
  formData.append("include[0]", "logprobs");
  formData.append("model", "gpt-4o-transcribe");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
  });

  // Should be flat array, NOT nested [["logprobs"]]
  assertEquals(result.data, {
    include: ["logprobs"],
    model: "gpt-4o-transcribe",
  });
});

Deno.test("parseFormData: multiple indexed brackets", () => {
  const formData = new FormData();
  formData.append("tags[0]", "red");
  formData.append("tags[1]", "green");
  formData.append("tags[2]", "blue");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
  });

  assertEquals(result.data, {
    tags: ["red", "green", "blue"],
  });
});

Deno.test("parseUrlEncoded: indexed brackets should create flat array", () => {
  const result = parseUrlEncoded("include[0]=logprobs&include[1]=timestamps", {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
  });

  assertEquals(result.data, {
    include: ["logprobs", "timestamps"],
  });
});

Deno.test("parseFormData: indexed brackets with array schema should not double-wrap", () => {
  // Schema says include is an array of strings
  const schema = {
    type: "object" as const,
    properties: {
      include: {
        type: "array" as const,
        items: { type: "string" as const },
      },
      model: { type: "string" as const },
    },
  };

  const formData = new FormData();
  formData.append("include[0]", "logprobs");
  formData.append("model", "gpt-4o-transcribe");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
    schema,
  });

  // Should be flat array, NOT nested [["logprobs"]]
  assertEquals(result.data, {
    include: ["logprobs"],
    model: "gpt-4o-transcribe",
  });
});

Deno.test("parseFormData: PHP-style brackets with array schema should not double-wrap", () => {
  // This is the actual bug: include[]=logprobs gets double-wrapped to [["logprobs"]]
  const schema = {
    type: "object" as const,
    properties: {
      include: {
        type: "array" as const,
        items: { type: "string" as const },
      },
      model: { type: "string" as const },
    },
  };

  const formData = new FormData();
  formData.append("include[]", "logprobs");
  formData.append("model", "gpt-4o-transcribe");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
    schema,
  });

  // Should be ["logprobs"], NOT [["logprobs"]]
  assertEquals(result.data, {
    include: ["logprobs"],
    model: "gpt-4o-transcribe",
  });
});

// =============================================================================
// Bracket array-of-objects: field[][prop] notation (PHP/Rails convention)
// =============================================================================

Deno.test("parseUrlEncoded: brackets array-of-objects with one element", () => {
  const result = parseUrlEncoded(
    "associations[][id]=1&associations[][type]=foo",
    {
      formArrayFormat: "brackets",
      formObjectFormat: "brackets",
    },
  );

  assertEquals(result.data, {
    associations: [{ id: "1", type: "foo" }],
  });
});

Deno.test("parseUrlEncoded: brackets array-of-objects with multiple elements", () => {
  const result = parseUrlEncoded(
    "tags[][name]=a&tags[][color]=red&tags[][name]=b&tags[][color]=blue",
    {
      formArrayFormat: "brackets",
      formObjectFormat: "brackets",
    },
  );

  assertEquals(result.data, {
    tags: [{ name: "a", color: "red" }, { name: "b", color: "blue" }],
  });
});

Deno.test("parseFormData: brackets array-of-objects with one element", () => {
  const formData = new FormData();
  formData.append("associations[][id]", "1");
  formData.append("associations[][type]", "foo");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
  });

  assertEquals(result.data, {
    associations: [{ id: "1", type: "foo" }],
  });
});

Deno.test("parseFormData: brackets array-of-objects with multiple elements", () => {
  const formData = new FormData();
  formData.append("items[][name]", "a");
  formData.append("items[][value]", "1");
  formData.append("items[][name]", "b");
  formData.append("items[][value]", "2");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
  });

  assertEquals(result.data, {
    items: [{ name: "a", value: "1" }, { name: "b", value: "2" }],
  });
});

// =============================================================================
// Bracket path: file handling
// =============================================================================

Deno.test("parseFormData: brackets+brackets handles single file", () => {
  const file = new File(["data"], "doc.txt", { type: "text/plain" });
  const formData = new FormData();
  formData.append("name", "report");
  formData.append("file", file);

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
  });

  assertEquals(result.data.name, "report");
  assertEquals(result.data.file, "[File]");
  assertEquals(result.files.size, 1);
  assertEquals(result.files.get("file"), file);
});

Deno.test("parseFormData: brackets+brackets handles array of files", () => {
  const f1 = new File(["a"], "a.txt", { type: "text/plain" });
  const f2 = new File(["b"], "b.txt", { type: "text/plain" });
  const formData = new FormData();
  formData.append("files[]", f1);
  formData.append("files[]", f2);

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
  });

  assertEquals(result.data.files, ["[File]", "[File]"]);
  assertEquals(result.files.size, 1);
  const uploaded = result.files.get("files");
  assert(Array.isArray(uploaded));
  assertEquals(uploaded.length, 2);
});

// =============================================================================
// Bracket path: schema coercion
// =============================================================================

Deno.test("parseFormData: brackets+brackets coerces integer with schema", () => {
  const schema = {
    type: "object" as const,
    properties: {
      count: { type: "integer" as const },
    },
  };
  const formData = new FormData();
  formData.append("count", "42");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
    schema,
  });

  assertEquals(result.data.count, 42);
});

Deno.test("parseFormData: brackets+brackets coerces boolean with schema", () => {
  const schema = {
    type: "object" as const,
    properties: {
      active: { type: "boolean" as const },
    },
  };
  const formData = new FormData();
  formData.append("active", "true");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
    schema,
  });

  assertEquals(result.data.active, true);
});

Deno.test("parseFormData: brackets+brackets coerces nested object with schema", () => {
  const schema = {
    type: "object" as const,
    properties: {
      config: {
        type: "object" as const,
        properties: {
          timeout: { type: "integer" as const },
        },
      },
    },
  };
  const formData = new FormData();
  formData.append("config[timeout]", "30");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
    schema,
  });

  assertEquals(result.data, { config: { timeout: 30 } });
});

Deno.test("parseFormData: brackets+brackets coerces array of objects with schema", () => {
  const schema = {
    type: "object" as const,
    properties: {
      items: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            count: { type: "integer" as const },
            active: { type: "boolean" as const },
          },
        },
      },
    },
  };
  const formData = new FormData();
  formData.append("items[][count]", "5");
  formData.append("items[][active]", "true");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
    schema,
  });

  assertEquals(result.data, { items: [{ count: 5, active: true }] });
});

// =============================================================================
// Bracket path: deep nesting
// =============================================================================

Deno.test("parseFormData: brackets+brackets deep nested array-of-objects", () => {
  const formData = new FormData();
  formData.append("deep[][a][b]", "1");
  formData.append("deep[][a][b]", "2");

  const result = parseFormData(formData, {
    formArrayFormat: "brackets",
    formObjectFormat: "brackets",
  });

  assertEquals(result.data, {
    deep: [{ a: { b: "1" } }, { a: { b: "2" } }],
  });
});

Deno.test("parseUrlEncoded: brackets+brackets deep nested array-of-objects", () => {
  const result = parseUrlEncoded(
    "deep[][a][b]=1&deep[][a][b]=2",
    {
      formArrayFormat: "brackets",
      formObjectFormat: "brackets",
    },
  );

  assertEquals(result.data, {
    deep: [{ a: { b: "1" } }, { a: { b: "2" } }],
  });
});

console.log("Form parser tests loaded");
