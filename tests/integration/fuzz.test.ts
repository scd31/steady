/**
 * Integration test: run the fuzz library against a real MockServer.
 *
 * Uses FuzzSession to generate and deduplicate cases, sends each to
 * the server, and checks for false positives.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { parseSpecFromFile } from "../../packages/openapi/mod.ts";
import { OpenAPISpecDocument } from "../../packages/openapi/document.ts";
import { MockServer } from "../../src/server.ts";
import { FuzzSession } from "@steady/fuzz";
import type { FuzzRequest } from "@steady/fuzz";

// ── Helpers ─────────────────────────────────────────────────────────

let nextPort = 5200;

interface ServerContext {
  server: MockServer;
  port: number;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

async function withServer(
  specPath: string,
  fn: (ctx: ServerContext) => Promise<void>,
): Promise<void> {
  const port = nextPort++;
  const { spec } = await parseSpecFromFile(specPath);
  const server = new MockServer(spec, {
    port,
    host: "localhost",
    logLevel: "summary",
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

function buildUrl(req: FuzzRequest): string {
  const queryEntries = Object.entries(req.query);
  if (queryEntries.length === 0) return req.path;
  const params = new URLSearchParams();
  for (const [key, value] of queryEntries) {
    params.set(key, value);
  }
  return `${req.path}?${params.toString()}`;
}

function toRequestInit(req: FuzzRequest): RequestInit {
  const init: RequestInit = {
    method: req.method.toUpperCase(),
    headers: { ...req.headers },
  };
  if (req.body !== undefined) {
    init.body = JSON.stringify(req.body);
  }
  return init;
}

function getDiagnosticCodes(response: Response): string[] {
  const codes: string[] = [];
  const count = parseInt(
    response.headers.get("x-steady-error-count") ?? "0",
    10,
  );
  for (let i = 1; i <= count; i++) {
    const code = response.headers.get(`x-steady-error-${i}-code`);
    if (code) codes.push(code);
  }
  return codes;
}

// ── Tests ────────────────────────────────────────────────────────────

const FUZZ_SPEC = "./tests/specs/fuzz-test-spec.yaml";

Deno.test({
  name: "fuzz session: finds no false positives",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    await withServer(FUZZ_SPEC, async (ctx) => {
      const { spec } = await parseSpecFromFile(FUZZ_SPEC);
      const doc = new OpenAPISpecDocument(spec);

      const session = new FuzzSession(doc, { seed: 42 });

      for (const fuzzCase of session) {
        await t.step(
          `${fuzzCase.operation}: ${fuzzCase.mutation}`,
          async () => {
            const url = buildUrl(fuzzCase.request);
            const init = toRequestInit(fuzzCase.request);
            const response = await ctx.fetch(url, init);
            await response.body?.cancel();

            const valid = response.headers.get("x-steady-valid");
            const codes = getDiagnosticCodes(response);
            const status = response.status;

            // 5xx = Steady crashed, which is worse than a false positive
            const serverError = status >= 500;

            session.record(fuzzCase, {
              accepted: valid === "true" || serverError,
              reportedCodes: codes,
            });

            assertEquals(
              serverError,
              false,
              `SERVER ERROR (${status}): ${fuzzCase.operation} / ${fuzzCase.mutation}`,
            );
            assertEquals(
              valid,
              "false",
              `FALSE POSITIVE: ${fuzzCase.operation} / ${fuzzCase.mutation}`,
            );
          },
        );
      }

      const report = session.report();

      await t.step("report summary", () => {
        assertNotEquals(report.totalCases, 0, "Should have tested some cases");
        assertEquals(
          report.falsePositives,
          0,
          `Found ${report.falsePositives} false positive(s):\n` +
            report.falsePositiveDetails
              .map((fp) => `  - ${fp.operation}: ${fp.mutation}`)
              .join("\n"),
        );
      });
    });
  },
});

const CLOUDFLARE_SPEC = "./sdk-tests/cloudflare-python/openapi-spec.yml";

Deno.test({
  name: "fuzz session: cloudflare spec has no false positives",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    await withServer(CLOUDFLARE_SPEC, async (ctx) => {
      const { spec } = await parseSpecFromFile(CLOUDFLARE_SPEC);
      const doc = new OpenAPISpecDocument(spec);

      const session = new FuzzSession(doc, { seed: 42 });

      for (const fuzzCase of session) {
        await t.step(
          `${fuzzCase.operation}: ${fuzzCase.mutation}`,
          async () => {
            const url = buildUrl(fuzzCase.request);
            const init = toRequestInit(fuzzCase.request);
            const response = await ctx.fetch(url, init);
            await response.body?.cancel();

            const valid = response.headers.get("x-steady-valid");
            const codes = getDiagnosticCodes(response);
            const status = response.status;

            // 5xx = Steady crashed, which is worse than a false positive
            const serverError = status >= 500;

            session.record(fuzzCase, {
              accepted: valid === "true" || serverError,
              reportedCodes: codes,
            });

            assertEquals(
              serverError,
              false,
              `SERVER ERROR (${status}): ${fuzzCase.operation} / ${fuzzCase.mutation}`,
            );
            assertEquals(
              valid,
              "false",
              `FALSE POSITIVE: ${fuzzCase.operation} / ${fuzzCase.mutation}`,
            );
          },
        );
      }

      const report = session.report();

      await t.step("report summary", () => {
        assertNotEquals(report.totalCases, 0, "Should have tested some cases");
        assertEquals(
          report.falsePositives,
          0,
          `Found ${report.falsePositives} false positive(s):\n` +
            report.falsePositiveDetails
              .map((fp) => `  - ${fp.operation}: ${fp.mutation}`)
              .join("\n"),
        );
      });
    });
  },
});

Deno.test({
  name: "fuzz session: maxCases budget is respected",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(FUZZ_SPEC, async (ctx) => {
      const { spec } = await parseSpecFromFile(FUZZ_SPEC);
      const doc = new OpenAPISpecDocument(spec);

      const session = new FuzzSession(doc, { maxCases: 3 });

      let count = 0;
      for (const fuzzCase of session) {
        const url = buildUrl(fuzzCase.request);
        const init = toRequestInit(fuzzCase.request);
        const response = await ctx.fetch(url, init);
        await response.body?.cancel();

        const valid = response.headers.get("x-steady-valid");
        session.record(fuzzCase, { accepted: valid === "true" });
        count++;
      }

      assertEquals(count, 3);
      const report = session.report();
      assertEquals(report.totalCases, 3);
      assertEquals(report.stopReason, "maxCases");
    });
  },
});
