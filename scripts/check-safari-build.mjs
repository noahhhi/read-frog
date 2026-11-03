import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(".output/safari-mv3")
const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"))
assert.equal(manifest.manifest_version, 3)
for (const permission of ["identity", "offscreen", "sidePanel"]) {
  assert(!manifest.permissions.includes(permission), `Safari cannot request ${permission}`)
}
assert(!manifest.side_panel)
assert.deepEqual(manifest.background, {
  scripts: ["background.js"],
  type: "module",
  persistent: false,
})
const resources = [
  "content-runtime.js",
  "content-scripts/selection.css",
  "content-scripts/side.css",
  ...manifest.background.scripts,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap((script) => [...(script.js ?? []), ...(script.css ?? [])]),
]
for (const resource of resources) {
  assert(existsSync(path.join(root, resource)), `Missing Safari resource: ${resource}`)
}
console.log(`Safari manifest and ${resources.length} entry resources verified.`)

for (const name of ["selection", "side"]) {
  const css = readFileSync(path.join(root, "content-scripts", name + ".css"), "utf8")
  for (const selector of [".fixed", ".invisible", ".h-8", ".w-8"]) {
    assert(
      css.includes(selector + " {") || css.includes(selector + "{"),
      `Missing ${selector} in ${name}.css`,
    )
  }
}
