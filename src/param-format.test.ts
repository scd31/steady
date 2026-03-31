/**
 * Tests for param-format.ts
 *
 * Tests shared parameter format parsing logic used by both
 * query parameter validation and form data parsing.
 */

import { assertEquals } from "@std/assert";
import {
  getArrayValues,
  groupFormEntries,
  hasParamValue,
  parseBracketEntries,
  parseKeyToPath,
  parseObjectValue,
  resolveArrayFormat,
  resolveObjectFormat,
  setNestedValue,
  wrapURLSearchParams,
} from "./param-format.ts";
import type { Schema } from "@steady/json-schema";

// =============================================================================
// resolveArrayFormat
// =============================================================================

Deno.test("resolveArrayFormat: returns format directly if not auto", () => {
  assertEquals(resolveArrayFormat("repeat"), "repeat");
  assertEquals(resolveArrayFormat("comma"), "comma");
  assertEquals(resolveArrayFormat("brackets"), "brackets");
});

Deno.test("resolveArrayFormat: auto defaults to repeat (form + explode)", () => {
  assertEquals(resolveArrayFormat("auto"), "repeat");
});

Deno.test("resolveArrayFormat: auto with style=form explode=true returns repeat", () => {
  assertEquals(resolveArrayFormat("auto", "form", true), "repeat");
});

Deno.test("resolveArrayFormat: auto with style=form explode=false returns comma", () => {
  assertEquals(resolveArrayFormat("auto", "form", false), "comma");
});

Deno.test("resolveArrayFormat: auto with style=spaceDelimited returns space", () => {
  assertEquals(resolveArrayFormat("auto", "spaceDelimited"), "space");
});

Deno.test("resolveArrayFormat: auto with style=pipeDelimited returns pipe", () => {
  assertEquals(resolveArrayFormat("auto", "pipeDelimited"), "pipe");
});

// =============================================================================
// resolveObjectFormat
// =============================================================================

Deno.test("resolveObjectFormat: returns format directly if not auto", () => {
  assertEquals(resolveObjectFormat("flat"), "flat");
  assertEquals(resolveObjectFormat("brackets"), "brackets");
  assertEquals(resolveObjectFormat("dots"), "dots");
});

Deno.test("resolveObjectFormat: auto defaults to flat (form + explode)", () => {
  assertEquals(resolveObjectFormat("auto"), "flat");
});

Deno.test("resolveObjectFormat: auto with style=form explode=true returns flat", () => {
  assertEquals(resolveObjectFormat("auto", "form", true), "flat");
});

Deno.test("resolveObjectFormat: auto with style=form explode=false returns flat-comma", () => {
  assertEquals(resolveObjectFormat("auto", "form", false), "flat-comma");
});

Deno.test("resolveObjectFormat: auto with style=deepObject returns brackets", () => {
  assertEquals(resolveObjectFormat("auto", "deepObject"), "brackets");
});

// =============================================================================
// getArrayValues
// =============================================================================

Deno.test("getArrayValues: repeat format gets all values with same key", () => {
  const params = new URLSearchParams("colors=red&colors=green&colors=blue");
  const source = wrapURLSearchParams(params);

  assertEquals(getArrayValues(source, "colors", "repeat"), [
    "red",
    "green",
    "blue",
  ]);
});

Deno.test("getArrayValues: comma format splits single value", () => {
  const params = new URLSearchParams("colors=red,green,blue");
  const source = wrapURLSearchParams(params);

  assertEquals(getArrayValues(source, "colors", "comma"), [
    "red",
    "green",
    "blue",
  ]);
});

Deno.test("getArrayValues: space format splits by space", () => {
  const params = new URLSearchParams("colors=red green blue");
  const source = wrapURLSearchParams(params);

  assertEquals(getArrayValues(source, "colors", "space"), [
    "red",
    "green",
    "blue",
  ]);
});

Deno.test("getArrayValues: pipe format splits by pipe", () => {
  const params = new URLSearchParams("colors=red|green|blue");
  const source = wrapURLSearchParams(params);

  assertEquals(getArrayValues(source, "colors", "pipe"), [
    "red",
    "green",
    "blue",
  ]);
});

Deno.test("getArrayValues: brackets format gets values with [] suffix", () => {
  const params = new URLSearchParams(
    "colors[]=red&colors[]=green&colors[]=blue",
  );
  const source = wrapURLSearchParams(params);

  assertEquals(getArrayValues(source, "colors", "brackets"), [
    "red",
    "green",
    "blue",
  ]);
});

Deno.test("getArrayValues: returns empty array if key not found", () => {
  const params = new URLSearchParams("other=value");
  const source = wrapURLSearchParams(params);

  assertEquals(getArrayValues(source, "colors", "repeat"), []);
  assertEquals(getArrayValues(source, "colors", "comma"), []);
  assertEquals(getArrayValues(source, "colors", "brackets"), []);
});

