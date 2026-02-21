import type { ServerConfig } from "../types.ts";
import { HEADERS } from "../types.ts";
import type { GenerateOptions } from "@steady/json-schema";
import { parseStreamingOptions, type StreamingOptions } from "../streaming.ts";

/**
 * Default seed for deterministic generation.
 * Uses a simple hash of "steady" to get a stable number.
 */
export const DEFAULT_SEED = 123456789;

/**
 * Whether to reject requests that have SDK issues (E3xxx diagnostics).
 * X-Steady-Reject-On-Error header overrides the server default.
 */
export function getRejectOnSdkError(
  req: Request,
  config: ServerConfig,
): boolean {
  const headerValue = req.headers.get(HEADERS.REJECT_ON_ERROR);
  if (headerValue === "true") return true;
  if (headerValue === "false") return false;
  return config.rejectOnSdkError ?? false;
}

/**
 * Get effective generator options for a request.
 * Headers override config defaults.
 */
export function getEffectiveGeneratorOptions(
  req: Request,
  config: ServerConfig,
): GenerateOptions {
  const genConfig = config.generator ?? {};

  // Parse headers (headers override config)
  const headerArraySize = req.headers.get(HEADERS.ARRAY_SIZE);
  const headerArrayMin = req.headers.get(HEADERS.ARRAY_MIN);
  const headerArrayMax = req.headers.get(HEADERS.ARRAY_MAX);
  const headerSeed = req.headers.get(HEADERS.SEED);

  // If array-size header is set, it overrides both min and max
  let arrayMin: number | undefined;
  let arrayMax: number | undefined;

  if (headerArraySize) {
    const size = parseInt(headerArraySize, 10);
    if (!isNaN(size)) {
      arrayMin = size;
      arrayMax = size;
    }
  } else {
    if (headerArrayMin) {
      const min = parseInt(headerArrayMin, 10);
      if (!isNaN(min)) arrayMin = min;
    }
    if (headerArrayMax) {
      const max = parseInt(headerArrayMax, 10);
      if (!isNaN(max)) arrayMax = max;
    }
  }

  // Merge: header > config > default
  const finalArrayMin = arrayMin ?? genConfig.arrayMin;
  const finalArrayMax = arrayMax ?? genConfig.arrayMax;

  // Seed: header > config > default (deterministic)
  // Special value -1 means "use random seed"
  let seed: number;
  if (headerSeed) {
    const parsedSeed = parseInt(headerSeed, 10);
    if (isNaN(parsedSeed)) {
      seed = DEFAULT_SEED;
    } else if (parsedSeed === -1) {
      seed = Math.random() * 1000000;
    } else {
      seed = parsedSeed;
    }
  } else {
    const configSeed = genConfig.seed ?? DEFAULT_SEED;
    seed = configSeed === -1 ? Math.random() * 1000000 : configSeed;
  }

  return {
    arrayMin: finalArrayMin,
    arrayMax: finalArrayMax,
    seed,
  };
}

/**
 * Get effective streaming options by merging header overrides with config defaults.
 * Priority: header > config > default
 */
export function getEffectiveStreamingOptions(
  req: Request,
  config: ServerConfig,
): StreamingOptions {
  const streamConfig = config.streaming ?? {};

  // Parse headers (headers override config)
  const headerOptions = parseStreamingOptions(req);

  // Merge: header > config > default
  return {
    count: headerOptions.count ?? streamConfig.count,
    interval: headerOptions.interval ?? streamConfig.interval,
  };
}
