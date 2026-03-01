import { $ } from "bun"
import fs from "fs"
import path from "path"

fs.mkdirSync("build/renderer", { recursive: true })

async function brandElectronMacDevBundle(): Promise<void> {
  if (process.platform !== "darwin") return

  const iconSource = path.resolve("logo_minty.png")
  const electronContents = path.join("node_modules", "electron", "dist", "Electron.app", "Contents")
  const infoPlist = path.join(electronContents, "Info.plist")
  const electronIcon = path.join(electronContents, "Resources", "electron.icns")

  if (!fs.existsSync(iconSource) || !fs.existsSync(infoPlist) || !fs.existsSync(electronIcon)) {
    console.warn("⚠  Skipping macOS Electron dev branding (required files not found)")
    return
  }

  const iconBuildDir = path.join("build", "minty-icons")
  const icnsOut = path.join("build", "minty.icns")
  const tiffOut = path.join(iconBuildDir, "minty.tiff")
  fs.rmSync(iconBuildDir, { recursive: true, force: true })
  fs.mkdirSync(iconBuildDir, { recursive: true })

  const iconSizes = [16, 32, 48, 128, 256, 512, 1024]
  const tiffInputs: string[] = []
  for (const size of iconSizes) {
    const out = path.join(iconBuildDir, `icon_${size}.tiff`)
    await $`sips -z ${size} ${size} ${iconSource} --out ${out}`.quiet()
    tiffInputs.push(out)
  }

  await $`tiffutil -cat ${tiffInputs} -out ${tiffOut}`.quiet()
  await $`tiff2icns ${tiffOut} ${icnsOut}`.quiet()
  await $`cp ${icnsOut} ${electronIcon}`
  await $`plutil -replace CFBundleDisplayName -string Minty ${infoPlist}`
  await $`plutil -replace CFBundleName -string Minty ${infoPlist}`

  console.log("✓ Branded local Electron.app for macOS dev")
}

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
await $`cp logo_minty.png build/logo_minty.png`

const xtermCss = path.join("node_modules", "@xterm", "xterm", "css", "xterm.css")
if (fs.existsSync(xtermCss)) {
  await $`cp ${xtermCss} build/renderer/xterm.css`
} else {
  console.warn("⚠  xterm.css not found — run `bun install` first")
}

await brandElectronMacDevBundle()

console.log("✓ Build complete")