// =============================================================================
// hasParamValue
// =============================================================================

Deno.test("hasParamValue: scalar encoding", () => {
  const source = wrapURLSearchParams(new URLSearchParams("name=sam"));

  assertEquals(hasParamValue(source, "name", { kind: "scalar" }), true);
  assertEquals(hasParamValue(source, "other", { kind: "scalar" }), false);
});

Deno.test("hasParamValue: flat-array repeat format", () => {
  const source = wrapURLSearchParams(new URLSearchParams("tags=a&tags=b"));

  assertEquals(
    hasParamValue(source, "tags", { kind: "flat-array", arrayFmt: "repeat" }),
    true,
  );
});

Deno.test("hasParamValue: flat-array brackets format", () => {
  const source = wrapURLSearchParams(
    new URLSearchParams("tags[]=a&tags[]=b"),
  );

  assertEquals(
    hasParamValue(source, "tags", {
      kind: "flat-array",
      arrayFmt: "brackets",
    }),
    true,
  );
});

Deno.test("hasParamValue: nested brackets format", () => {
  const source = wrapURLSearchParams(new URLSearchParams("user[name]=sam"));

  assertEquals(
    hasParamValue(source, "user", { kind: "nested", objectFmt: "brackets" }),
    true,
  );
  assertEquals(
    hasParamValue(source, "other", { kind: "nested", objectFmt: "brackets" }),
    false,
  );
});

Deno.test("hasParamValue: nested dots format", () => {
  const source = wrapURLSearchParams(new URLSearchParams("user.name=sam"));

  assertEquals(
    hasParamValue(source, "user", { kind: "nested", objectFmt: "dots" }),
    true,
  );
  assertEquals(
    hasParamValue(source, "other", { kind: "nested", objectFmt: "dots" }),
    false,
  );
});

Deno.test("hasParamValue: flat-object flat format", () => {
  const source = wrapURLSearchParams(new URLSearchParams("user=sam"));

  assertEquals(
    hasParamValue(source, "user", { kind: "flat-object", objectFmt: "flat" }),
    true,
  );
});

Deno.test("hasParamValue: flat-object flat-comma format", () => {
  const source = wrapURLSearchParams(
    new URLSearchParams("user=name,sam,age,30"),
  );

  assertEquals(
    hasParamValue(source, "user", {
      kind: "flat-object",
      objectFmt: "flat-comma",
    }),
    true,
  );
  // No comma = not detected as flat-comma
  const source2 = wrapURLSearchParams(new URLSearchParams("user=sam"));
  assertEquals(
    hasParamValue(source2, "user", {
      kind: "flat-object",
      objectFmt: "flat-comma",
    }),
    false,
  );
});

// =============================================================================
// setNestedValue
// =============================================================================

Deno.test("setNestedValue: sets simple path", () => {
  const obj: Record<string, unknown> = Object.create(null);
  setNestedValue(obj, ["name"], "sam");

  assertEquals(obj, { name: "sam" });
});

Deno.test("setNestedValue: creates nested objects", () => {
  const obj: Record<string, unknown> = Object.create(null);
  setNestedValue(obj, ["user", "name"], "sam");

  assertEquals(obj, { user: { name: "sam" } });
});

Deno.test("setNestedValue: creates deeply nested objects", () => {
  const obj: Record<string, unknown> = Object.create(null);
  setNestedValue(obj, ["user", "address", "city"], "NYC");

  assertEquals(obj, { user: { address: { city: "NYC" } } });
});

Deno.test("setNestedValue: creates arrays for numeric indices", () => {
  const obj: Record<string, unknown> = Object.create(null);
  setNestedValue(obj, ["items", "0"], "first");
  setNestedValue(obj, ["items", "1"], "second");

  assertEquals(obj, { items: ["first", "second"] });
});

Deno.test("setNestedValue: handles empty path", () => {
  const obj: Record<string, unknown> = Object.create(null);
  setNestedValue(obj, [], "value");

  assertEquals(obj, {});
});

// =============================================================================
// parseObjectValue
// =============================================================================

Deno.test("parseObjectValue: flat format returns single value", () => {
  const params = new URLSearchParams("id=123");
  const source = wrapURLSearchParams(params);

  assertEquals(parseObjectValue(source, "id", "flat"), { id: "123" });
});

Deno.test("parseObjectValue: flat-comma format parses key-value pairs", () => {
  const params = new URLSearchParams("id=role,admin,firstName,Alex");
  const source = wrapURLSearchParams(params);

  assertEquals(parseObjectValue(source, "id", "flat-comma"), {
    role: "admin",
    firstName: "Alex",
  });
});

