#!/usr/bin/env node
const { generateSdk } = require("../dist")
const [,, ...args] = process.argv
const [input, output, sdkVersion] = args
const { name, version } = require("../package.json")

if (args.includes("--version") || args.includes("-v")) {
  console.log(`${name} v${version}`)
  process.exit(0)
}

if (!input || !output) {
  console.error("Usage: ts-sdk-gen <input> <output> [version]")
  process.exit(1)
}

console.log(`Parsing ${input} to ${output}`)
generateSdk({ openapi: input, outputFolder: output, sdkVersion })
  .then(() => console.log(`Generated ${output}`))
  .catch(console.error)