#!/usr/bin/env node
const axios = require("axios")
const { generateSdk } = require("../dist")
const argv = require('yargs-parser')(process.argv.slice(2))
const { name, version } = require("../package.json")

void (async () => {
  if (argv.h || argv.help) {
    console.log(`${name} v${version}`)
    console.log(usage)
    process.exit(0)
  }
  
  const usage = `sf-ts-sdk-gen [input] [output] --sdk-version [version] --sdk-name [name]`
  const { _: [input, output], "sdk-version": sdkVersion, "sdk-name": sdkName } = argv
  
  if (!input || !output) {
    console.error(usage)
    process.exit(1)
  }

  console.log(`Parsing ${input} to ${output}`)
  
  let openapi
  if (input.startsWith("http")) {
    console.log(`Downloading api definition`)
    const { data } = await axios.get(input)
    openapi = data
  }

  await generateSdk({ openapi: openapi || input, outputFolder: output, sdkVersion, sdkName })
  console.log(`Generated ${output}`)
})()
  .catch(console.error)