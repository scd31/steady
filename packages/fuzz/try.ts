/**
 * Quick script to try the fuzzer against real specs.
 * Run: deno run --allow-read --allow-net packages/fuzz/try.ts <spec-path>
 */

import { parseSpecFromFile } from "@steady/openapi";
import { OpenAPISpecDocument } from "../../packages/openapi/document.ts";
import { MockServer } from "../../src/server.ts";
import { FuzzSession } from "./session.ts";
import type { FuzzRequest } from "./types.ts";

const specPath = Deno.args[0];
if (!specPath) {
  console.error(
    "Usage: deno run --allow-read --allow-net packages/fuzz/try.ts <spec-path>",
  );
  Deno.exit(1);
}

function buildUrl(port: number, req: FuzzRequest): string {
  const queryEntries = Object.entries(req.query);
  const base = `http://localhost:${port}${req.path}`;
  if (queryEntries.length === 0) return base;
  const params = new URLSearchParams();
  for (const [key, value] of queryEntries) {
    params.set(key, value);
  }
  return `${base}?${params.toString()}`;
}

// Parse spec
const { spec } = await parseSpecFromFile(specPath);
const doc = new OpenAPISpecDocument(spec);

// Count operations for context
const pathCount = Object.keys(spec.paths).length;
console.log(`Spec: ${specPath}`);
console.log(`Paths: ${pathCount}`);
console.log();

// Run against a server
const port = 5300;
const server = new MockServer(spec, {
  port,
  host: "localhost",
  logLevel: "summary",
});
server.start();

const session = new FuzzSession(doc, { seed: 42 });

for (const fuzzCase of session) {
  const url = buildUrl(port, fuzzCase.request);
  const init: RequestInit = {
    method: fuzzCase.request.method.toUpperCase(),
    headers: { ...fuzzCase.request.headers },
  };
  if (fuzzCase.request.body !== undefined) {
    init.body = JSON.stringify(fuzzCase.request.body);
  }

  try {
    const response = await fetch(url, init);
    await response.body?.cancel();
    const valid = response.headers.get("x-steady-valid");
    session.record(fuzzCase, {
      accepted: valid === "true",
    });
  } catch {
    // Network error, skip
    session.record(fuzzCase, { accepted: false });
  }
}

server.stop();

const report = session.report();
console.log("--- Report ---");
console.log(`Total cases:     ${report.totalCases}`);
console.log(`Passed:          ${report.passed}`);
console.log(`False positives: ${report.falsePositives}`);
console.log(`Duration:        ${report.durationMs.toFixed(0)}ms`);
console.log(
  `Fingerprints:    ${report.uniqueFingerprints}/${report.totalFingerprints} (${
    (report.fingerprintCoverage * 100).toFixed(0)
  }%)`,
);
console.log(`Stop reason:     ${report.stopReason}`);
console.log();

console.log("--- Per-mutator ---");
for (const ms of report.mutatorStats) {
  if (ms.totalCases === 0) continue;
  const status = ms.falsePositives > 0 ? "FALSE POSITIVES" : "ok";
  console.log(
    `  ${ms.mutatorId}: ${ms.yieldedCases}/${ms.totalCases} yielded, ${ms.passed} passed, ${ms.falsePositives} FP [${status}]`,
  );
}

if (report.falsePositiveDetails.length > 0) {
  console.log();
  console.log("--- False positives ---");
  for (const fp of report.falsePositiveDetails) {
    console.log(`  ${fp.operation}: ${fp.mutation}`);
    console.log(`    Expected: ${fp.expectedCodes.join(", ")}`);
    console.log(`    Got:      ${fp.reportedCodes.join(", ") || "(none)"}`);
  }
}
