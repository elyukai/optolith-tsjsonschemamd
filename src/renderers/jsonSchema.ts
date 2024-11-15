import { assertExhaustive } from "@optolith/helpers/typeSafety"
import { EOL } from "node:os"
import { sep } from "node:path"
import {
  ChildNode,
  Doc,
  DocTagTypes,
  ExportAssignmentNode,
  NodeKind,
  RootNode,
  StatementNode,
  TokenKind,
  isReferenceNode,
} from "../ast.js"
import { AstTransformer, Renderer } from "../main.js"
import { ignoreNode } from "../utils/ignoreNode.js"
import {
  getAliasedImportName,
  getFullyQualifiedNameAsPath,
  getRelativeExternalPath,
} from "../utils/references.js"

const IGNORE_ENV = "json-schema"

/**
 * Descriptive annotations of the JSON type definition
 */
interface Annotated {
  title?: string
  description?: string
  default?: unknown
  readOnly?: boolean
}

interface ObjectConstraints {
  minProperties?: number
  maxProperties?: number
}

interface ObjectBase extends ObjectConstraints, Annotated {
  type: "object"
}

interface StrictObject extends ObjectBase {
  properties: {
    [key: string]: Definition
  }
  required: string[]
  additionalProperties?: boolean
}

const isStrictObject = (def: Definition): def is StrictObject =>
  typeof def === "object" && "properties" in def

interface PatternDictionary extends ObjectBase {
  patternProperties: {
    [pattern: string]: Definition
  }
  additionalProperties?: boolean
}

interface Dictionary extends ObjectBase {
  additionalProperties: Definition
}

interface ArrayConstraints {
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
}

interface Array extends ArrayConstraints, Annotated {
  type: "array"
  items: Definition
}

type Tuple = Tuple07 | Tuple202012

interface Tuple07 extends Annotated {
  type: "array"
  items: Definition[]
  minItems: number
  maxItems: number
  additionalItems: boolean
}

interface Tuple202012 extends Annotated {
  type: "array"
  prefixItems: Definition[]
  minItems: number
  maxItems: number
  items: false
}

interface NumberConstraints {
  minimum?: number
  maximum?: number
  exclusiveMinimum?: number
  exclusiveMaximum?: number
  multipleOf?: number
}

interface Number extends NumberConstraints, Annotated {
  type: "number" | "integer"
}

interface StringConstraints {
  minLength?: number
  maxLength?: number
  pattern?: number
  format?: number
}

interface String extends StringConstraints, Annotated {
  type: "string"
}

interface Boolean extends Annotated {
  type: "boolean"
}

interface Union extends Annotated {
  oneOf: Definition[]
}

interface Intersection {
  type?: "object"
  allOf: Definition[]
  unevaluatedProperties?: boolean
}

interface Constant extends Annotated {
  const: string | number | boolean
}

interface Enum extends Annotated {
  enum: (string | number)[]
}

interface Reference extends Annotated {
  $ref: string
}

const isReference = (def: Definition): def is Reference =>
  typeof def === "object" && "$ref" in def

interface Group {
  _groupBrand: any
  [identifier: string]: Definition
}

type Definition =
  | StrictObject
  | Dictionary
  | PatternDictionary
  | Array
  | Number
  | String
  | Boolean
  | Reference
  | Union
  | Intersection
  | Constant
  | Enum
  | Tuple
  | Group

const toAnnotations = (jsDoc: Doc | undefined) => ({
  title: jsDoc?.tags.title,
  description: jsDoc?.comment,
})

const toDefault = (jsDoc: Doc | undefined) =>
  jsDoc?.tags.default !== undefined
    ? {
        default: jsDoc?.tags.default,
      }
    : undefined

type ConstraintsByType = {
  number: NumberConstraints
  string: StringConstraints
  object: ObjectConstraints
  array: ArrayConstraints
}

type IgnoreValue<T> = { [K in keyof T]-?: 0 }

type IgnoreValueEach<T> = { [K in keyof T]: IgnoreValue<T[K]> }

