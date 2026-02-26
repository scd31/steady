/**
 * End-to-end server integration tests.
 *
 * Each test goes through the full pipeline:
 *   spec file → parseSpecFromFile → MockServer → HTTP request → assert response
 *
 * Tests spec loading, path matching, body validation, path param validation,
 * query params, and performance with enterprise-scale specs.
 */

import { assertEquals, assertExists } from "@std/assert";
import { assertSnapshot } from "@std/testing/snapshot";
import { parseSpecFromFile } from "../../packages/openapi/mod.ts";
import { MockServer } from "../../src/server/mod.ts";
import { matchPathPattern } from "../../src/path-matcher.ts";

// ── Helpers ─────────────────────────────────────────────────────────

let nextPort = 5100;

interface ServerContext {
  server: MockServer;
  port: number;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

async function withServer(
  specPath: string,
  fn: (ctx: ServerContext) => Promise<void>,
  opts?: { validator?: { queryObjectFormat?: "brackets" | "dots" } },
): Promise<void> {
  const port = nextPort++;
  const { spec } = await parseSpecFromFile(specPath);
  const server = new MockServer(spec, {
    port,
    host: "localhost",
    logLevel: "summary",
    ...opts,
  });

  server.start();

  try {
    await fn({
      server,
      port,
      fetch: (path, init) => fetch(`http://localhost:${port}${path}`, init),
    });
  } finally {
    server.stop();
  }
}

/** Extract X-Steady-* diagnostic headers from a response. */
function diagnosticHeaders(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of response.headers) {
    if (key.toLowerCase().startsWith("x-steady-")) {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

const BODY_SPEC = "./tests/specs/test-spec-with-body.yaml";
const DATADOG_SPEC = "./tests/fixtures/datadog-openapi.json";

// ── Path matching (unit-level, no server) ───────────────────────────

Deno.test("path parameter extraction", () => {
  const r1 = matchPathPattern(
    "/api/v1/dashboard/abc-123-def",
    "/api/v1/dashboard/{dashboard_id}",
  );
  assertExists(r1);
  assertEquals(r1.dashboard_id, "abc-123-def");

  const r2 = matchPathPattern(
    "/api/v1/events/event-456",
    "/api/v1/events/{event_id}",
  );
  assertExists(r2);
  assertEquals(r2.event_id, "event-456");

  const r3 = matchPathPattern(
    "/api/v1/host/my-host.example.com/mute",
    "/api/v1/host/{host_name}/mute",
  );
  assertExists(r3);
  assertEquals(r3.host_name, "my-host.example.com");
});

Deno.test("multiple path parameters + URL encoding", () => {
  const result = matchPathPattern(
    "/api/v2/users/123/posts/456",
    "/api/v2/users/{user_id}/posts/{post_id}",
  );
  assertExists(result);
  assertEquals(result.user_id, "123");
  assertEquals(result.post_id, "456");

  const encoded = matchPathPattern(
    "/api/v1/items/hello%20world",
    "/api/v1/items/{item_id}",
  );
  assertExists(encoded);
  assertEquals(encoded.item_id, "hello world");
});

Deno.test("path matching edge cases", () => {
  assertEquals(matchPathPattern("/users/123/posts", "/users/{id}"), null);
  assertEquals(matchPathPattern("/items/123", "/users/{id}"), null);

  const exact = matchPathPattern("/api/health", "/api/health");
  assertExists(exact);
  assertEquals(Object.keys(exact).length, 0);
});

// ── Spec loading ────────────────────────────────────────────────────

Deno.test("load Datadog spec (8.4MB, 323 endpoints)", async () => {
  const { spec } = await parseSpecFromFile(DATADOG_SPEC);

  assertEquals(spec.openapi, "3.0.3");
  assertEquals(spec.info.title, "Datadog API Collection");
  assertEquals(Object.keys(spec.paths).length, 323);
});

// ── HTTP server: body validation ────────────────────────────────────

Deno.test({
  name: "valid request body → 200",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(BODY_SPEC, async (ctx) => {
      const response = await ctx.fetch("/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Alice",
          email: "alice@example.com",
          age: 30,
        }),
      });
      assertEquals(response.status, 200);
      await response.text();
    });
  },
});

Deno.test({
  name: "missing required field → mock response with diagnostics",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    await withServer(BODY_SPEC, async (ctx) => {
      const response = await ctx.fetch("/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bob" }),
      });
      assertEquals(response.status, 400);
      await assertSnapshot(t, diagnosticHeaders(response));
      await response.text();
    });
  },
});

Deno.test({
  name: "type mismatch in body → mock response with diagnostics",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    await withServer(BODY_SPEC, async (ctx) => {
      const response = await ctx.fetch("/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Charlie",
          email: "not-an-email",
          age: "not-a-number",
        }),
      });
      assertEquals(response.status, 400);
      await assertSnapshot(t, diagnosticHeaders(response));
      await response.text();
    });
  },
});

// ── HTTP server: path params ────────────────────────────────────────

Deno.test({
  name: "valid integer path param → 200",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(BODY_SPEC, async (ctx) => {
      const response = await ctx.fetch("/users/123");
      assertEquals(response.status, 200);
      await response.text();
    });
  },
});

Deno.test({
  name: "invalid integer path param → mock response",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(BODY_SPEC, async (ctx) => {
      const response = await ctx.fetch("/users/not-a-number");
      assertEquals(response.status, 400);
      await response.text();
    });
  },
});

