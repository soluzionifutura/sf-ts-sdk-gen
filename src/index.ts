/* eslint-disable no-console */
import { readFileSync, ensureDirSync, writeFileSync } from "fs-extra"
import { parse } from "@soluzioni-futura/openapi2ts"
import { join } from "path"
import semver from "semver"
import { OpenAPIV3_1 } from "openapi-types"
import SwaggerParser from "@apidevtools/swagger-parser"

export type Options = {
  openapi: OpenAPIV3_1.Document | string,
  outputFolder: string,
  sdkName?: string,
  sdkVersion?: string,
  repoUrl?: string
}

export async function generateSdk({
  openapi,
  outputFolder,
  sdkName,
  sdkVersion,
  repoUrl
}: Options): Promise<void> {
  if (typeof openapi === "string") {
    openapi = JSON.parse(readFileSync(openapi, "utf8")) as OpenAPIV3_1.Document
  }

  if (!sdkVersion || typeof sdkVersion !== "string") {
    sdkVersion = "0.1.0"
  } else if (!semver.valid(sdkVersion)) {
    throw new Error(`Invalid sdkVersion: ${sdkVersion}`)
  }

  const openapiV3_1 = openapi as OpenAPIV3_1.Document
  // dereference openapi: the JSON.parse(JSON.stringify()) is done to clone the object and avoid mutating the original openapi object
  const openapiV3_1Deref = await SwaggerParser.dereference(JSON.parse(JSON.stringify(openapiV3_1)))
  const SDK_NAME = sdkName || `${openapiV3_1.info.title}-sdk`

  ensureDirSync(join(outputFolder, "src"))

  // generate types
  const { data: typesCode,  exports: typesSet }  = await parse({
    openapi: openapiV3_1,
    bannerComment: ""
  })

  // generate sdk

  const serverUrls = openapiV3_1.servers!.reduce((acc: { [env: string]: string }, { description, url }) => {
    if (!description) {
      throw new Error("All servers must have a description")
    }
    acc[description.toLowerCase()] = url
    return acc
  }, {})

  const securitySchemas = openapiV3_1.components?.securitySchemes || {}
  const schemas = openapiV3_1.components?.schemas || {}
  const hasSecurity = Object.keys(securitySchemas).length > 0
  let hasSSE = false
  const functions = Object.entries(openapi.paths!).map(([path, pathItem]) => {
    if (!pathItem) {
      return
    }

    if (
      (pathItem.post && pathItem.post.operationId && !pathItem.get) ||
      (pathItem.get && pathItem.get.operationId && !pathItem.post)
    ) {

      const method = pathItem.post ? "POST" : "GET"
      const derefPathItem = openapiV3_1Deref.paths![path]!

      const {
        parameters,
        description,
        operationId,
        requestBody,
        responses,
        security
      } = typeof pathItem.post === "object" ? pathItem.post! : pathItem.get!

      const {
        responses: derefResponses
      } = typeof derefPathItem.post === "object" ? derefPathItem.post! : derefPathItem.get!
      if (!operationId) {
        console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `operationId is missing in, ${path} ${method}`)
        return
      }

      const upperCamelCaseOperationId = `${operationId[0].toUpperCase()}${operationId.substring((1))}`

      let requestType
      let isSSE = false

      const isConfigHeadersRequired = parameters ? (parameters as OpenAPIV3_1.ParameterObject[]).some(p => p.in === "header" && p.required === true) || false : false
      const isConfigPathRequired = parameters ? (parameters as OpenAPIV3_1.ParameterObject[]).some(p => p.in === "path" && p.required === true) || false : false
      const isConfigQueryRequired = parameters ? (parameters as OpenAPIV3_1.ParameterObject[]).some(p => p.in === "query" && p.required === true) || false : false

      const isConfigRequired = isConfigHeadersRequired || isConfigPathRequired || isConfigQueryRequired

      const headersTypeKeyName = `${upperCamelCaseOperationId}HeaderParams`
      const pathTypeKeyName = `${upperCamelCaseOperationId}PathParams`
      const queryTypeKeyName = `${upperCamelCaseOperationId}QueryParams`

      const hasCustomHeaders = parameters ? schemas[headersTypeKeyName] && (parameters as OpenAPIV3_1.ParameterObject[]).some(p => p.in === "header") || false : false
      const hasCustomPath = parameters ? schemas[pathTypeKeyName] && (parameters as OpenAPIV3_1.ParameterObject[]).some(p => p.in === "path") || false : false
      const hasCustomQuery = parameters ? schemas[queryTypeKeyName] && (parameters as OpenAPIV3_1.ParameterObject[]).some(p => p.in === "query") || false : false

      const hasCustomParams = hasCustomHeaders || hasCustomPath || hasCustomQuery

      if (requestBody) {
        const ref = (requestBody as OpenAPIV3_1.ReferenceObject).$ref
        if (!ref) {

          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `requestBody.$ref is missing in ${method} ${path}; requestBody must be a $ref to a schema`)
          return
        }

        const requestBodyRef = ref.split("/").pop()!
        if (!requestBodyRef) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `requestBody.$ref is invalid in ${method} ${path}; requestBody must be a $ref to a schema`)
          return
        }

        const requestBodyDetails = openapiV3_1.components?.requestBodies?.[requestBodyRef] as OpenAPIV3_1.RequestBodyObject | undefined
        if (!requestBodyDetails) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `requestBody.$ref is invalid in ${method} ${path}; ${requestBodyRef} is not defined in components.requestBodies`)
          return
        }

        const requestBodySchema = requestBodyDetails.content["application/json"]?.schema as OpenAPIV3_1.ReferenceObject | undefined
        if (!requestBodySchema) {
          console.log(requestBodyDetails.content)
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `requestBody.$ref is invalid in ${method} ${path}; ${requestBodyRef} does not have an application/json schema`)
          return
        }

        if (!requestBodySchema.$ref) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `requestBody.$ref is invalid in ${method} ${path}; ${requestBodyRef} application/json schema must be a $ref to a schema`)
          return
        }

        const requestBodySchemaRef = requestBodySchema.$ref.split("/").pop()!
        if (!requestBodySchemaRef) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `requestBody.$ref is invalid in ${method} ${path}; ${requestBodySchema.$ref} must be a valid $ref to a schema`)
          return
        }

        if (!typesSet.has(requestBodySchemaRef)) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `requestBody.$ref is invalid in ${method} ${path}; ${requestBodySchemaRef} has not been generated by openapi2ts`)
          return
        }

        requestType = requestBodySchemaRef
      }

      if (!responses) {
        console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `responses is missing in ${method} ${path}`)
        return
      }

      const responseTypes = Object.entries(responses).map(([statusCode, response]) => {
        const ref = (response as OpenAPIV3_1.ReferenceObject).$ref
        if (!ref) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `response.$ref is missing in ${method} ${path} ${statusCode}; response must be a $ref to a schema`)
          return
        }

        const responseRef = ref.split("/").pop()!
        if (!responseRef) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `response.$ref is invalid in ${method} ${path} ${statusCode}; response must be a $ref to a schema`)
          return
        }

        const responseDetails = openapiV3_1.components?.responses?.[responseRef] as OpenAPIV3_1.ResponseObject | undefined
        if (!responseDetails) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `response.$ref is invalid in ${method} ${path} ${statusCode}; ${responseRef} is not defined in components.responses`)
          return
        }

        const allowedContentTypes = ["application/json", "text/event-stream"]
        let content
        for (let i = 0; i < allowedContentTypes.length; i++) {
          const contentType = allowedContentTypes[i]
          if (responseDetails.content?.[contentType]) {
            content = responseDetails.content[contentType]
            break
          }
        }
        if (!content) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `response.$ref is invalid in ${method} ${path} ${statusCode}; ${responseRef} does not have an allowed content type (${allowedContentTypes.join(", ")})`)
          return
        }

        if (responseDetails.content?.["text/event-stream"]) {
          if (method !== "GET") {
            console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `response.$ref is invalid in ${method} ${path} ${statusCode}; ${responseRef} cannot have a content type of text/event-stream; method must be GET`)
            return
          } else {
            isSSE = true
            hasSSE = true
          }
        }

        const responseSchema = (content.schema) as OpenAPIV3_1.ReferenceObject | undefined
        if (!responseSchema) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `response.$ref is invalid in ${method} ${path} ${statusCode}; ${responseRef} does not have an allowed content type (${allowedContentTypes.join(", ")})`)
          return
        }

        if (!responseSchema.$ref) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `response.$ref is invalid in ${method} ${path} ${statusCode}; ${responseRef} application/json schema must be a $ref to a schema`)
          return
        }

        const responseSchemaRef = responseSchema.$ref.split("/").pop()!
        if (!responseSchemaRef) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `response.$ref is invalid in ${method} ${path} ${statusCode}; ${responseSchema.$ref} must be a valid $ref to a schema`)
          return
        }

        if (!typesSet.has(responseSchemaRef)) {
          console.warn("WARNING, SKIPPING ENDPOINT GENERATION:", `response.$ref is invalid in ${method} ${path} ${statusCode}; ${responseSchemaRef} has not been generated by openapi2ts`)
          return
        }

        if (isSSE) {
          return `CustomEventSource<${responseSchemaRef}>`
        } else {
          return `(AxiosResponse<${responseSchemaRef}> & { status: ${statusCode} })`
        }
      })

      const responseType = responseTypes.join(" | ")
      const successResponseType = responseTypes.filter(e => e && !e.includes("4") && !e.includes("5")).join(" | ")
      let errorResponseType: string
      const errorResponseTypeArr = responseTypes.filter(e => e && (e.includes("4") || e.includes("5")))
      if (errorResponseTypeArr.length === 0) {
        errorResponseType = "never"
      } else {
        errorResponseType = `(${errorResponseTypeArr.join(" | ")}) & { path: "${path}" }`
      }
      const securityKeys = Array.from(new Set((security?.map(e => Object.keys(e)) || [])))

      if (isSSE) {
        const responseTypeName = `${upperCamelCaseOperationId}EventSource`
        const requestConfigTypeName = hasCustomParams ? `${upperCamelCaseOperationId}RequestConfig` : "SSERequestConfig"
        if (hasCustomHeaders) {
          console.warn("WARNING, STRIPPING CUSTOM HEADERS:", `headers are not supported in ${method} ${path}; SSE endpoints cannot have custom headers`)
        }
        const requestConfigType = `{${
          hasCustomPath ? `\n  path${isConfigPathRequired ? "" : "?"}: ${pathTypeKeyName}` : ""
        }${
          hasCustomQuery ? `\n  params${isConfigQueryRequired ? "" : "?"}: ${queryTypeKeyName}` : ""
        }
}`
        return [
          description ? `/**\n${description}\n*/` : "",
          hasCustomParams ? `export type ${requestConfigTypeName} = SSERequestConfig & ${requestConfigType}` : null,
          `export type ${responseTypeName} = ${responseType}`,
          `export function ${operationId}(config${isConfigRequired ? "" : "?"}: ${requestConfigTypeName}): ${responseTypeName} {
  _checkSetup()
  const securityParams = ${hasSecurity && security && securityKeys.length ? `_getAuth(new Set([${securityKeys.map(e => `"${e}"`).join(", ")}]))` : "{}" }
  return new Proxy(new ES!(_getFnUrl("${path}", config ? deepmerge(securityParams, config, { isMergeableObject: isPlainObject }) : securityParams)${hasSecurity ? ", { withCredentials: true }" : ""}), _proxy) as ${responseTypeName}
}`
        ].filter(e => e).join("\n")
      } else {
        const responseTypeName = `Axios${upperCamelCaseOperationId}Response`
        const successResponseTypeName = `Axios${upperCamelCaseOperationId}SuccessResponse`
        const errorResponseTypeName = `Axios${upperCamelCaseOperationId}ErrorResponse`
        const requestConfigTypeName = hasCustomParams ? `Axios${upperCamelCaseOperationId}RequestConfig` : "AxiosRequestConfig"
        const requestConfigType = `AxiosRequestConfig${!hasCustomParams ? "" : ` & {${
          hasCustomHeaders ? `\n  headers${isConfigHeadersRequired ? "" : "?"}: ${headersTypeKeyName}` : ""
        }${
          hasCustomPath ? `\n  path${isConfigPathRequired ? "" : "?"}: ${pathTypeKeyName}` : ""
        }${
          hasCustomQuery ? `\n  params${isConfigQueryRequired ? "" : "?"}: ${queryTypeKeyName}` : ""
        }
}`}`

        return [
          description ? `/**\n${description}\n*/` : "",
          hasCustomParams ? `export type ${requestConfigTypeName} = ${requestConfigType}` : null,
          `export type ${successResponseTypeName} = ${successResponseType}`,
          `export type ${errorResponseTypeName} = ${errorResponseType}`,
          `export type ${responseTypeName} = ${successResponseTypeName} | ${errorResponseTypeName}`,
          `export async function ${operationId}(${requestType ? `data: ${requestType}, ` : ""}${`config${isConfigRequired ? "" : "?"}: ${requestConfigTypeName}`}): Promise<${responseTypeName}> {
  _checkSetup()
  const securityParams: AxiosRequestConfig = ${hasSecurity && security && securityKeys.length ? `_getAuth(new Set([${securityKeys.map(e => `"${e}"`).join(", ")}]))` : "{}" }
  const handledResponses = ${JSON.stringify(Object.entries(derefResponses).reduce((acc: {[key: string]: { code?: string[] | null } }, [key, value]: [string, OpenAPIV3_1.ResponseObject]) => {
    const codes = Object.values(value.content!).flatMap(e => {
      const code: OpenAPIV3_1.SchemaObject | undefined = (e.schema! as OpenAPIV3_1.SchemaObject).properties?.code
      return code?.enum
    }).filter(e => e)

    if (!acc[key]) {
      acc[key] = { }
    }

    if (codes.length) {
      acc[key].code = codes
    } else {
      acc[key].code = null
    }

    return acc
  }, {}), null, 2).split("\n").join("\n  ")}
  try {
    const res = await axios!.${method.toLowerCase()}(_getFnUrl("${path}"${hasCustomPath ? `, { path: config${isConfigRequired ? "" : "?"}.path } ` : ""}), ${method === "GET" ? "" : requestType ? "data, " : "null, " }config ? deepmerge(securityParams, config, { isMergeableObject: isPlainObject }) : securityParams)
    _throwOnUnexpectedResponse(handledResponses, res)
    return res as ${successResponseTypeName}
  } catch (e) {
    const { response: res } = e as AxiosError
    if (res) {
      _throwOnUnexpectedResponse(handledResponses, res)
      return res as ${errorResponseTypeName}
    }
    throw e
  }
}`
        ].filter(e => e).join("\n")
      }
    }
    return ""
  }).filter(e => e).join("\n\n")

  const sdk = [
    `/* eslint-disable @typescript-eslint/ban-types */
/* eslint-disable no-trailing-spaces */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable quote-props */
/* eslint-disable @typescript-eslint/member-delimiter-style */
/**
 * This file was automatically generated by sf-ts-sdk-gen.
 * DO NOT MODIFY IT BY HAND. Instead, modify the source
 * openapi definition and regenerate this file.
 */`,
    "import type { AxiosStatic, AxiosInstance, AxiosResponse, AxiosRequestConfig, AxiosError } from \"axios\"",
    !hasSSE ? null : "import type NodeEventSource from \"eventsource\"",
    "import deepmerge from \"deepmerge\"",
    `function _isObject(o: any): boolean {
  return Object.prototype.toString.call(o) === "[object Object]"
}

export function isPlainObject(o: any): boolean {
  if (_isObject(o) === false) {
    return false
  }

  const ctor = o.constructor
  if (ctor === undefined) {
    return true
  }

  const prot = ctor.prototype
  if (_isObject(prot) === false) {
    return false
  }

  if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) {
    return false
  }

  return true
}`,
    "export const SDK_VERSION = \"" + sdkVersion + "\"",
    "export const API_VERSION = \"" + openapiV3_1.info.version + "\"",
    "export let axios: AxiosStatic | AxiosInstance | undefined",
    !hasSSE ? null : "export let ES: typeof EventSource | typeof NodeEventSource | undefined",
    !hasSSE ? null : `export type SSERequestConfig = {
    params?: { [key: string]: any },
    path?: { [key: string]: any }
  }`,
    `export type Env = ${Object.keys(serverUrls).map(e => `"${e}"`).join(" | ")} | string`,
    "export let env: Env | undefined",
    !hasSecurity ? null : `const _auth: { ${Object.keys(securitySchemas).map(e => `"${e}": string | null`)} } = { ${Object.keys(securitySchemas).map(e => `"${e}": null`).join(", ")} }`,
    !hasSSE ? null : `export interface CustomEventSource<T> extends EventSource {
  onmessage: (event: MessageEvent<T>) => void
}`,
    !hasSSE ? null : "type IfEquals<X, Y, A, B> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? A : B",
    !hasSSE ? null : "type WritableKeysOf<T> = { [P in keyof T]: IfEquals<{ [Q in P]: T[P] }, { -readonly [Q in P]: T[P] }, P, never> }[keyof T]",

    !hasSSE ? null : `const _proxy = {
  get(target: any, key: any): any {
    const value = target[key]
    if (typeof value === "function") {
      return (...args: any[]): any => value.apply(target, args)
    }
    return value
  },
  set(target: EventSource, prop: WritableKeysOf<EventSource>, value: any): boolean {
    if (prop === "onmessage") {
      target[prop] = (event: MessageEvent): void => {
        try {
          value({ ...event, data: JSON.parse(event.data) })
        } catch (_) {
          value(event)
        }
      }
    } else {
      target[prop] = value
    }
    return true
  }
}`,
    !hasSecurity ? null : `export function setAuth(securitySchemaName: keyof typeof _auth, value: string | null): void {
  if (typeof _auth[securitySchemaName] === "undefined") {
    throw new Error(\`Invalid security schema name: \${securitySchemaName}\`)
  }
  _auth[securitySchemaName] = value
}`,
    "export type HandledResponses = { [status: string]: { code: string[] | null } }",
    `const _throwOnUnexpectedResponse = (handledResponses: HandledResponses, response: AxiosResponse): void => {
  const handledResponsesForStatus = handledResponses[response.status]
  if (handledResponsesForStatus) {
    const handledResponseCodes = handledResponsesForStatus.code
    if (Array.isArray(handledResponseCodes)) {
      if (!handledResponseCodes.includes(response.data.code)) {
        throw new ResponseError({
          message: \`Unexpected response code: \${response.data.code}\`,
          code: "UNEXPECTED_RESPONSE",
          response
        })
      }
    }
  } else {
    throw new ResponseError({
      message: \`Unexpected response status code: \${response.status}\`,
      code: "UNEXPECTED_RESPONSE",
      response
    })
  }
}`,
    !hasSecurity ? null : `// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _getAuth(keys: Set<string>): { headers: { [key: string]: string }, params: URLSearchParams, withCredentials: boolean } {
  const headers: { [key: string]: string } = {}
  const params = new URLSearchParams()
  ${Object.entries(securitySchemas).map(([key, value]) => {
    value = value as OpenAPIV3_1.SecuritySchemeObject
    if (value.type === "http") {
      if (value.scheme === "bearer") {
        return `if (keys.has("${key}") && _auth["${key}"]) {
      headers.Authorization = \`Bearer \${_auth["${key}"]}\`
    }`
      } else {
        return `if (keys.has("${key}") && _auth["${key}"]) {
    headers.Authorization = \`Basic \${_auth["${key}"]}\`
  }`
      }
    } else if (value.type === "apiKey") {
      if (value.in === "header") {
        return `if (keys.has("${key}") && _auth["${key}"]) {
    headers["${value.name}"] = _auth["${key}"]
  }`
      } else if (value.in === "query") {
        return `if (keys.has("${key}") && _auth["${key}"]) {
    params.set("${value.name}", _auth["${key}"])
  }`
      } else {
        return ""
      }
    } else {
      return ""
    }
  }).filter(e => e).join("\n  ")}
  return { headers, params, withCredentials: true }
}`,

    `export class ResponseError<T> extends Error {
  code: string
  response: T

  constructor({ message, code, response }: { message: string, code: string, response: T }) {
    super(message)
    this.code = code
    this.response = response
  }
}`,
    `export const serverUrls: { [env in Env]: string } = ${JSON.stringify(serverUrls, null, 2)}`,
    `function _getFnUrl(endpoint: string, options?: { path?: { [key: string]: any }, params?: { [key: string]: any } }): string {
  const baseUrl = serverUrls[env!.toLowerCase()]
  if (!baseUrl) {
    throw new Error(\`Invalid env: \${env}\`)
  }

  if (options?.path) {
    Object.entries(options.path).forEach(([key, value]) => {
      endpoint = endpoint.replace(\`{\${key}}\`, String(value))
    })
  }

  endpoint = endpoint.replace(/{.*?}/g, "")

  const url = new URL(baseUrl.replace(/\\/$/, "") + "/" + endpoint.replace(/^\\//, ""))
  if (options?.params) {
    Object.entries(options.params).forEach(([key, value]) => {
      url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : value)
    })
  }

  return url.toString()
}`,
    `export function setup(params: {
  axios: AxiosStatic | AxiosInstance
  env: Env${!hasSSE ? "" : `
  ES: typeof EventSource | typeof NodeEventSource`}
  customServerUrls?: { [env: string]: string }
}): void {
  axios = params.axios
  env = params.env${!hasSSE ? "" : `
  ES = params.ES`}
  if (params.customServerUrls) {
    Object.assign(serverUrls, params.customServerUrls)
  }
  if (!serverUrls[env]) {
    throw new Error(\`Missing server url for env: \${env}\`)
  }
}`,
    `const _checkSetup = (): void => {
  if (!axios) {
    throw new Error("axios is not defined. Please run the sdk.setup() function or set axios instance to the sdk.")
  }
  if (!env) {
    throw new Error("env is not defined. Please run the sdk.setup() function or set env to the sdk.")
  }${!hasSSE ? "" : `
  if (!ES) {
    throw new Error("EventSource is not defined. Please run the sdk.setup() function or set ES to the sdk.")
  }`}
}`,
    functions,
    typesCode
  ].filter(e => e).join("\n\n")

  writeFileSync(join(outputFolder, "src", "index.ts"), sdk)

  const pkgLicense = "MIT"
  const engines = {
    node: ">=10"
  }
  const author = "sf-ts-sdk-gen"

  const buildPackageJson = {
    name: SDK_NAME,
    version: sdkVersion,
    license: pkgLicense,
    main: "./index.js",
    typings: "./index.d.ts",
    engines,
    author,
    module: `./${SDK_NAME}.esm.js`,
    sideEffects: false
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const packageJson: { [key: string]: any } = {
    name: SDK_NAME,
    version: sdkVersion,
    license: pkgLicense,
    main: "dist/index.js",
    typings: "dist/index.d.ts",
    files: [
      "dist",
      "src"
    ],
    engines,
    scripts: {
      build: "tsdx build && npm run build:package",
      lint: "tsdx lint",
      prepare: "tsdx build && npm run build:package",
      size: "size-limit",
      analyze: "size-limit --why",
      "build:package": `echo '${JSON.stringify(buildPackageJson)}' > dist/package.json`
    },
    author,
    module: `dist/${SDK_NAME}.esm.js`,
    sideEffects: false,
    devDependencies: {
      "@size-limit/preset-small-lib": "^8.2.4",
      "@types/fs-extra": "^11.0.1",
      husky: "^8.0.3",
      "openapi-types": "^12.1.0",
      "size-limit": "^8.2.4",
      tsdx: "^0.14.1",
      tslib: "^2.5.0",
      typescript: "^3.9.10",
      axios: "1.3.6"
    },
    dependencies: {
      deepmerge: "4.3.0"
    }
  }

  if (hasSSE) {
    packageJson.dependencies["@types/eventsource"] = "^1.1.11"
  }

  writeFileSync(join(outputFolder, "package.json"), JSON.stringify(packageJson, null, 2))

  const tsconfig = {
    include: ["src", "types"],
    compilerOptions: {
      module: "esnext",
      lib: ["dom", "esnext"],
      importHelpers: true,
      declaration: true,
      sourceMap: true,
      rootDir: "./src",
      strict: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      moduleResolution: "node",
      jsx: "react",
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true
    }
  }

  writeFileSync(join(outputFolder, "tsconfig.json"), JSON.stringify(tsconfig, null, 2))

  const license = `MIT License
  
Copyright (c) ${new Date().getFullYear()} Soluzioni Futura

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

  writeFileSync(join(outputFolder, "LICENSE"), license)

  const gitignore = `*.log
.DS_Store
node_modules
dist`

  writeFileSync(join(outputFolder, ".gitignore"), gitignore)

  const readme = `# ${SDK_NAME}  

This is an autogenerated SDK based on the OpenAPI definition file.
The SDK provides an interface to interact with \`${openapi.info.title}\` in a type-safe and efficient manner.
It uses Axios and EventSource for handling HTTP requests and server-sent events.  

## Installation

\`\`\` bash  
npm i ${sdkName}@github:${repoUrl?.split("github.com/")[1].replace(".git", "")}
\`\`\`

## Configuration

To use the SDK, you'll need to import it into your project and set it up with the necessary configurations.

### Client-side

\`\`\` typescript
import { setup, setAuth } from "${sdkName}"
import axios from "axios"

// Set up SDK with required parameters
setup({
  axios,
  env: "production",
  ES: EventSource,
  customServerUrls: {
    production: "https://api.example.com",
  }
})

// Set authentication (if required)
setAuth("apiKey", "your_api_key")
\`\`\`

### Server-side

\`\`\` typescript
import { setup, setAuth } from "${sdkName}"
import axios from "axios"
import EventSource from "eventsource"
import { wrapper } from "axios-cookiejar-support"
import { CookieJar } from "tough-cookie"

const jar = new CookieJar()
const client = wrapper(axios.create({ jar }))

// Set up SDK with required parameters
setup({
  axios: client,
  env: "production",
  ES: EventSource,
  customServerUrls: {
    production: "https://api.example.com",
  }
})

// Set authentication (if required)
setAuth("apiKey", "your_api_key")
\`\`\`

## Usage

The sdk provides several exports which can be used to
interact with the ${sdkName}. Below, you'll find the signatures of all
exported functions and constants, along with brief descriptions of their purpose.

### Constants

1. \`SDK_VERSION: string\`  
Represents the current version of the SDK.
2. \`API_VERSION: string\`  
Represents the version of the API the SDK is designed to interact with.
3. \`serverUrls: { [env: string]: string }\`  
A dictionary of server URLs for different environments such as 'local', 'staging', and 'production'.  
You can add or override these URLs via the \`setup\` function.

### Functions

1. \`setup(params: { axios: AxiosStatic | AxiosInstance env: string ${hasSSE ? "ES: typeof EventSource | typeof NodeEventSource " : ""}customServerUrls?: { [env: string]: string } }): void\`  
This function is used to initialize the SDK with necessary configurations.
You need to provide an instance of axios, the environment name env${hasSSE ? ", an EventSource instance," : ""}
and optionally, a set of custom server URLs.
2. \`setAuth(securitySchemaName: keyof typeof _auth, value: string | null): void\`
This function is used to set the authentication parameters.
You need to provide the \`securitySchemaName\` and its \`value\`.
If the \`securitySchemaName\` does not exist, it will throw an error.
`
  writeFileSync(join(outputFolder, "README.md"), readme)
}