// ensures that each key is present in a runtime object
const constraintsByType: IgnoreValueEach<ConstraintsByType> = {
  number: {
    maximum: 0,
    minimum: 0,
    exclusiveMinimum: 0,
    exclusiveMaximum: 0,
    multipleOf: 0,
  },
  string: { minLength: 0, maxLength: 0, format: 0, pattern: 0 },
  object: { minProperties: 0, maxProperties: 0 },
  array: { minItems: 0, maxItems: 0, uniqueItems: 0 },
}

const toConstraints = <T extends keyof ConstraintsByType>(
  jsDoc: Doc | undefined,
  type: T
): ConstraintsByType[T] =>
  Object.fromEntries(
    jsDoc
      ? (
          Object.keys(constraintsByType[type]) as (keyof ConstraintsByType[T])[]
        ).flatMap((key) => {
          if (jsDoc.tags[key as keyof DocTagTypes] !== undefined) {
            return [[key, jsDoc.tags[key as keyof DocTagTypes]]]
          } else {
            return []
          }
        })
      : []
  )

const nodeToDefinition = (
  node: ChildNode,
  file: RootNode,
  options: Required<JsonSchemaRendererOptions>,
  shallowOptions: {
    isReadOnly?: boolean
  } = {}
): Definition => {
  const { spec, allowAdditionalProperties } = options
  const { isReadOnly } = shallowOptions

  switch (node.kind) {
    case NodeKind.Record: {
      return {
        ...toAnnotations(node.jsDoc),
        type: "object",
        ...toDefault(node.jsDoc),
        properties: Object.fromEntries(
          node.members
            .filter((member) => !ignoreNode(member, IGNORE_ENV))
            .map((member) => [
              member.identifier,
              nodeToDefinition(member.value, file, options, {
                isReadOnly: member.isReadOnly,
              }),
            ])
        ),
        required: node.members
          .filter((member) => member.isRequired)
          .map((member) => member.identifier),
        ...toConstraints(node.jsDoc, "object"),
        ...(isReadOnly ? { readOnly: true } : undefined),
        additionalProperties: allowAdditionalProperties,
      }
    }
    case NodeKind.Dictionary: {
      if (node.pattern !== undefined) {
        return {
          ...toAnnotations(node.jsDoc),
          type: "object",
          ...toDefault(node.jsDoc),
          patternProperties: {
            [node.pattern]: nodeToDefinition(node.children, file, options),
          },
          ...toConstraints(node.jsDoc, "object"),
          ...(isReadOnly ? { readOnly: true } : undefined),
          additionalProperties: allowAdditionalProperties,
        }
      } else {
        return {
          ...toAnnotations(node.jsDoc),
          type: "object",
          ...toDefault(node.jsDoc),
          additionalProperties: nodeToDefinition(node.children, file, options),
          ...toConstraints(node.jsDoc, "object"),
          ...(isReadOnly ? { readOnly: true } : undefined),
        }
      }
    }
    case NodeKind.Array: {
      return {
        ...toAnnotations(node.jsDoc),
        type: "array",
        ...toDefault(node.jsDoc),
        items: nodeToDefinition(node.children, file, options),
        ...toConstraints(node.jsDoc, "array"),
        ...(isReadOnly ? { readOnly: true } : undefined),
      }
    }
    case NodeKind.Tuple: {
      switch (spec) {
        case JsonSchemaSpec.Draft_07:
        case JsonSchemaSpec.Draft_2019_09:
          return {
            ...toAnnotations(node.jsDoc),
            type: "array",
            items: node.children.map((child) =>
              nodeToDefinition(child, file, options)
            ),
            ...toDefault(node.jsDoc),
            minItems: node.children.length,
            maxItems: node.children.length,
            additionalItems: false,
            ...(isReadOnly ? { readOnly: true } : undefined),
          }
        case JsonSchemaSpec.Draft_2020_12:
          return {
            ...toAnnotations(node.jsDoc),
            type: "array",
            prefixItems: node.children.map((child) =>
              nodeToDefinition(child, file, options)
            ),
            ...toDefault(node.jsDoc),
            minItems: node.children.length,
            maxItems: node.children.length,
            items: false,
            ...(isReadOnly ? { readOnly: true } : undefined),
          }
        default:
          return assertExhaustive(spec, "invalid spec")
      }
    }
    case NodeKind.Union: {
      return {
        ...toAnnotations(node.jsDoc),
        oneOf: node.children.map((child) =>
          nodeToDefinition(child, file, options)
        ),
        ...toDefault(node.jsDoc),
        ...(isReadOnly ? { readOnly: true } : undefined),
      }
    }
    case NodeKind.Intersection: {
      const allOf = node.children.map((child) =>
        nodeToDefinition(child, file, options)
      )

      const base = {
        ...toAnnotations(node.jsDoc),
        allOf,
        ...toDefault(node.jsDoc),
        ...(isReadOnly ? { readOnly: true } : undefined),
      }

      if (allOf.every((e) => isStrictObject(e) || isReference(e))) {
        if (isUnresolvedPropertiesSupported(spec)) {
          allOf.forEach(
            (e) =>
              "additionalProperties" in e &&
              typeof e.additionalProperties === "boolean" &&
              delete e.additionalProperties
          )
          return {
            ...base,
            type: "object",
            unevaluatedProperties: allowAdditionalProperties,
          }
        } else {
          console.warn(
            'The requested JSON Schema spec does not support intersecting record types with "additionalProperties" set to false, which will likely result in unexpected validation errors. Consider switching to a newer JSON Schema spec or do not use intersection types.'
          )
        }
      }

      return base
    }
    case NodeKind.Literal: {
      return {
        ...toAnnotations(node.jsDoc),
        const: node.value,
        ...toDefault(node.jsDoc),
        ...(isReadOnly ? { readOnly: true } : undefined),
      }
    }
    case NodeKind.Reference: {
      const externalFilePath = getRelativeExternalPath(
        node,
        file,
        ".schema.json"
      )
      const qualifiedName = getFullyQualifiedNameAsPath(node, file)

      return {
        ...toAnnotations(node.jsDoc),
        $ref: `${externalFilePath}#/${defsKey(spec)}/${
          getAliasedImportName(node, file) ?? qualifiedName
        }`,
        ...toDefault(node.jsDoc),
        ...(isReadOnly ? { readOnly: true } : undefined),
      }
    }
    case NodeKind.Token: {
      switch (node.token) {
        case TokenKind.Number: {
          return {
            ...toAnnotations(node.jsDoc),
            type: node.jsDoc?.tags.integer ? "integer" : "number",
            ...toDefault(node.jsDoc),
            ...toConstraints(node.jsDoc, "number"),
            ...(isReadOnly ? { readOnly: true } : undefined),
          }
        }

        case TokenKind.String: {
          return {
            ...toAnnotations(node.jsDoc),
            type: "string",
            ...toDefault(node.jsDoc),
            ...toConstraints(node.jsDoc, "string"),
            ...(isReadOnly ? { readOnly: true } : undefined),
          }
        }

        case TokenKind.Boolean: {
          return {
            ...toAnnotations(node.jsDoc),
            type: "boolean",
            ...toDefault(node.jsDoc),
            ...(isReadOnly ? { readOnly: true } : undefined),
          }
        }
      }
    }
    default:
      return assertExhaustive(node)
  }
}