// ── HTTP server: performance ────────────────────────────────────────

Deno.test({
  name: "complex nested schema validates under 500ms",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(DATADOG_SPEC, async (ctx) => {
      const start = performance.now();
      const response = await ctx.fetch("/api/v1/dashboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Test Dashboard",
          description: "Integration test dashboard",
          widgets: [],
          layout_type: "ordered",
        }),
      });
      const duration = performance.now() - start;

      assertExists(response);
      await response.text();
      assertEquals(
        duration < 500,
        true,
        `Validation took ${duration}ms, expected < 500ms`,
      );
    });
  },
});

// ── HTTP server: QUERY method ──────────────────────────────────────

const QUERY_METHOD_SPEC = "./tests/specs/test-query-method.yaml";

Deno.test({
  name: "QUERY method with body → 200 with mock response",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(QUERY_METHOD_SPEC, async (ctx) => {
      const response = await ctx.fetch("/search", {
        method: "QUERY",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: "test", limit: 10 }),
      });
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(typeof body, "object");
    });
  },
});

Deno.test({
  name: "QUERY method without body → diagnostics",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(QUERY_METHOD_SPEC, async (ctx) => {
      const response = await ctx.fetch("/search", {
        method: "QUERY",
      });
      // Should still get a response (mock server is lenient by default)
      assertExists(response);
      await response.text();
    });
  },
});

// ── HTTP server: redirect responses ────────────────────────────────

const REDIRECT_SPEC = "./tests/specs/test-redirect.yaml";

Deno.test({
  name: "303 response redirects to /_x-steady/redirected",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(REDIRECT_SPEC, async (ctx) => {
      const response = await ctx.fetch("/cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
        redirect: "manual",
      });
      assertEquals(response.status, 303);
      const location = response.headers.get("Location");
      assertEquals(location, "/_x-steady/redirected");
    });
  },
});

Deno.test({
  name: "/_x-steady/redirected returns 200",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(REDIRECT_SPEC, async (ctx) => {
      const response = await ctx.fetch("/_x-steady/redirected");
      assertEquals(response.status, 200);
      const body = await response.json();
      assertEquals(body.status, "redirected");
    });
  },
});

Deno.test({
  name: "303 response uses Location example from spec",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(REDIRECT_SPEC, async (ctx) => {
      const response = await ctx.fetch("/cards-with-example", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
        redirect: "manual",
      });
      assertEquals(response.status, 303);
      assertEquals(response.headers.get("Location"), "/cards/abc-123");
    });
  },
});

Deno.test({
  name: "303 response uses Location default from schema",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(REDIRECT_SPEC, async (ctx) => {
      const response = await ctx.fetch("/cards-with-default", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
        redirect: "manual",
      });
      assertEquals(response.status, 303);
      assertEquals(
        response.headers.get("Location"),
        "/cards/default-location",
      );
    });
  },
});

Deno.test({
  name: "303 response resolves Location from header $ref",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(REDIRECT_SPEC, async (ctx) => {
      const response = await ctx.fetch("/cards-with-header-ref", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
        redirect: "manual",
      });
      assertEquals(response.status, 303);
      assertEquals(
        response.headers.get("Location"),
        "/cards/from-header-ref",
      );
    });
  },
});

Deno.test({
  name: "303 response resolves Location from schema $ref",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(REDIRECT_SPEC, async (ctx) => {
      const response = await ctx.fetch("/cards-with-schema-ref", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
        redirect: "manual",
      });
      assertEquals(response.status, 303);
      assertEquals(
        response.headers.get("Location"),
        "/cards/from-schema-ref",
      );
    });
  },
});

// ── Response generation: $ref examples ──────────────────────────────

const REF_EXAMPLE_SPEC = "./tests/specs/ref-example-spec.yaml";

Deno.test({
  name: "response with $ref examples does not 500",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(REF_EXAMPLE_SPEC, async (ctx) => {
      const response = await ctx.fetch("/settings/cache_reserve", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: "on" }),
      });

      // Should not crash. 200 is fine, anything below 500 is acceptable.
      assertEquals(response.status < 500, true, `Got ${response.status}`);
      await response.body?.cancel();
    });
  },
});

Deno.test({
  name: "diagnostics preserved when response generation fails",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(REF_EXAMPLE_SPEC, async (ctx) => {
      // Send wrong content-type. Even if response generation fails,
      // the E3006 diagnostic should still be reported.
      const response = await ctx.fetch("/settings/cache_reserve", {
        method: "PATCH",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ value: "on" }),
      });

      const valid = response.headers.get("x-steady-request-valid");
      assertEquals(valid, "false", "Should detect wrong content-type");

      const errorCount = parseInt(
        response.headers.get("x-steady-error-count") ?? "0",
        10,
      );
      assertEquals(
        errorCount > 0,
        true,
        "Should report at least one diagnostic",
      );

      await response.body?.cancel();
    });
  },
});

// ── HTTP server: query params ───────────────────────────────────────

Deno.test({
  name: "query parameter forwarded correctly",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(DATADOG_SPEC, async (ctx) => {
      const response = await ctx.fetch("/api/v1/hosts?filter=hostname:example");
      assertExists(response);
      await response.text();
    });
  },
});
