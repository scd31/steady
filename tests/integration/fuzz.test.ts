/**
 * Integration test: run the fuzz library against a real MockServer.
 *
 * Uses FuzzSession to generate and deduplicate cases, sends each to
 * the server, and checks for false positives.
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { request as httpRequest } from "node:http";
import { parseSpecFromFile } from "../../packages/openapi/mod.ts";
import { OpenAPISpec } from "../../packages/openapi/spec.ts";
import { SchemaRegistry } from "@steady/json-schema";
import { MockServer } from "../../src/server/mod.ts";
import { FuzzSession } from "@steady/fuzz";
import type { FuzzRequest } from "@steady/fuzz";

// ── Helpers ─────────────────────────────────────────────────────────

let nextPort = 5200;

interface ServerContext {
  server: MockServer;
  port: number;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

const NO_FETCH_BODY_METHODS = new Set(["GET", "HEAD"]);

/** fetch() throws on GET/HEAD with body, so fall back to node:http. */
function sendRequest(url: string, init?: RequestInit): Promise<Response> {
  const method = init?.method ?? "GET";
  const hasBody = init?.body !== undefined && init.body !== null;

  if (!hasBody || !NO_FETCH_BODY_METHODS.has(method)) {
    return fetch(url, init);
  }

  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: init?.headers as Record<string, string>,
      },
      (res) => {
        const chunks: Uint8Array[] = [];
        res.on("data", (chunk: Uint8Array) => chunks.push(chunk));
        res.on("end", () => {
          const body = new Uint8Array(
            chunks.reduce((acc, c) => acc + c.length, 0),
          );
          let offset = 0;
          for (const chunk of chunks) {
            body.set(chunk, offset);
            offset += chunk.length;
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value) {
              const v = Array.isArray(value) ? value[0] : value;
              if (v) headers.set(key, v);
            }
          }
          resolve(
            new Response(body.length > 0 ? body : null, {
              status: res.statusCode ?? 200,
              headers,
            }),
          );
        });
      },
    );
    req.on("error", reject);
    req.write(init!.body as string);
    req.end();
  });
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
    quiet: true,
    logLevel: "summary",
  });

  server.start();

  try {
    await fn({
      server,
      port,
      fetch: (path, init) =>
        sendRequest(`http://localhost:${port}${path}`, init),
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
    redirect: "manual",
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
      const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));

      const session = new FuzzSession(doc, { seed: 42 });

      for (const fuzzCase of session) {
        await t.step(
          `${fuzzCase.operation}: ${fuzzCase.mutation}`,
          async () => {
            const url = buildUrl(fuzzCase.request);
            const init = toRequestInit(fuzzCase.request);
            const response = await ctx.fetch(url, init);
            await response.body?.cancel();

            const valid = response.headers.get("x-steady-request-valid");
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

// ── Misc ────────────────────────────────────────────────────────────

Deno.test({
  name: "fuzz session: maxCases budget is respected",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    await withServer(FUZZ_SPEC, async (ctx) => {
      const { spec } = await parseSpecFromFile(FUZZ_SPEC);
      const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));

      const session = new FuzzSession(doc, { maxCases: 3 });

      let count = 0;
      for (const fuzzCase of session) {
        const url = buildUrl(fuzzCase.request);
        const init = toRequestInit(fuzzCase.request);
        const response = await ctx.fetch(url, init);
        await response.body?.cancel();

        const valid = response.headers.get("x-steady-request-valid");
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

// ── OpenAPI Directory fuzz tests ────────────────────────────────────

const OPENAPI_DIR = new URL(
  "../../test-fixtures/openapi-directory/APIs",
  import.meta.url,
).pathname;

async function findSpecs(dir: string): Promise<string[]> {
  const specs: string[] = [];

  async function walk(path: string): Promise<void> {
    for await (const entry of Deno.readDir(path)) {
      const fullPath = `${path}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(fullPath);
      } else if (
        entry.name === "openapi.yaml" || entry.name === "openapi.json"
      ) {
        specs.push(fullPath);
      }
    }
  }

  await walk(dir);
  return specs.sort();
}

Deno.test({
  name: "fuzz session: openapi-directory has no false positives",
  ignore: !Deno.env.get("STEADY_FUZZ"),
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const specs = await findSpecs(OPENAPI_DIR);

    const serverErrors: string[] = [];
    const falsePositives: string[] = [];
    let totalCases = 0;

    for (const specPath of specs) {
      const name = specPath.replace(OPENAPI_DIR + "/", "");

      await t.step(name, async () => {
        await withServer(specPath, async (ctx) => {
          const { spec } = await parseSpecFromFile(specPath);
          const doc = new OpenAPISpec(SchemaRegistry.fromSpec(spec));

          const session = new FuzzSession(doc, { seed: 42 });

          for (const fuzzCase of session) {
            const url = buildUrl(fuzzCase.request);
            const init = toRequestInit(fuzzCase.request);
            const response = await ctx.fetch(url, init);
            await response.body?.cancel();

            const valid = response.headers.get("x-steady-request-valid");
            const codes = getDiagnosticCodes(response);
            const status = response.status;

            const serverError = status >= 500;

            const expectsRejection = fuzzCase.expectedCodes.length > 0;
            const isAccepted = valid !== "false";

            session.record(fuzzCase, {
              accepted: isAccepted || serverError,
              reportedCodes: codes,
            });

            if (serverError) {
              serverErrors.push(
                `${name}: SERVER ERROR (${status}) ${fuzzCase.operation} / ${fuzzCase.mutation}`,
              );
            } else if (expectsRejection && valid !== "false") {
              falsePositives.push(
                `${name}: ${fuzzCase.operation} / ${fuzzCase.mutation}`,
              );
            }

            totalCases++;
          }
        });
      });
    }

    await t.step("summary", () => {
      assertNotEquals(totalCases, 0, "Should have tested some cases");
      assertEquals(
        serverErrors.length,
        0,
        `${serverErrors.length} server error(s):\n${serverErrors.join("\n")}`,
      );
      assertEquals(
        falsePositives.length,
        0,
        `${falsePositives.length} false positive(s):\n${
          falsePositives.join("\n")
        }`,
      );
    });
  },
});
