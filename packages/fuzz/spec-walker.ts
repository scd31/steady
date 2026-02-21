/**
 * Walk an OpenAPI spec and extract testable operations.
 *
 * Uses OpenAPISpecDocument for $ref resolution and parameter merging.
 */

import type { OpenAPISpecDocument } from "@steady/openapi";
import type { OperationInfo, ParameterInfo } from "./types.ts";

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
] as const;

/**
 * Walk all operations in a spec and extract structured info for fuzzing.
 *
 * @param doc - A parsed OpenAPISpecDocument (handles $ref resolution)
 * @returns One OperationInfo per operation in the spec
 */
export function walkSpec(doc: OpenAPISpecDocument): OperationInfo[] {
  const operations: OperationInfo[] = [];
  const paths = doc.paths;

  for (const pathPattern of Object.keys(paths)) {
    const pathItem = paths[pathPattern];
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const params = doc.getParameters(pathPattern, method);

      const pathParams: ParameterInfo[] = [];
      const queryParams: ParameterInfo[] = [];
      const headerParams: ParameterInfo[] = [];

      for (const p of params) {
        const info: ParameterInfo = {
          name: p.name,
          in: p.in,
          required: p.required,
          schema: p.schema,
        };

        switch (p.in) {
          case "path":
            pathParams.push(info);
            break;
          case "query":
            queryParams.push(info);
            break;
          case "header":
            headerParams.push(info);
            break;
            // cookie params are rarely used in practice; skip for now
        }
      }

      const bodySchema = doc.getBodySchema(pathPattern, method);
      const contentTypes = doc.getAcceptedContentTypes(pathPattern, method);

      const bodyInfo = bodySchema
        ? {
          schema: bodySchema.schema,
          required: bodySchema.required,
          contentTypes: contentTypes ?? [],
        }
        : null;

      operations.push({
        path: pathPattern,
        method,
        pathParams,
        queryParams,
        headerParams,
        bodyInfo,
      });
    }
  }

  return operations;
}
