# Minty

Minty is a cross-platform Electron desktop app: a two-panel terminal manager.
Left sidebar lists saved project folders and their terminal tabs. Right panel
shows the currently selected terminal session.

---

## Stack

| Concern | Tool |
|---|---|
| Runtime / package manager | Bun |
| UI framework | None — plain DOM + vanilla TypeScript |
| Styling | Plain CSS (no Tailwind, no preprocessor) |
| Desktop shell | Electron 29 |
| Terminal emulator | @xterm/xterm 5, @xterm/addon-fit |
| Shell process | node-pty 1 (native addon, main process only) |

---

## File Structure

```
minty/
├── package.json           # scripts, deps
├── tsconfig.json          # target ES2022, moduleResolution: bundler
├── build.ts               # Bun build script — run with `bun build.ts`
└── src/
    ├── main.ts            # Electron main process (Node.js env)
    ├── preload.ts         # Runs in renderer sandbox, exposes window.minty
    └── renderer/
        ├── index.html     # Shell HTML, loads xterm.css + style.css + renderer.js
        ├── style.css      # All app styles
        └── renderer.ts    # All UI logic and terminal session management
```

Build output goes to `build/` (gitignored). Never edit files in `build/`.

---

## Process Boundary

Electron splits code across two processes:

**Main process** (`src/main.ts`) — Node.js environment.
- Owns all node-pty processes.
- Reads/writes `projects.json`.
- Opens native dialogs.
- Communicates with renderer via `ipcMain.handle` and `webContents.send`.

**Renderer process** (`src/renderer/renderer.ts`) — browser (Chromium) environment.
- No direct Node.js access.
- Calls main process via `window.minty.*` (the contextBridge API).
- Manages xterm.js terminals and all DOM.

**Preload script** (`src/preload.ts`) — runs in renderer sandbox with Node.js access.
- Bridges the two processes using `contextBridge.exposeInMainWorld("minty", ...)`.
- Never import renderer-side packages here; never import node-pty here.

---

## window.minty API (contextBridge)

Defined in `src/preload.ts`. Available as `window.minty` in the renderer.

```typescript
window.minty.platform                        // string — "darwin" | "win32" | "linux"

// Persistence
window.minty.loadProjects()                  // Promise<unknown> (renderer normalizes shape)
window.minty.saveProjects(data)              // Promise<void>

// Native dialog
window.minty.openFolderDialog()              // Promise<string | null>  — absolute folder path

// PTY lifecycle (all keyed by terminal id string)
window.minty.spawnPty(id, cwd)              // Promise<void> — spawns shell cd'd to cwd
window.minty.writePty(id, data)             // Promise<void> — send keystrokes to shell
window.minty.resizePty(id, cols, rows)      // Promise<void> — sync pty size to terminal
window.minty.killPty(id)                    // Promise<void> — terminate shell process

// Streaming events
window.minty.onPtyData(id, cb)              // registers data listener, returns disposer fn
window.minty.onPtyExit(id, cb)             // registers one-shot exit listener, returns disposer fn
```

**Project shape:**
```typescript
interface TerminalTab { id: string; name: string }
interface Project {
  id: string
  name: string
  path: string
  terminals: TerminalTab[]
  expanded?: boolean
}
```
`id` is generated in the renderer as `p_<timestamp>_<random>`.
`name` is the last path segment of `path`.

**Saved UI state shape:**
```typescript
interface ProjectsData {
  projects: Project[]
  activeProjectId: string | null
  activeTerminalId: string | null
}
```

---

## IPC Channels (main ↔ renderer)

All renderer→main calls use `ipcRenderer.invoke` (request/response).
All main→renderer pushes use `webContents.send` (fire-and-forget).

| Direction | Channel | Payload |
|---|---|---|
| R→M | `projects:load` | — |
| R→M | `projects:save` | `{ projects, activeProjectId, activeTerminalId }` |
| R→M | `dialog:open-folder` | — |
| R→M | `pty:spawn` | `{ id, cwd }` |
| R→M | `pty:write` | `{ id, data }` |
| R→M | `pty:resize` | `{ id, cols, rows }` |
| R→M | `pty:kill` | `{ id }` |
| M→R | `pty:data:<id>` | raw string chunk |
| M→R | `pty:exit:<id>` | — |

To add a new IPC channel: add `ipcMain.handle(...)` in `src/main.ts` and expose
a corresponding wrapper in `src/preload.ts` inside the `minty` object.

---

## Terminal Session Lifecycle (renderer)

Each `TerminalTab` has a `TerminalSession`:
```typescript
interface TerminalSession {
  terminalId: string
  terminal: Terminal      // xterm.js instance
  fitAddon: FitAddon
  wrapper: HTMLElement    // the .terminal-wrapper div
  spawned: boolean        // whether pty:spawn has been called
  cleanupData: (() => void) | null
  cleanupExit: (() => void) | null
}
```