const statementToDefinition = (
  node: StatementNode,
  file: RootNode,
  options: Required<JsonSchemaRendererOptions>,
  shallowOptions: { isReadOnly?: boolean } = {}
): Definition | undefined => {
  const { isReadOnly } = shallowOptions

  switch (node.kind) {
    case NodeKind.TypeDefinition: {
      return ignoreNode(node, IGNORE_ENV)
        ? undefined
        : nodeToDefinition(node.definition, file, options)
    }
    case NodeKind.ExportAssignment: {
      return undefined
    }
    case NodeKind.Enumeration: {
      return ignoreNode(node, IGNORE_ENV)
        ? undefined
        : {
            ...toAnnotations(node.jsDoc),
            enum: node.children.map(({ value }) => value),
            ...toDefault(node.jsDoc),
            ...(isReadOnly ? { readOnly: true } : undefined),
          }
    }
    case NodeKind.Group: {
      return ignoreNode(node, IGNORE_ENV)
        ? undefined
        : (Object.fromEntries(
            Object.entries(node.children).map(([key, node]) => [
              key,
              statementToDefinition(node, file, options),
            ])
          ) as Group)
    }
    default:
      return assertExhaustive(node, "invalid statement")
  }
}

const toForwardSlashAbsolutePath = (path: string) =>
  "/" + path.split(sep).join("/")

