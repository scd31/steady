/**
 * Integration tests for multipart/form-data request handling.
 *
 * Covers two bugs found via the openai-go SDK:
 * 1. Form array format flags (e.g. --validator-form-array-format=brackets)
 *    are not threaded into parseRequestBody, so `files[]` is never
 *    normalized to `files`.
 * 2. No schema is passed to the form parser, so string-to-boolean coercion
 *    (multipart `default=true` -> boolean true) never happens.
 */

import { assertEquals } from "@std/assert";
import { parseSpecFromFile } from "../../packages/openapi/mod.ts";
import { MockServer } from "../../src/server/mod.ts";

// ── Helpers ─────────────────────────────────────────────────────────

interface ServerContext {
  server: MockServer;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

async function withServer(
  specPath: string,
  fn: (ctx: ServerContext) => Promise<void>,
  opts?: {
    validator?: {
      formArrayFormat?: "brackets" | "repeat";
      formObjectFormat?: "brackets" | "flat";
    };
  },
): Promise<void> {
  const { spec } = await parseSpecFromFile(specPath);
  const server = new MockServer(spec, {
    port: 0,
    host: "localhost",
    logLevel: "summary",
    ...opts,
  });

  const port = await server.start();

  try {
    await fn({
      server,
      fetch: (path, init) => fetch(`http://localhost:${port}${path}`, init),
    });
  } finally {
    await server.stop();
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

const SPEC = "./tests/specs/multipart-test.yaml";
const serverTestOpts = { sanitizeOps: false, sanitizeResources: false };

// ── Bug 1: form array format not threaded ───────────────────────────

Deno.test({
  name:
    "multipart: brackets format normalizes files[] to files for required property",
  ...serverTestOpts,
  fn: async () => {
    await withServer(
      SPEC,
      async (ctx) => {
        const form = new FormData();
        form.append(
          "files[]",
          new File(["hello"], "part-1.txt", { type: "text/plain" }),
        );
        form.append(
          "files[]",
          new File(["world"], "part-2.txt", { type: "text/plain" }),
        );

        const response = await ctx.fetch("/uploads/upload_123/parts", {
          method: "POST",
          body: form,
        });

        const diags = diagnosticHeaders(response);
        assertEquals(
          response.status,
          200,
          `Expected 200, got ${response.status}. ` +
            `error-count=${diags["x-steady-error-count"]}, ` +
            `error-1=${diags["x-steady-error-1-code"]}: ${
              diags["x-steady-error-1-message"]
            }`,
        );
        assertEquals(diags["x-steady-error-count"], "0");
        await response.body?.cancel();
      },
      { validator: { formArrayFormat: "brackets" } },
    );
  },
});

// ── Bug 2: type coercion missing for multipart ──────────────────────

Deno.test({
  name:
    "multipart: string 'true' is coerced to boolean for type: boolean field",
  ...serverTestOpts,
  fn: async () => {
    await withServer(SPEC, async (ctx) => {
      const form = new FormData();
      form.append("default", "true");
      form.append(
        "files[]",
        new File(["hello"], "upload.txt", { type: "text/plain" }),
      );

      const response = await ctx.fetch("/skills/skill_123/versions", {
        method: "POST",
        body: form,
      });

      const diags = diagnosticHeaders(response);
      assertEquals(
        response.status,
        200,
        `Expected 200, got ${response.status}. ` +
          `error-count=${diags["x-steady-error-count"]}, ` +
          `error-1=${diags["x-steady-error-1-code"]}: ${
            diags["x-steady-error-1-message"]
          }`,
      );
      assertEquals(diags["x-steady-error-count"], "0");
      await response.body?.cancel();
    });
  },
});

Deno.test({
  name: "multipart: string '42' is coerced to integer for type: integer field",
  ...serverTestOpts,
  fn: async () => {
    await withServer(SPEC, async (ctx) => {
      const form = new FormData();
      form.append("name", "widget");
      form.append("count", "42");

      const response = await ctx.fetch("/items", {
        method: "POST",
        body: form,
      });

      const diags = diagnosticHeaders(response);
      assertEquals(
        response.status,
        200,
        `Expected 200, got ${response.status}. ` +
          `error-count=${diags["x-steady-error-count"]}, ` +
          `error-1=${diags["x-steady-error-1-code"]}: ${
            diags["x-steady-error-1-message"]
          }`,
      );
      assertEquals(diags["x-steady-error-count"], "0");
      await response.body?.cancel();
    });
  },
});

// ── Multipart-only spec (no application/json entry) ─────────────────

Deno.test({
  name:
    "multipart: coercion works when spec has multipart/form-data but no application/json",
  ...serverTestOpts,
  fn: async () => {
    await withServer(SPEC, async (ctx) => {
      // /items only has multipart/form-data, no application/json
      const form = new FormData();
      form.append("name", "gadget");
      form.append("count", "7");
      form.append("active", "false");

      const response = await ctx.fetch("/items", {
        method: "POST",
        body: form,
      });

      const diags = diagnosticHeaders(response);
      assertEquals(
        response.status,
        200,
        `Expected 200, got ${response.status}. ` +
          `error-count=${diags["x-steady-error-count"]}, ` +
          `error-1=${diags["x-steady-error-1-code"]}: ${
            diags["x-steady-error-1-message"]
          }`,
      );
      assertEquals(diags["x-steady-error-count"], "0");
      await response.body?.cancel();
    });
  },
});

// ── Per-request header override ─────────────────────────────────────

Deno.test({
  name: "multipart: X-Steady-Form-Array-Format header overrides server config",
  ...serverTestOpts,
  fn: async () => {
    // Server has no formArrayFormat configured (defaults to repeat).
    // The per-request header should override to brackets.
    await withServer(SPEC, async (ctx) => {
      const form = new FormData();
      form.append(
        "files[]",
        new File(["hello"], "part-1.txt", { type: "text/plain" }),
      );

      const response = await ctx.fetch("/uploads/upload_123/parts", {
        method: "POST",
        body: form,
        headers: {
          "X-Steady-Form-Array-Format": "brackets",
        },
      });

      const diags = diagnosticHeaders(response);
      assertEquals(
        response.status,
        200,
        `Expected 200, got ${response.status}. ` +
          `error-count=${diags["x-steady-error-count"]}, ` +
          `error-1=${diags["x-steady-error-1-code"]}: ${
            diags["x-steady-error-1-message"]
          }`,
      );
      assertEquals(diags["x-steady-error-count"], "0");
      await response.body?.cancel();
    });
  },
});
