import { readFileSync, ensureDirSync, writeFileSync } from "fs-extra"
import { parse } from "@soluzioni-futura/openapi2ts"
import { join } from "path"
import semver from "semver"
import { OpenAPIV3_1 } from "openapi-types"

export type Options = { 
  openapi: OpenAPIV3_1.Document | string
  outputFolder: string
  sdkName?: string,
  sdkVersion?: string
}

export async function generateSdk({
  openapi,
  outputFolder,
  sdkName,
  sdkVersion,
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
  const SDK_NAME = sdkName || `${openapiV3_1.info.title}-sdk`

  ensureDirSync(join(outputFolder, "src"))
  
  // generate types
  const { data: typesCode,  exports: typesSet }  = await parse({
    openapi: openapiV3_1,
    bannerComment: "",
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

  let sdkHasSSE = false
  const functions = Object.entries(openapi.paths!).map(([path, pathItem]) => {
    if (!pathItem) {
      return
    }

    if (
      (pathItem.post && pathItem.post.operationId && !pathItem.get) ||
      (pathItem.get && pathItem.get.operationId && !pathItem.post)
    ) {
      
      const method = pathItem.post ? "POST" : "GET"

      const {
        parameters,
        description,
        operationId,
        requestBody,
        responses,
        security
      } = typeof pathItem.post === "object" ? pathItem.post! : pathItem.get!
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

      const responseType = Object.entries(responses).map(([statusCode, response]) => {
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
        for(let i = 0; i < allowedContentTypes.length; i++) {
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
            sdkHasSSE = true
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
      }).join(" | ")

      const securityKeys = Array.from(new Set((security?.map(e => Object.keys(e)) || [])))

      if (isSSE) {
        const responseTypeName = `${upperCamelCaseOperationId}EventSource`
        const requestConfigTypeName = hasCustomParams ? `${upperCamelCaseOperationId}RequestConfig` : "SSERequestConfig"
        if (hasCustomHeaders) { 
          console.warn("WARNING, STRIPPING CUSTOM HEADERS:", `headers are not supported in ${method} ${path}; SSE endpoints cannot have custom headers`)
        }
        const requestConfigType = `{ ${
          hasCustomPath ? `\n  path${isConfigPathRequired? "" : "?"}: ${pathTypeKeyName}` : "" 
        }${
          hasCustomQuery ? `\n  params${isConfigQueryRequired? "" : "?"}: ${queryTypeKeyName}` : "" 
        }
}`
        return [
          description ? `/**\n${description}\n*/` : "",
          hasCustomParams ? `export type ${requestConfigTypeName} = SSERequestConfig & ${requestConfigType}` : null,
          `export type ${responseTypeName} = ${responseType}`,
          `export function ${operationId}(config${isConfigRequired ? "" : "?"}: ${requestConfigTypeName}): ${responseTypeName} {
  _checkSetup()
  const securityParams = ${security && securityKeys.length ? `_getAuth(new Set([${securityKeys.map(e => `"${e}"`).join(", ")}]))` : "{}" } 
  return new Proxy(new ES!(_getFnUrl("${operationId}", config ? deepmerge(securityParams, config) : securityParams)), _proxy) as ${responseTypeName}
}`           
        ].filter(e => e).join("\n")
      } else {
        const responseTypeName = `Axios${upperCamelCaseOperationId}Response`
        const requestConfigTypeName = hasCustomParams ? `Axios${upperCamelCaseOperationId}RequestConfig` : "AxiosRequestConfig"
        const requestConfigType = `AxiosRequestConfig${!hasCustomParams ? "" : ` & { ${
          hasCustomHeaders ? `\n  headers${isConfigHeadersRequired ? "" : "?"}: ${headersTypeKeyName}` : "" 
        }${
          hasCustomPath ? `\n  path${isConfigPathRequired? "" : "?"}: ${pathTypeKeyName}` : "" 
        }${
          hasCustomQuery ? `\n  params${isConfigQueryRequired? "" : "?"}: ${queryTypeKeyName}` : "" 
        }
}`}`

        return [
          description ? `/**\n${description}\n*/` : "",
          hasCustomParams ? `export type ${requestConfigTypeName} = ${requestConfigType}` : null,
          `export type ${responseTypeName} = ${responseType}`,
          `export async function ${operationId}(${requestType ? `data: ${requestType}, ` : ""}${`config${isConfigRequired ? "" : "?"}: ${requestConfigTypeName}`}): Promise<${responseTypeName}> {
  _checkSetup()
  const securityParams: AxiosRequestConfig = ${security && securityKeys.length ? `_getAuth(new Set([${securityKeys.map(e => `"${e}"`).join(", ")}]))` : "{}" } 
  const handledStatusCodes = [${Object.keys(responses).map(e => e).join(", ")}]
  try {
    const res = await axios!.${method.toLowerCase()}(_getFnUrl("${operationId}"${hasCustomPath ? `, { path: config${isConfigRequired ? "": "?"}.path } `: ""}), ${method === "GET" ? "" : requestType ? "data, " : "undefined, " }config ? deepmerge(securityParams, config) : securityParams)
    _throwOnUnexpectedResponse(handledStatusCodes, res)
    return res as ${responseTypeName}
  } catch (e) {
    const { response: res } = e as AxiosError
    if (res) {
      _throwOnUnexpectedResponse(handledStatusCodes, res)
      return res as ${responseTypeName}
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
/* eslint-disable @typescript-eslint/member-delimiter-style */
/**
 * This file was automatically generated by sf-ts-sdk-gen.
 * DO NOT MODIFY IT BY HAND. Instead, modify the source
 * openapi definition and regenerate this file.
 */`,
    `import type { AxiosStatic, AxiosResponse, AxiosRequestConfig, AxiosError } from "axios"`,
    !sdkHasSSE ? null : "import type NodeEventSource from \"eventsource\"",
    `import deepmerge from "deepmerge"`,
    "export const SDK_VERSION = \"" + sdkVersion + "\"",
    "export const API_VERSION = \"" + openapiV3_1.info.version + "\"",
    "export let axios: AxiosStatic | undefined = undefined",
    !sdkHasSSE ? null : "export let ES: typeof EventSource | typeof NodeEventSource | undefined = undefined",
    !sdkHasSSE ? null : `export type SSERequestConfig = {
    params?: { [key: string]: any },
    path?: { [key: string]: any }
  }`,
    "export let env: string | undefined = undefined",
    `const _auth: { ${Object.keys(securitySchemas).map(e => `"${e}": string | null`)} } = { ${Object.keys(securitySchemas).map(e => `"${e}": null`).join(", ")} }`,
    `export interface CustomEventSource<T> extends EventSource {
  onmessage: (event: MessageEvent<T>) => void
}`,
    !sdkHasSSE ? null : `type IfEquals<X, Y, A, B> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? A : B`,
    !sdkHasSSE ? null : `type WritableKeysOf<T> = { [P in keyof T]: IfEquals<{ [Q in P]: T[P] }, { -readonly [Q in P]: T[P] }, P, never> }[keyof T]`,

    !sdkHasSSE ? null : `const _proxy = {
  set(target: EventSource, prop: WritableKeysOf<EventSource>, value: any): boolean {
    if (prop === "onmessage") {
      target[prop] = (event: MessageEvent) => {
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
    `export function setAuth(securitySchemaName: keyof typeof _auth, value: string | null): void {
  if (typeof _auth[securitySchemaName] === "undefined") {
    throw new Error(\`Invalid security schema name: \${securitySchemaName}\`)
  }
  _auth[securitySchemaName] = value
}`,
    `const _throwOnUnexpectedResponse = (handledStatusCodes: number[], res: AxiosResponse) => {
  if (!handledStatusCodes.includes(res.status)) {
    throw new ExtendedError({
      message: \`Unexpected response status code: \${res.status}\`,
      code: "UNEXPECTED_RESPONSE",
      res
    })
  }
}`,
    `function _getAuth(keys: Set<string>): { headers: { [key: string]: string }, params: URLSearchParams } {
  const headers: { [key: string]: string } = {}
  const params = new URLSearchParams()
  ${Object.entries(securitySchemas).map(([key, value]) => {
    value = value as OpenAPIV3_1.SecuritySchemeObject
    if (value.type === "http") {
      if (value.scheme === "bearer") {
        return `if (keys.has("${key}") && _auth["${key}"]) headers.Authorization = \`Bearer \${_auth["${key}"]}\``
      } else {
        return `if (keys.has("${key}") && _auth["${key}"]) headers.Authorization = \`Basic \${_auth["${key}"]}\``
      }
    } else if (value.type === "apiKey") {
      if (value.in === "header") {
        return `if (keys.has("${key}") && _auth["${key}"]) headers["${value.name}"] = _auth["${key}"]`
      } else if (value.in === "query") {
        return `if (keys.has("${key}") && _auth["${key}"]) params.set("${value.name}", _auth["${key}"])`
      } else {
        return ""
      }
    } else {
      return ""
    }
  }).filter(e => e).join("\n  ")}
  return { headers, params }
}`,

  `export class ExtendedError<T> extends Error {
  code: string
  res: AxiosResponse<T>

  constructor({ message, code, res }: { message: string, code: string, res: AxiosResponse<T> }) {
    super(message)
    this.code = code
    this.res = res
  }
}`,
    `export const serverUrls: { [env: string]: string } = ${JSON.stringify(serverUrls, null, 2)}`,
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

  const url = new URL(baseUrl.replace(/\\/$/, \"\") + "/" + endpoint.replace(/^\\//, \"\"))
  
  if (options?.params) {
    Object.entries(options.params).forEach(([key, value]) => {
      url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : value)
    })
  }
  
  return url.toString()
}`,
    `export function setup(params: { 
  axios: AxiosStatic
  env: string${!sdkHasSSE ? "" : `
  ES: typeof EventSource | typeof NodeEventSource`}
  customServerUrls?: { [env: string]: string }
}) {
  axios = params.axios
  env = params.env${!sdkHasSSE ? "" : `
  ES = params.ES`}
  if (params.customServerUrls) {
    Object.assign(serverUrls, params.customServerUrls)
  }
  if (!serverUrls[env]) {
    throw new Error(\`Missing server url for env: \${env}\`)
  }
}`,
    `const _checkSetup = () => {
  if (!axios) {
    throw new Error("axios is not defined. Please run the sdk.setup() function or set axios instance to the sdk.")
  }
  if (!env) {
    throw new Error("env is not defined. Please run the sdk.setup() function or set env to the sdk.")
  } ${!sdkHasSSE ? "" : `
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
    "node": ">=10"
  }
  const author = "sf-ts-sdk-gen"
  
  const buildPackageJson = {
    "name": SDK_NAME,
    "version": sdkVersion,
    "license": pkgLicense,
    "main": "./index.js",
    "typings": "./index.d.ts",
    engines,
    author,
    "module": `./${SDK_NAME}.esm.js`,
    "sideEffects": false,
  }
  const packageJson: { [key: string]: any } = {
    "name": SDK_NAME,
    "version": sdkVersion,
    "license": pkgLicense,
    "main": "dist/index.js",
    "typings": `dist/index.d.ts`,
    "files": [
      "dist",
      "src"
    ],
    engines,
    "scripts": {
      "build": "tsdx build && npm run build:package",
      "lint": "tsdx lint",
      "prepare": "tsdx build && npm run build:package",
      "size": "size-limit",
      "analyze": "size-limit --why",
      "build:package": `echo '${JSON.stringify(buildPackageJson)}' > dist/package.json`,
    },
    author,
    "module": `dist/${SDK_NAME}.esm.js`,
    "sideEffects": false,
    "devDependencies": {
      "@size-limit/preset-small-lib": "^8.2.4",
      "@types/fs-extra": "^11.0.1",
      "husky": "^8.0.3",
      "openapi-types": "^12.1.0",
      "size-limit": "^8.2.4",
      "tsdx": "^0.14.1",
      "tslib": "^2.5.0",
      "typescript": "^3.9.10",
      "axios": "^1.3.4"
    },
    "dependencies": {
      "deepmerge": "4.3.0"
    }
  }

  if (sdkHasSSE) {
    packageJson.dependencies["@types/eventsource"] = "^1.1.11"
  }

  writeFileSync(join(outputFolder, "package.json"), JSON.stringify(packageJson, null, 2))

  const tsconfig = {
    "include": ["src", "types"],
    "compilerOptions": {
      "module": "esnext",
      "lib": ["dom", "esnext"],
      "importHelpers": true,
      "declaration": true,
      "sourceMap": true,
      "rootDir": "./src",
      "strict": true,
      "noImplicitReturns": true,
      "noFallthroughCasesInSwitch": true,
      "noUnusedLocals": false,
      "noUnusedParameters": false,
      "moduleResolution": "node",
      "jsx": "react",
      "esModuleInterop": true,
      "skipLibCheck": true,
      "forceConsistentCasingInFileNames": true,
      "noEmit": true,
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
}