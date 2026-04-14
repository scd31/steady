---
name: snapshot-testing
description: How to write snapshot tests in Steady using Deno's @std/testing. Use when adding a test that asserts complex structured output (objects, formatted strings, diagnostics, generated responses) where listing every field manually would be noisy or fragile.
---

# Snapshot Testing in Steady

Steady uses Deno's built-in snapshot testing. Two flavors, with different
ergonomics:

## Inline snapshots (preferred for small values)

The expected value lives next to the assertion as a template literal. No
`TestContext`, no separate file, the diff shows up at the call site.

```ts
import { assertInlineSnapshot } from "@std/testing/unstable-snapshot";

Deno.test("example", () => {
  assertInlineSnapshot(myValue, `{}`);
});
```

Use this when:

- The expected value is small (one screen or less)
- You want the reader to see expected output next to the test
- You're testing a single discrete output

Existing examples: `src/engine/composition/variant-analysis.test.ts`,
`tests/logging/format-diagnostic.test.ts`.

## File snapshots (for large or many outputs)

The expected value lives in `__snapshots__/{test_file}.snap` next to the test.
Requires `Deno.TestContext` as the first argument.

```ts
import { assertSnapshot } from "@std/testing/snapshot";

Deno.test("example", async (t) => {
  await assertSnapshot(t, myValue);
});
```

Use this when:

- The output is large
- A single test file has many similar snapshots
- The output changes frequently and inline snapshots would bloat the source

## Updating snapshots

Both flavors update the same way:

```bash
./scripts/test path/to/file.test.ts -- --update
```

For inline snapshots, this rewrites the test source in place. The harness
already has `--allow-read`, `--allow-write`, `--allow-run`.

To skip `deno fmt` after updating inline snapshots:

```bash
./scripts/test path/to/file.test.ts -- --update --no-format
```

## Red-green flow with snapshots

Snapshot tests are still subject to red-green TDD. The flow:

1. Write the test with an empty or wrong inline snapshot (e.g., `` `{}` ``).
2. Run it. The failure shows the actual current output as the diff.
3. Decide: is the current output correct or not?
   - If correct: run with `-- --update` to capture it.
   - If wrong: implement the fix, then `-- --update` to capture the new output.
4. Re-run without `--update` to confirm green.

Never run `--update` before you've read the failure diff. Snapshot tests that
just rubber-stamp current behavior are worse than no test.

## Pitfalls

- **Inline snapshots and template literals**: the body must use backticks. The
  `--update` rewriter replaces what's between them.
- **Order matters in objects**: snapshots serialize keys in insertion order. If
  your code iterates a `Map` or a sorted set, the test will be brittle unless
  you sort first.
- **Don't snapshot timestamps, random IDs, or RNG output** without normalizing.
  Use seeded RNG or strip volatile fields before asserting.
- **Don't mix `assertEquals` with `assertInlineSnapshot`** for the same value in
  one test. Pick one.
