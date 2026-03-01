import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"

// ── Window API types ──────────────────────────────────────────────────────────

interface Project {
  id: string
  name: string
  path: string
}

interface ProjectsData {
  projects: Project[]
  activeIndex: number
}

interface MintyAPI {
  platform: string
  loadProjects(): Promise<ProjectsData>
  saveProjects(data: ProjectsData): Promise<void>
  openFolderDialog(): Promise<string | null>
  spawnPty(id: string, cwd: string): Promise<void>
  writePty(id: string, data: string): Promise<void>
  resizePty(id: string, cols: number, rows: number): Promise<void>
  killPty(id: string): Promise<void>
  onPtyData(id: string, cb: (data: string) => void): () => void
  onPtyExit(id: string, cb: () => void): () => void
}

declare global {
  interface Window {
    minty: MintyAPI
  }
}

// ── Terminal session ──────────────────────────────────────────────────────────

interface TerminalSession {
  terminal: Terminal
  fitAddon: FitAddon
  wrapper: HTMLElement
  spawned: boolean
  cleanupData: (() => void) | null
  cleanupExit: (() => void) | null
}

// ── State ─────────────────────────────────────────────────────────────────────

let projects: Project[] = []
let activeIndex = -1
let sidebarVisible = true
const sessions = new Map<string, TerminalSession>()

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $sidebar   = document.getElementById("sidebar")!
const $list      = document.getElementById("project-list")!
const $addBtn    = document.getElementById("add-btn")!
const $container = document.getElementById("terminals-container")!
const $empty     = document.getElementById("empty-state")!

// ── Helpers ───────────────────────────────────────────────────────────────────

function genId(): string {
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function baseName(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/)
  return parts[parts.length - 1] || p
}

// ── Terminal theming ──────────────────────────────────────────────────────────

const TERMINAL_THEME = {
  background:       "#0f0f0f",
  foreground:       "#c0caf5",
  black:            "#15161e",
  red:              "#f7768e",
  green:            "#9ece6a",
  yellow:           "#e0af68",
  blue:             "#7aa2f7",
  magenta:          "#bb9af7",
  cyan:             "#7dcfff",
  white:            "#a9b1d6",
  brightBlack:      "#414868",
  brightRed:        "#f7768e",
  brightGreen:      "#9ece6a",
  brightYellow:     "#e0af68",
  brightBlue:       "#7aa2f7",
  brightMagenta:    "#bb9af7",
  brightCyan:       "#7dcfff",
  brightWhite:      "#c0caf5",
  cursor:           "#c0caf5",
  cursorAccent:     "#0f0f0f",
  selectionBackground: "rgba(122, 162, 247, 0.25)",
} as const

// ── Session management ────────────────────────────────────────────────────────

function createSession(project: Project): TerminalSession {
  // Container div for this terminal (hidden by default)
  const wrapper = document.createElement("div")
  wrapper.className = "terminal-wrapper"
  wrapper.dataset.projectId = project.id
  $container.appendChild(wrapper)

  const terminal = new Terminal({
    theme: TERMINAL_THEME,
    fontFamily: '"Menlo", "Monaco", "Cascadia Mono", "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: "block",
    scrollback: 10000,
    convertEol: false,
    allowProposedApi: false,
  })

  const fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(wrapper)

  // Pass our app-level shortcuts through xterm without consuming them
  terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
    if (e.type !== "keydown") return true
    const mod = e.metaKey || e.ctrlKey
    if (!mod) return true
    const k = e.key
    // Let these bubble to the document so our handler catches them
    if (k === "k" || k === "K") return false
    if (k === "n" || k === "N") return false
    if (k === "w" || k === "W") return false
    if (k === "b" || k === "B") return false
    if (e.metaKey && (k === "l" || k === "L")) return false  // Cmd+L only — Ctrl+L stays for clear
    if (k >= "1" && k <= "9") return false
    return true
  })

  // Forward keyboard input to pty
  terminal.onData((data) => {
    void window.minty.writePty(project.id, data)
  })

  const session: TerminalSession = {
    terminal,
    fitAddon,
    wrapper,
    spawned: false,
    cleanupData: null,
    cleanupExit: null,
  }
  sessions.set(project.id, session)
  return session
}

