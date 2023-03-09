# sf-ts-sdk-gen

`sf-ts-sdk-gen` is a Node module that generates a TypeScript SDK starting from an OpenAPI definition. It can be used as a CLI or as a Node module.

## Usage

### CLI

To use `sf-ts-sdk-gen` as a CLI, run the following command:

``` bash
npx sf-ts-sdk-gen [input] [output] --sdk-version [version] --sdk-name [name]
```

Replace `[input]` with the path to the OpenAPI definition file or URL, and `[output]` with the path to the output directory for the generated SDK.  

The `[input]` parameter can be either a local file path or a URL. If a URL is specified, sf-ts-sdk-gen will download the OpenAPI definition from the URL.  

The `--sdk-version` flag is optional and can be used to specify the version of the SDK.  
The `--sdk-name` flag is also optional and can be used to specify the name of the SDK.

### Node Module

``` js
const { generateSdk } = require('sf-ts-sdk-gen')
```

Then, call the `generateSdk` function with the following options:

``` js
generateSdk({
  openapi: [openapi definition],
  outputFolder: [output directory],
  sdkName?: [sdk name],
  sdkVersion?: [sdk version]
})
```

Replace `[openapi definition]` with the OpenAPI definition, either as a JavaScript object or as the path to a JSON file. Replace `[output directory]` with the path to the output directory for the generated SDK.

The `sdkName` and `sdkVersion` options are both optional and can be used to specify the name and version of the SDK, respectively.
