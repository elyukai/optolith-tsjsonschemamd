import { EOL } from "node:os"
import ts from "typescript"

type JSDocComments = ts.NodeArray<ts.JSDocComment>

/**
 * Flattens a TypeScript comment into a simple string.
 */
export const flattenComment = (
  comment: string | JSDocComments | undefined
): string | undefined =>
  ts.getTextOfJSDocComment(comment)?.replaceAll(EOL, "\n")
