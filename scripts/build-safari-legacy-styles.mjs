import { readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import postcss from "postcss"

const require = createRequire(import.meta.url)
const { plugins } = require("../postcss.config.cjs")
const from = path.resolve("src/assets/styles/theme.css")
const pipeline = postcss(
  Object.entries(plugins).map(([name, options]) => {
    const plugin = require(name.startsWith(".") ? path.resolve(name) : name)
    return plugin(options)
  }),
)
const theme = (await pipeline.process(await readFile(from, "utf8"), { from })).css
const textSmall = await readFile("src/assets/styles/text-small.css", "utf8")
// A tab opened before the upgrade can still run the old WXT content script.
// Its getURL() resolves against the newly installed bundle.
const dir = ".output/safari-mv3/content-scripts"
await writeFile(path.join(dir, "selection.css"), theme)
await writeFile(path.join(dir, "side.css"), theme + "\n" + textSmall)