Deno.test("parseObjectValue: dots format parses nested keys", () => {
  const params = new URLSearchParams("id.role=admin&id.firstName=Alex");
  const source = wrapURLSearchParams(params);

  assertEquals(parseObjectValue(source, "id", "dots"), {
    role: "admin",
    firstName: "Alex",
  });
});

Deno.test("parseObjectValue: dots format handles deeply nested", () => {
  const params = new URLSearchParams(
    "user.address.city=NYC&user.address.zip=10001",
  );
  const source = wrapURLSearchParams(params);

  assertEquals(parseObjectValue(source, "user", "dots"), {
    address: { city: "NYC", zip: "10001" },
  });
});

// =============================================================================
// groupFormEntries
// =============================================================================

Deno.test("groupFormEntries: groups repeated keys", () => {
  const entries: [string, string][] = [
    ["tags", "red"],
    ["tags", "green"],
    ["name", "sam"],
  ];

  const { groups, explicitArrays } = groupFormEntries(entries, "repeat");

  assertEquals(groups.get("tags"), ["red", "green"]);
  assertEquals(groups.get("name"), ["sam"]);
  assertEquals(explicitArrays.size, 0);
});

Deno.test("groupFormEntries: brackets format normalizes array keys", () => {
  const entries: [string, string][] = [
    ["tags[]", "red"],
    ["tags[]", "green"],
    ["name", "sam"],
  ];

  const { groups, explicitArrays } = groupFormEntries(entries, "brackets");

  assertEquals(groups.get("tags"), ["red", "green"]);
  assertEquals(groups.get("name"), ["sam"]);
  assertEquals(explicitArrays.has("tags"), true);
  assertEquals(explicitArrays.has("name"), false);
});

Deno.test("groupFormEntries: brackets format tracks single value arrays", () => {
  const entries: [string, string][] = [
    ["include[]", "logprobs"],
  ];

  const { groups, explicitArrays } = groupFormEntries(entries, "brackets");

  assertEquals(groups.get("include"), ["logprobs"]);
  assertEquals(explicitArrays.has("include"), true);
});

// =============================================================================
// parseKeyToPath
// =============================================================================

Deno.test("parseKeyToPath: flat format returns single-element array", () => {
  assertEquals(parseKeyToPath("name", "flat"), ["name"]);
  assertEquals(parseKeyToPath("user[name]", "flat"), ["user[name]"]);
  assertEquals(parseKeyToPath("user.name", "flat"), ["user.name"]);
});

Deno.test("parseKeyToPath: flat-comma format returns single-element array", () => {
  assertEquals(parseKeyToPath("id", "flat-comma"), ["id"]);
  assertEquals(parseKeyToPath("user[name]", "flat-comma"), ["user[name]"]);
});

Deno.test("parseKeyToPath: brackets format parses nested keys", () => {
  assertEquals(parseKeyToPath("user", "brackets"), ["user"]);
  assertEquals(parseKeyToPath("user[name]", "brackets"), ["user", "name"]);
  assertEquals(parseKeyToPath("user[address][city]", "brackets"), [
    "user",
    "address",
    "city",
  ]);
});

Deno.test("parseKeyToPath: brackets format handles numeric indices", () => {
  assertEquals(parseKeyToPath("items[0]", "brackets"), ["items", "0"]);
  assertEquals(parseKeyToPath("items[0][name]", "brackets"), [
    "items",
    "0",
    "name",
  ]);
});

Deno.test("parseKeyToPath: brackets format handles empty brackets", () => {
  assertEquals(parseKeyToPath("tags[]", "brackets"), ["tags", ""]);
});

Deno.test("parseKeyToPath: dots format splits by dots", () => {
  assertEquals(parseKeyToPath("user", "dots"), ["user"]);
  assertEquals(parseKeyToPath("user.name", "dots"), ["user", "name"]);
  assertEquals(parseKeyToPath("user.address.city", "dots"), [
    "user",
    "address",
    "city",
  ]);
});

// =============================================================================
// parseBracketEntries: schema-driven bracket parsing
// =============================================================================

const filterSchema: Schema = {
  type: "object",
  properties: {
    item_id: {
      type: "object",
      properties: { eq: { type: "string" } },
    },
    type: {
      type: "object",
      properties: {
        in: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
  },
};

const arrayOfObjectsSchema: Schema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      key: { type: "string" },
      operator: { type: "string" },
      value: { type: "string" },
      name: { type: "string" },
      id: { type: "string" },
      type: { type: "string" },
      color: { type: "string" },
    },
  },
};

