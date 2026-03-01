import { $ } from "bun"
import fs from "fs"
import path from "path"

fs.mkdirSync("build/renderer", { recursive: true })

// ── Main process ────────────────────────────────────────────────────────────
console.log("› Building main process…")
const mainResult = await Bun.build({
  entrypoints: ["./src/main.ts"],
  outdir: "./build",
  target: "node",
  format: "cjs",
  external: ["electron", "node-pty"],
  naming: "[name].js",
  minify: false,
})
if (!mainResult.success) {
  for (const log of mainResult.logs) console.error(log)
  process.exit(1)
}

// ── Preload script ───────────────────────────────────────────────────────────
console.log("› Building preload script…")
const preloadResult = await Bun.build({
  entrypoints: ["./src/preload.ts"],
  outdir: "./build",
  target: "node",
  format: "cjs",
  external: ["electron"],
  naming: "[name].js",
  minify: false,
})
if (!preloadResult.success) {
  for (const log of preloadResult.logs) console.error(log)
  process.exit(1)
}

// ── Renderer bundle ──────────────────────────────────────────────────────────
console.log("› Building renderer…")
const rendererResult = await Bun.build({
  entrypoints: ["./src/renderer/renderer.ts"],
  outdir: "./build/renderer",
  target: "browser",
  format: "esm",
  naming: "[name].js",
  minify: false,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
})
if (!rendererResult.success) {
  for (const log of rendererResult.logs) console.error(log)
  process.exit(1)
}

// ── Static assets ────────────────────────────────────────────────────────────
console.log("› Copying static assets…")
await $`cp src/renderer/index.html build/renderer/index.html`
await $`cp src/renderer/style.css build/renderer/style.css`

const xtermCss = path.join("node_modules", "@xterm", "xterm", "css", "xterm.css")
if (fs.existsSync(xtermCss)) {
  await $`cp ${xtermCss} build/renderer/xterm.css`
} else {
  console.warn("⚠  xterm.css not found — run `bun install` first")
}

console.log("✓ Build complete")