async function ensureSpawned(project: Project, session: TerminalSession): Promise<void> {
  if (session.spawned) return
  session.spawned = true

  await window.minty.spawnPty(project.id, project.path)

  session.cleanupData = window.minty.onPtyData(project.id, (data) => {
    session.terminal.write(data)
  })

  session.cleanupExit = window.minty.onPtyExit(project.id, () => {
    // Shell exited — print a dim notice and allow re-spawn on next focus
    session.terminal.write("\r\n\x1b[2m[session ended — press any key to restart]\x1b[0m\r\n")
    session.spawned = false
    session.cleanupData?.()
    session.cleanupData = null
  })
}

function destroySession(project: Project): void {
  const s = sessions.get(project.id)
  if (!s) return
  s.cleanupData?.()
  s.cleanupExit?.()
  s.terminal.dispose()
  s.wrapper.remove()
  sessions.delete(project.id)
  void window.minty.killPty(project.id)
}

// ── Sidebar item rendering ────────────────────────────────────────────────────

function renderItem(project: Project): HTMLLIElement {
  const li = document.createElement("li")
  li.className = "project-item"
  li.role = "option"
  li.tabIndex = 0
  li.title = project.path
  li.dataset.projectId = project.id

  const dot  = document.createElement("span"); dot.className  = "project-dot"
  const name = document.createElement("span"); name.className = "project-name"
  name.textContent = project.name

  li.appendChild(dot)
  li.appendChild(name)

  li.addEventListener("click", () => {
    const idx = projects.findIndex((p) => p.id === project.id)
    if (idx >= 0) void selectProject(idx)
  })

  li.addEventListener("contextmenu", (e) => {
    e.preventDefault()
    const idx = projects.findIndex((p) => p.id === project.id)
    if (idx >= 0) void removeProject(idx)
  })

  return li
}

function refreshListUI(): void {
  const items = $list.querySelectorAll<HTMLElement>(".project-item")
  items.forEach((el, i) => el.classList.toggle("active", i === activeIndex))
}

// ── Project selection ─────────────────────────────────────────────────────────

async function selectProject(index: number): Promise<void> {
  if (index < 0 || index >= projects.length) return

  // Deactivate previous terminal
  if (activeIndex >= 0 && activeIndex < projects.length) {
    sessions.get(projects[activeIndex].id)?.wrapper.classList.remove("active")
  }

  activeIndex = index
  const project = projects[index]
  const session = sessions.get(project.id)!

  // Show this terminal
  session.wrapper.classList.add("active")
  $empty.classList.add("hidden")

  // Lazy-spawn pty on first selection
  await ensureSpawned(project, session)

  // Fit after layout paint
  requestAnimationFrame(() => {
    try {
      session.fitAddon.fit()
      void window.minty.resizePty(project.id, session.terminal.cols, session.terminal.rows)
    } catch { /* not yet laid out */ }
    session.terminal.focus()
  })

  refreshListUI()
  save()
}

// ── Add / Remove ──────────────────────────────────────────────────────────────

async function addProject(): Promise<void> {
  const folderPath = await window.minty.openFolderDialog()
  if (!folderPath) return

  const project: Project = {
    id: genId(),
    name: baseName(folderPath),
    path: folderPath,
  }

  projects.push(project)
  $list.appendChild(renderItem(project))
  createSession(project)

  await selectProject(projects.length - 1)
}