Deno.test("parseBracketEntries: nested object with array-append property", () => {
  const entries: [string, string][] = [
    ["filter[type][in][]", "activity/call_occurred"],
  ];
  const wrapperSchema: Schema = {
    type: "object",
    properties: { filter: filterSchema },
  };

  const result = parseBracketEntries(entries, wrapperSchema);
  assertEquals(result, {
    filter: { type: { in: ["activity/call_occurred"] } },
  });
});

Deno.test("parseBracketEntries: multiple array-append values", () => {
  const entries: [string, string][] = [
    ["filter[type][in][]", "call"],
    ["filter[type][in][]", "email"],
  ];
  const wrapperSchema: Schema = {
    type: "object",
    properties: { filter: filterSchema },
  };

  const result = parseBracketEntries(entries, wrapperSchema);
  assertEquals(result, {
    filter: { type: { in: ["call", "email"] } },
  });
});

Deno.test("parseBracketEntries: mixed object and array-append", () => {
  const entries: [string, string][] = [
    ["filter[item_id][eq]", "eq"],
    ["filter[type][in][]", "activity/call_occurred"],
  ];
  const wrapperSchema: Schema = {
    type: "object",
    properties: { filter: filterSchema },
  };

  const result = parseBracketEntries(entries, wrapperSchema);
  assertEquals(result, {
    filter: {
      item_id: { eq: "eq" },
      type: { in: ["activity/call_occurred"] },
    },
  });
});

Deno.test("parseBracketEntries: array-of-objects with append notation", () => {
  const entries: [string, string][] = [
    ["items[][name]", "a"],
    ["items[][value]", "1"],
    ["items[][name]", "b"],
    ["items[][value]", "2"],
  ];
  const wrapperSchema: Schema = {
    type: "object",
    properties: { items: arrayOfObjectsSchema },
  };

  const result = parseBracketEntries(entries, wrapperSchema);
  assertEquals(result, {
    items: [{ name: "a", value: "1" }, { name: "b", value: "2" }],
  });
});

Deno.test("parseBracketEntries: array-of-objects with repeated keys (no [])", () => {
  const entries: [string, string][] = [
    ["filters[key]", "id"],
    ["filters[operator]", "eq"],
    ["filters[key]", "type"],
    ["filters[operator]", "contains"],
  ];
  const wrapperSchema: Schema = {
    type: "object",
    properties: { filters: arrayOfObjectsSchema },
  };

  const result = parseBracketEntries(entries, wrapperSchema);
  assertEquals(result, {
    filters: [
      { key: "id", operator: "eq" },
      { key: "type", operator: "contains" },
    ],
  });
});

Deno.test("parseBracketEntries: single array-of-objects element with repeated keys", () => {
  const entries: [string, string][] = [
    ["filters[key]", "id"],
    ["filters[operator]", "eq"],
    ["filters[value]", "string"],
  ];
  const wrapperSchema: Schema = {
    type: "object",
    properties: { filters: arrayOfObjectsSchema },
  };

  const result = parseBracketEntries(entries, wrapperSchema);
  assertEquals(result, {
    filters: [{ key: "id", operator: "eq", value: "string" }],
  });
});

Deno.test("parseBracketEntries: deep nested array-of-objects", () => {
  const entries: [string, string][] = [
    ["deep[][a][b]", "1"],
    ["deep[][a][b]", "2"],
  ];
  const deepSchema: Schema = {
    type: "object",
    properties: {
      deep: {
        type: "array",
        items: {
          type: "object",
          properties: {
            a: {
              type: "object",
              properties: { b: { type: "string" } },
            },
          },
        },
      },
    },
  };

  const result = parseBracketEntries(entries, deepSchema);
  assertEquals(result, {
    deep: [{ a: { b: "1" } }, { a: { b: "2" } }],
  });
});

Deno.test("parseBracketEntries: coerces integer leaf values", () => {
  const entries: [string, string][] = [["count", "42"]];
  const schema: Schema = {
    type: "object",
    properties: { count: { type: "integer" } },
  };

  const result = parseBracketEntries(entries, schema);
  assertEquals(result, { count: 42 });
});

Deno.test("parseBracketEntries: coerces boolean leaf values", () => {
  const entries: [string, string][] = [["active", "true"]];
  const schema: Schema = {
    type: "object",
    properties: { active: { type: "boolean" } },
  };

  const result = parseBracketEntries(entries, schema);
  assertEquals(result, { active: true });
});

Deno.test("parseBracketEntries: no schema defaults to object", () => {
  const entries: [string, string][] = [
    ["name", "test"],
    ["count", "42"],
  ];

  const result = parseBracketEntries(entries, null);
  assertEquals(result, { name: "test", count: "42" });
});

console.log("param-format tests loaded");