const getMainRef = (
  file: RootNode,
  spec: JsonSchemaSpec
): string | undefined => {
  if (file.jsDoc?.tags.main !== undefined) {
    return `#/${defsKey(spec)}/${file.jsDoc.tags.main}`
  }

  const defaultExport = file.children.find(
    (node) => node.name === "default" && node.kind === NodeKind.ExportAssignment
  ) as ExportAssignmentNode | undefined

  if (
    defaultExport !== undefined &&
    isReferenceNode(defaultExport.expression)
  ) {
    const externalFilePath = getRelativeExternalPath(
      defaultExport.expression,
      file,
      ".schema.json"
    )

    const qualifiedName = getFullyQualifiedNameAsPath(
      defaultExport.expression,
      file
    )

    return `${externalFilePath}#/${defsKey(spec)}/${qualifiedName}`
  }
}

const astToJsonSchema =
  (options: Required<JsonSchemaRendererOptions>): AstTransformer =>
  (file, { relativePath }): string => {
    const { spec } = options

    const jsonSchema = {
      $schema: schemaUri(spec),
      $id: toForwardSlashAbsolutePath(relativePath),
      $ref: getMainRef(file, spec),
      [defsKey(spec)]: Object.fromEntries(
        file.children
          .map((node) => [
            node.name,
            statementToDefinition(node, file, options),
          ])
          .filter(([_, def]) => def !== undefined)
      ),
    }

    return `${JSON.stringify(jsonSchema, undefined, 2).replace(
      /\n/g,
      EOL
    )}${EOL}`
  }

const defsKey = (spec: JsonSchemaSpec) => {
  switch (spec) {
    case JsonSchemaSpec.Draft_07:
      return "definitions"
    case JsonSchemaSpec.Draft_2019_09:
    case JsonSchemaSpec.Draft_2020_12:
      return "$defs"
    default:
      return assertExhaustive(spec, "invalid spec")
  }
}

const schemaUri = (spec: JsonSchemaSpec): string => {
  switch (spec) {
    case JsonSchemaSpec.Draft_07:
      return "https://json-schema.org/draft-07/schema"
    case JsonSchemaSpec.Draft_2019_09:
      return "https://json-schema.org/draft/2019-09/schema"
    case JsonSchemaSpec.Draft_2020_12:
      return "https://json-schema.org/draft/2020-12/schema"
    default:
      return assertExhaustive(spec, "invalid spec")
  }
}

const isUnresolvedPropertiesSupported = (spec: JsonSchemaSpec): boolean => {
  switch (spec) {
    case JsonSchemaSpec.Draft_07:
      return false
    case JsonSchemaSpec.Draft_2019_09:
    case JsonSchemaSpec.Draft_2020_12:
      return true
    default:
      return assertExhaustive(spec, "invalid spec")
  }
}

export const JsonSchemaSpec = Object.freeze({
  Draft_07: "Draft_07",
  Draft_2019_09: "Draft_2019_09",
  Draft_2020_12: "Draft_2020_12",
})

export type JsonSchemaSpec = keyof typeof JsonSchemaSpec

export type JsonSchemaRendererOptions = {
  /**
   * The used JSON Schema specification.
   * @default JsonSchemaSpec.Draft_2020_12
   */
  spec?: JsonSchemaSpec

  /**
   * Whether to allow unresolved additional keys in object definitions.
   * @default false
   */
  allowAdditionalProperties?: boolean
}

export const jsonSchemaRenderer = ({
  spec = JsonSchemaSpec.Draft_2020_12,
  allowAdditionalProperties = false,
}: JsonSchemaRendererOptions = {}): Renderer =>
  Object.freeze({
    transformer: astToJsonSchema({ spec, allowAdditionalProperties }),
    fileExtension: ".schema.json",
    resolveTypeParameters: true,
  })