async function removeProject(index: number): Promise<void> {
  if (index < 0 || index >= projects.length) return

  const [project] = projects.splice(index, 1)
  $list.children[index]?.remove()
  destroySession(project)

  if (projects.length === 0) {
    activeIndex = -1
    $empty.classList.remove("hidden")
    save()
    return
  }

  const nextIdx = Math.min(index, projects.length - 1)
  if (activeIndex === index) {
    await selectProject(nextIdx)
  } else {
    if (activeIndex > index) activeIndex--
    refreshListUI()
    save()
  }
}

// ── Persistence ───────────────────────────────────────────────────────────────

function save(): void {
  void window.minty.saveProjects({ projects, activeIndex })
}

// ── Sidebar visibility ────────────────────────────────────────────────────────

function toggleSidebar(): void {
  sidebarVisible = !sidebarVisible
  $sidebar.classList.toggle("collapsed", !sidebarVisible)
  // Refit after the CSS transition finishes
  setTimeout(() => refitActive(), 180)
}

// ── Resize handling ───────────────────────────────────────────────────────────

function refitActive(): void {
  if (activeIndex < 0 || activeIndex >= projects.length) return
  const project = projects[activeIndex]
  const session = sessions.get(project.id)
  if (!session) return
  try {
    session.fitAddon.fit()
    void window.minty.resizePty(project.id, session.terminal.cols, session.terminal.rows)
  } catch { /* ignore if not ready */ }
}

const resizeObserver = new ResizeObserver(() => refitActive())
resizeObserver.observe($container)

// ── Focus helpers ─────────────────────────────────────────────────────────────

function focusSidebar(): void {
  if (projects.length === 0) return
  const targetIdx = activeIndex >= 0 ? activeIndex : 0
  const item = $list.children[targetIdx] as HTMLElement | undefined
  item?.focus()
}

function focusTerminal(): void {
  if (activeIndex < 0) return
  sessions.get(projects[activeIndex].id)?.terminal.focus()
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey
  const inSidebar = (document.activeElement as HTMLElement | null)?.classList.contains("project-item")

  if (mod) {
    switch (e.key) {
      case "n": case "N":
        e.preventDefault(); void addProject(); return
      case "w": case "W":
        e.preventDefault()
        if (activeIndex >= 0) void removeProject(activeIndex)
        return
      case "b": case "B":
        e.preventDefault(); toggleSidebar(); return
      case "k": case "K":
        e.preventDefault(); focusSidebar(); return
      case "l": case "L":
        e.preventDefault(); focusTerminal(); return
    }
    if (e.key >= "1" && e.key <= "9") {
      e.preventDefault()
      void selectProject(parseInt(e.key) - 1)
      return
    }
  }

  // Arrow navigation while sidebar item is focused
  if (inSidebar) {
    const id = (document.activeElement as HTMLElement).dataset.projectId ?? ""
    const idx = projects.findIndex((p) => p.id === id)

    if (e.key === "ArrowDown" && idx < projects.length - 1) {
      e.preventDefault()
      ;($list.children[idx + 1] as HTMLElement)?.focus()
      void selectProject(idx + 1)
    } else if (e.key === "ArrowUp" && idx > 0) {
      e.preventDefault()
      ;($list.children[idx - 1] as HTMLElement)?.focus()
      void selectProject(idx - 1)
    } else if (e.key === "Enter") {
      e.preventDefault()
      focusTerminal()
    }
  }
})

// ── Button ────────────────────────────────────────────────────────────────────

$addBtn.addEventListener("click", () => void addProject())

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  if (window.minty.platform === "darwin") {
    document.body.classList.add("macos")
    // Update the hint shortcut symbol for non-macOS later if needed
  }

  const data = await window.minty.loadProjects()
  projects = data.projects

  // Render all project items and pre-create terminal sessions
  for (const project of projects) {
    $list.appendChild(renderItem(project))
    createSession(project)
  }

  // Restore last active project
  if (projects.length > 0) {
    const idx =
      data.activeIndex >= 0 && data.activeIndex < projects.length
        ? data.activeIndex
        : 0
    await selectProject(idx)
  }
}

void init()