Key rules:
- `addProject()` only adds a folder entry (`project.terminals` starts empty). No
  terminal is opened or spawned yet.
- `createSession(project, terminalTab)` is called for each existing terminal at
  startup and whenever a new terminal tab is added with the `+` project action.
- Wrappers are hidden with `display: none` (no `.active` class). The active one
  has `display: flex`. This means all terminals stay alive in the DOM — switching
  is instant with no reload or re-render.
- `ensureSpawned(project, terminalTab, session)` is called on first terminal
  selection. It calls `window.minty.spawnPty(terminalId, cwd)` then wires up
  `onPtyData`. The `spawned` flag prevents double-spawning.
- `destroySession(terminalId)` disposes the xterm instance, removes the DOM
  node, and calls `killPty`. Called on terminal removal and project removal.
- After making a wrapper active, `fitAddon.fit()` is called inside
  `requestAnimationFrame` so the DOM has settled. Then `resizePty` syncs the
  pty size.
- A `ResizeObserver` on `#terminals-container` calls `fitAddon.fit()` + `resizePty`
  whenever the container resizes (window resize, sidebar toggle).

---

## State (renderer module-level)

```typescript
let projects: Project[]     // ordered list
let activeProjectId: string | null
let activeTerminalId: string | null
let sidebarVisible: boolean
const sessions: Map<string, TerminalSession>  // keyed by terminal.id
```

`save()` writes `{ projects, activeProjectId, activeTerminalId }` via
`window.minty.saveProjects` on every meaningful mutation (select, add, remove,
expand/collapse; sidebar toggle does not trigger save).

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `⌘/Ctrl+N` | Add project (open folder dialog) |
| `⌘/Ctrl+W` | Remove active terminal (if selected), else remove active project |
| `⌘/Ctrl+B` | Toggle sidebar |
| `⌘/Ctrl+K` | Focus sidebar (arrow-key navigation) |
| `⌘/Ctrl+L` | Focus terminal |
| `⌘/Ctrl+1`…`9` | Jump to project by index (select first terminal if it exists) |
| `↑` / `↓` | Navigate list when sidebar focused |
| `←` / `→` | Collapse / expand focused project row |
| `Enter` | Activate focused sidebar row (project or terminal) |
| Right-click project/terminal | Non-destructive; keeps selection behavior only |

Shortcuts work even when xterm has focus because each terminal has
`attachCustomKeyEventHandler` returning `false` for the relevant keys, letting
them bubble to the `document` keydown listener. `Ctrl+L` is intentionally NOT
intercepted (it's the terminal clear shortcut); only `Cmd+L` is passed through.

---

## Build System

`build.ts` uses `Bun.build()` directly (no webpack, no vite, no esbuild CLI).

```
bun build.ts
```

Three separate build targets:
1. **main** — `target: "node"`, `format: "cjs"`, `external: ["electron", "node-pty"]`
2. **preload** — `target: "node"`, `format: "cjs"`, `external: ["electron"]`
3. **renderer** — `target: "browser"`, `format: "esm"` — xterm is bundled inline

Static files (`index.html`, `style.css`, `xterm.css`) are copied with `$` (Bun shell).

**First-time setup:**
```bash
bun install
bun run rebuild    # rebuilds node-pty native addon against Electron's Node.js
bun run build
electron .
```

`bun run rebuild` runs `electron-rebuild -f -w node-pty`.
This must be re-run whenever `electron` or `node-pty` versions change.

---

## Styling Conventions

- All styles in `src/renderer/style.css`. No CSS modules, no scoping.
- CSS custom properties (variables) declared on `:root` — prefer these over
  raw hex values.
- Key variables: `--bg`, `--bg-sidebar`, `--bg-hover`, `--bg-active`,
  `--border`, `--text`, `--text-dim`, `--text-faint`, `--accent` (#3ecf8e),
  `--sidebar-w` (220px), `--transition` (0.15s ease).
- `-webkit-app-region: drag` is set on `#sidebar-header` (macOS only) for window dragging.
  Keep project list/footer/button regions as `-webkit-app-region: no-drag` so clicks are never swallowed.
- `body.macos` is added in `init()` to apply macOS-specific rules (e.g.
  `padding-top: 28px` on the sidebar for traffic-light clearance).

---

## What NOT to do

- Do not add React, Svelte, Vue, or any component framework.
- Do not add Tailwind, CSS-in-JS, or any CSS pre/post-processor.
- Do not import `node-pty` or any native Node.js module in `preload.ts` or
  `renderer.ts` — they can only run in the main process.
- Do not use `nodeIntegration: true` or remove `contextIsolation`.
- Do not add third-party state management (zustand, redux, etc.).
- Do not call `terminal.dispose()` or remove `.terminal-wrapper` nodes when
  switching projects — only on deletion.
- Do not bundle `electron` or `node-pty` into the main/preload output
  (they are marked `external` for a reason).
