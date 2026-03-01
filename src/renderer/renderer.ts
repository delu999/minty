import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"

// ── Window API types ──────────────────────────────────────────────────────────

interface TerminalTab {
  id: string
  name: string
}

interface Project {
  id: string
  name: string
  path: string
  terminals: TerminalTab[]
  expanded?: boolean
}

interface LegacyProject {
  id: string
  name: string
  path: string
}

interface ProjectsData {
  projects: Project[]
  activeProjectId: string | null
  activeTerminalId: string | null
}

interface MintyAPI {
  platform: string
  loadProjects(): Promise<unknown>
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
  terminalId: string
  terminal: Terminal
  fitAddon: FitAddon
  wrapper: HTMLElement
  spawned: boolean
  cleanupData: (() => void) | null
  cleanupExit: (() => void) | null
}

// ── State ─────────────────────────────────────────────────────────────────────

let projects: Project[] = []
let activeProjectId: string | null = null
let activeTerminalId: string | null = null
let sidebarVisible = true
const sessions = new Map<string, TerminalSession>()

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $sidebar   = document.getElementById("sidebar")!
const $list      = document.getElementById("project-list")!
const $addBtn    = document.getElementById("add-btn")!
const $container = document.getElementById("terminals-container")!
const $empty     = document.getElementById("empty-state")!

// ── Helpers ───────────────────────────────────────────────────────────────────

function genProjectId(): string {
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function genTerminalId(): string {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function baseName(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/)
  return parts[parts.length - 1] || p
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

function findProject(projectId: string): Project | undefined {
  return projects.find((project) => project.id === projectId)
}

function findProjectByTerminal(terminalId: string): Project | undefined {
  return projects.find((project) => project.terminals.some((terminal) => terminal.id === terminalId))
}

function findTerminal(project: Project, terminalId: string): TerminalTab | undefined {
  return project.terminals.find((terminal) => terminal.id === terminalId)
}

function nextTerminalName(project: Project): string {
  const used = new Set(project.terminals.map((terminal) => terminal.name))
  let index = 1
  while (used.has(`Terminal ${index}`)) index += 1
  return `Terminal ${index}`
}

function normalizeLoadedData(raw: unknown): ProjectsData {
  if (!isRecord(raw)) {
    return { projects: [], activeProjectId: null, activeTerminalId: null }
  }

  const rawProjects = Array.isArray(raw.projects) ? raw.projects : []
  const normalizedProjects: Project[] = []

  for (const item of rawProjects) {
    if (!isRecord(item)) continue
    if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.path !== "string") continue

    let terminals: TerminalTab[] = []
    if (Array.isArray(item.terminals)) {
      terminals = item.terminals
        .filter((terminal): terminal is Record<string, unknown> => isRecord(terminal))
        .filter((terminal) => typeof terminal.id === "string" && typeof terminal.name === "string")
        .map((terminal) => ({ id: terminal.id as string, name: terminal.name as string }))
    }

    normalizedProjects.push({
      id: item.id,
      name: item.name,
      path: item.path,
      terminals,
      expanded: typeof item.expanded === "boolean" ? item.expanded : true,
    })
  }

  // Backward compatibility: old format stored projects without terminals plus activeIndex.
  if (normalizedProjects.length === 0 && Array.isArray(raw.projects)) {
    const legacyProjects = raw.projects as LegacyProject[]
    for (const legacy of legacyProjects) {
      if (
        legacy &&
        typeof legacy.id === "string" &&
        typeof legacy.name === "string" &&
        typeof legacy.path === "string"
      ) {
        normalizedProjects.push({
          id: legacy.id,
          name: legacy.name,
          path: legacy.path,
          terminals: [],
          expanded: true,
        })
      }
    }
  }

  let nextActiveProjectId: string | null = null
  if (typeof raw.activeProjectId === "string" && normalizedProjects.some((project) => project.id === raw.activeProjectId)) {
    nextActiveProjectId = raw.activeProjectId
  } else if (typeof raw.activeIndex === "number") {
    const byIndex = normalizedProjects[raw.activeIndex]
    nextActiveProjectId = byIndex?.id ?? null
  }

  let nextActiveTerminalId: string | null = null
  if (typeof raw.activeTerminalId === "string" && findProjectByTerminalIn(raw.activeTerminalId, normalizedProjects)) {
    nextActiveTerminalId = raw.activeTerminalId
  }

  if (nextActiveTerminalId) {
    const owner = findProjectByTerminalIn(nextActiveTerminalId, normalizedProjects)
    nextActiveProjectId = owner?.id ?? nextActiveProjectId
  }

  if (!nextActiveProjectId && normalizedProjects.length > 0) {
    nextActiveProjectId = normalizedProjects[0].id
  }

  return {
    projects: normalizedProjects,
    activeProjectId: nextActiveProjectId,
    activeTerminalId: nextActiveTerminalId,
  }
}

function findProjectByTerminalIn(terminalId: string, data: Project[]): Project | undefined {
  return data.find((project) => project.terminals.some((terminal) => terminal.id === terminalId))
}

function updateEmptyState(): void {
  const title = $empty.querySelector<HTMLElement>(".empty-title")
  const hint = $empty.querySelector<HTMLElement>(".empty-hint")

  if (activeTerminalId) {
    $empty.classList.add("hidden")
    return
  }

  $empty.classList.remove("hidden")
  if (!title || !hint) return

  if (activeProjectId) {
    title.textContent = "No terminal selected"
    hint.textContent = "Use the + button next to the project name to open a terminal"
  } else {
    title.textContent = "No project selected"
    hint.textContent = "Click Cmd/Ctrl+N to add a project folder"
  }
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

const TERMINAL_FONT_FAMILY = [
  '"MesloLGS NF"',
  '"JetBrainsMono Nerd Font Mono"',
  '"FiraCode Nerd Font Mono"',
  '"Hack Nerd Font Mono"',
  '"CaskaydiaMono Nerd Font Mono"',
  '"Symbols Nerd Font Mono"',
  '"Menlo"',
  '"Monaco"',
  '"Cascadia Mono"',
  '"Courier New"',
  "monospace",
].join(", ")

// ── Session management ────────────────────────────────────────────────────────

function createSession(project: Project, terminalTab: TerminalTab): TerminalSession {
  // Container div for this terminal (hidden by default)
  const wrapper = document.createElement("div")
  wrapper.className = "terminal-wrapper"
  wrapper.dataset.projectId = project.id
  wrapper.dataset.terminalId = terminalTab.id
  $container.appendChild(wrapper)

  const terminal = new Terminal({
    theme: TERMINAL_THEME,
    fontFamily: TERMINAL_FONT_FAMILY,
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
    void window.minty.writePty(terminalTab.id, data)
  })

  const session: TerminalSession = {
    terminalId: terminalTab.id,
    terminal,
    fitAddon,
    wrapper,
    spawned: false,
    cleanupData: null,
    cleanupExit: null,
  }
  sessions.set(terminalTab.id, session)
  return session
}

function getOrCreateSession(project: Project, terminalTab: TerminalTab): TerminalSession {
  return sessions.get(terminalTab.id) ?? createSession(project, terminalTab)
}

async function ensureSpawned(project: Project, terminalTab: TerminalTab, session: TerminalSession): Promise<void> {
  if (session.spawned) return
  session.spawned = true

  await window.minty.spawnPty(terminalTab.id, project.path)

  session.cleanupData = window.minty.onPtyData(terminalTab.id, (data) => {
    session.terminal.write(data)
  })

  session.cleanupExit = window.minty.onPtyExit(terminalTab.id, () => {
    // Shell exited — print a dim notice and allow re-spawn on next focus
    session.terminal.write("\r\n\x1b[2m[session ended — press any key to restart]\x1b[0m\r\n")
    session.spawned = false
    session.cleanupData?.()
    session.cleanupData = null
    session.cleanupExit = null
  })
}

function destroySession(terminalId: string): void {
  const s = sessions.get(terminalId)
  if (!s) return
  s.cleanupData?.()
  s.cleanupExit?.()
  s.terminal.dispose()
  s.wrapper.remove()
  sessions.delete(terminalId)
  void window.minty.killPty(terminalId)
}

// ── Sidebar item rendering ────────────────────────────────────────────────────

function renderSidebar(): void {
  $list.innerHTML = ""

  for (const project of projects) {
    const group = document.createElement("li")
    group.className = "project-group"
    group.dataset.projectId = project.id

    const row = document.createElement("div")
    row.className = "project-row"
    row.role = "treeitem"
    row.tabIndex = 0
    row.title = project.path
    row.dataset.projectId = project.id

    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.className = "project-toggle"
    toggle.textContent = project.expanded ? "▾" : "▸"
    toggle.title = project.expanded ? "Collapse project" : "Expand project"
    toggle.addEventListener("click", (e) => {
      e.stopPropagation()
      project.expanded = !project.expanded
      renderSidebar()
      save()
    })

    const folderIcon = document.createElement("span")
    folderIcon.className = "project-folder-icon"
    folderIcon.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M1.5 4.5a1 1 0 011-1h3l1.2 1.2h6.8a1 1 0 011 1v6.8a1 1 0 01-1 1H2.5a1 1 0 01-1-1V4.5z" stroke="currentColor" stroke-width="1.2" />
      </svg>
    `

    const name = document.createElement("span")
    name.className = "project-name"
    name.textContent = project.name

    const actions = document.createElement("span")
    actions.className = "project-actions"

    const addTerminalBtn = document.createElement("button")
    addTerminalBtn.type = "button"
    addTerminalBtn.className = "project-add-terminal"
    addTerminalBtn.title = "Open new terminal"
    addTerminalBtn.textContent = "+"
    addTerminalBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      void addTerminal(project.id)
    })

    actions.appendChild(addTerminalBtn)
    row.append(toggle, folderIcon, name, actions)

    row.addEventListener("click", () => {
      void selectProject(project.id)
    })

    // Keep right click non-destructive.
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault()
      e.stopPropagation()
      void selectProject(project.id)
    })

    const terminalList = document.createElement("ul")
    terminalList.className = "terminal-list"
    terminalList.setAttribute("role", "group")
    if (!project.expanded) terminalList.classList.add("collapsed")

    if (project.terminals.length === 0) {
      const empty = document.createElement("li")
      empty.className = "terminal-empty"
      empty.textContent = "No terminals yet"
      terminalList.appendChild(empty)
    } else {
      for (const terminalTab of project.terminals) {
        const terminalItem = document.createElement("li")
        terminalItem.className = "terminal-item"
        terminalItem.role = "treeitem"
        terminalItem.tabIndex = 0
        terminalItem.dataset.projectId = project.id
        terminalItem.dataset.terminalId = terminalTab.id
        terminalItem.title = `${project.name} · ${terminalTab.name}`

        const dot = document.createElement("span")
        dot.className = "terminal-dot"
        const label = document.createElement("span")
        label.className = "terminal-name"
        label.textContent = terminalTab.name

        terminalItem.append(dot, label)

        terminalItem.addEventListener("click", () => {
          void selectTerminal(project.id, terminalTab.id)
        })

        // Keep right click non-destructive.
        terminalItem.addEventListener("contextmenu", (e) => {
          e.preventDefault()
          e.stopPropagation()
          void selectTerminal(project.id, terminalTab.id)
        })

        terminalList.appendChild(terminalItem)
      }
    }

    group.append(row, terminalList)
    $list.appendChild(group)
  }

  refreshListUI()
  updateEmptyState()
}

function refreshListUI(): void {
  const projectRows = $list.querySelectorAll<HTMLElement>(".project-row")
  projectRows.forEach((row) => {
    const id = row.dataset.projectId ?? ""
    row.classList.toggle("active", id === activeProjectId && activeTerminalId === null)
    row.classList.toggle("contains-active-terminal", id === activeProjectId && activeTerminalId !== null)
  })

  const terminalItems = $list.querySelectorAll<HTMLElement>(".terminal-item")
  terminalItems.forEach((item) => {
    const terminalId = item.dataset.terminalId ?? ""
    item.classList.toggle("active", terminalId === activeTerminalId)
  })
}

// ── Project selection ─────────────────────────────────────────────────────────

function hideActiveTerminal(): void {
  if (!activeTerminalId) return
  sessions.get(activeTerminalId)?.wrapper.classList.remove("active")
}

async function selectProject(projectId: string): Promise<void> {
  const project = findProject(projectId)
  if (!project) return

  hideActiveTerminal()
  activeProjectId = project.id
  activeTerminalId = null
  refreshListUI()
  updateEmptyState()
  save()
}

async function selectTerminal(projectId: string, terminalId: string): Promise<void> {
  const project = findProject(projectId)
  if (!project) return
  const terminalTab = findTerminal(project, terminalId)
  if (!terminalTab) return

  hideActiveTerminal()
  activeProjectId = project.id
  activeTerminalId = terminalTab.id
  if (!project.expanded) {
    project.expanded = true
    renderSidebar()
  } else {
    refreshListUI()
    updateEmptyState()
  }

  const session = getOrCreateSession(project, terminalTab)
  session.wrapper.classList.add("active")

  await ensureSpawned(project, terminalTab, session)

  // Fit after layout paint
  requestAnimationFrame(() => {
    try {
      session.fitAddon.fit()
      void window.minty.resizePty(terminalTab.id, session.terminal.cols, session.terminal.rows)
    } catch { /* not yet laid out */ }
    session.terminal.focus()
  })

  refreshListUI()
  updateEmptyState()
  save()
}

// ── Add / Remove ──────────────────────────────────────────────────────────────

async function addProject(): Promise<void> {
  const folderPath = await window.minty.openFolderDialog()
  if (!folderPath) return

  const existing = projects.find((project) => project.path === folderPath)
  if (existing) {
    await selectProject(existing.id)
    return
  }

  const project: Project = {
    id: genProjectId(),
    name: baseName(folderPath),
    path: folderPath,
    terminals: [],
    expanded: true,
  }

  projects.push(project)
  activeProjectId = project.id
  activeTerminalId = null

  renderSidebar()
  save()
}

async function addTerminal(projectId: string): Promise<void> {
  const project = findProject(projectId)
  if (!project) return

  const terminalTab: TerminalTab = {
    id: genTerminalId(),
    name: nextTerminalName(project),
  }
  project.terminals.push(terminalTab)
  project.expanded = true
  createSession(project, terminalTab)

  renderSidebar()
  await selectTerminal(project.id, terminalTab.id)
}

async function removeProject(projectId: string): Promise<void> {
  const index = projects.findIndex((project) => project.id === projectId)
  if (index < 0) return

  const [project] = projects.splice(index, 1)
  hideActiveTerminal()
  for (const terminalTab of project.terminals) {
    destroySession(terminalTab.id)
  }

  if (projects.length === 0) {
    activeProjectId = null
    activeTerminalId = null
    renderSidebar()
    save()
    return
  }

  if (activeProjectId === projectId) {
    const next = projects[Math.min(index, projects.length - 1)]
    activeProjectId = next.id
    activeTerminalId = null
  } else if (activeProjectId && !findProject(activeProjectId)) {
    activeProjectId = projects[0].id
    activeTerminalId = null
  }

  renderSidebar()
  save()
}

async function removeTerminal(projectId: string, terminalId: string): Promise<void> {
  const project = findProject(projectId)
  if (!project) return

  const index = project.terminals.findIndex((terminal) => terminal.id === terminalId)
  if (index < 0) return

  const removingActive = activeTerminalId === terminalId
  project.terminals.splice(index, 1)
  destroySession(terminalId)

  if (removingActive) {
    if (project.terminals.length > 0) {
      const nextTerminal = project.terminals[Math.min(index, project.terminals.length - 1)]
      renderSidebar()
      await selectTerminal(project.id, nextTerminal.id)
      return
    }

    activeProjectId = project.id
    activeTerminalId = null
  } else {
    if (activeProjectId === null) activeProjectId = project.id
  }

  renderSidebar()
  save()
}

// ── Persistence ───────────────────────────────────────────────────────────────

function save(): void {
  void window.minty.saveProjects({
    projects,
    activeProjectId,
    activeTerminalId,
  })
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
  if (!activeTerminalId) return
  const session = sessions.get(activeTerminalId)
  if (!session) return
  try {
    session.fitAddon.fit()
    void window.minty.resizePty(activeTerminalId, session.terminal.cols, session.terminal.rows)
  } catch { /* ignore if not ready */ }
}

const resizeObserver = new ResizeObserver(() => refitActive())
resizeObserver.observe($container)

// ── Focus helpers ─────────────────────────────────────────────────────────────

function sidebarItems(): HTMLElement[] {
  return Array.from($list.querySelectorAll<HTMLElement>(".project-row, .terminal-item"))
}

function activateSidebarItem(item: HTMLElement): void {
  if (item.classList.contains("project-row")) {
    const projectId = item.dataset.projectId
    if (projectId) void selectProject(projectId)
    return
  }

  if (item.classList.contains("terminal-item")) {
    const projectId = item.dataset.projectId
    const terminalId = item.dataset.terminalId
    if (projectId && terminalId) void selectTerminal(projectId, terminalId)
  }
}

function focusSidebar(): void {
  if (projects.length === 0) return
  const item =
    (activeTerminalId
      ? $list.querySelector<HTMLElement>(`.terminal-item[data-terminal-id="${activeTerminalId}"]`)
      : null) ??
    (activeProjectId
      ? $list.querySelector<HTMLElement>(`.project-row[data-project-id="${activeProjectId}"]`)
      : null) ??
    sidebarItems()[0]
  item?.focus()
}

function focusTerminal(): void {
  if (!activeTerminalId) return
  sessions.get(activeTerminalId)?.terminal.focus()
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey
  const focused = document.activeElement as HTMLElement | null
  const inSidebar =
    focused?.classList.contains("project-row") ||
    focused?.classList.contains("terminal-item") ||
    false

  if (mod) {
    switch (e.key) {
      case "n": case "N":
        e.preventDefault(); void addProject(); return
      case "w": case "W":
        e.preventDefault()
        if (activeProjectId && activeTerminalId) {
          void removeTerminal(activeProjectId, activeTerminalId)
        } else if (activeProjectId) {
          void removeProject(activeProjectId)
        }
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
      const index = parseInt(e.key, 10) - 1
      const project = projects[index]
      if (!project) return
      if (project.terminals.length > 0) {
        void selectTerminal(project.id, project.terminals[0].id)
      } else {
        void selectProject(project.id)
      }
      return
    }
  }

  // Arrow navigation while sidebar item is focused
  if (inSidebar) {
    const items = sidebarItems()
    const idx = focused ? items.indexOf(focused) : -1

    if (e.key === "ArrowDown" && idx >= 0 && idx < items.length - 1) {
      e.preventDefault()
      const target = items[idx + 1]
      target.focus()
      activateSidebarItem(target)
    } else if (e.key === "ArrowUp" && idx > 0) {
      e.preventDefault()
      const target = items[idx - 1]
      target.focus()
      activateSidebarItem(target)
    } else if (e.key === "ArrowRight" && focused?.classList.contains("project-row")) {
      const projectId = focused.dataset.projectId
      const project = projectId ? findProject(projectId) : undefined
      if (project && !project.expanded) {
        e.preventDefault()
        project.expanded = true
        renderSidebar()
        const row = $list.querySelector<HTMLElement>(`.project-row[data-project-id="${project.id}"]`)
        row?.focus()
        save()
      }
    } else if (e.key === "ArrowLeft" && focused?.classList.contains("project-row")) {
      const projectId = focused.dataset.projectId
      const project = projectId ? findProject(projectId) : undefined
      if (project && project.expanded) {
        e.preventDefault()
        project.expanded = false
        renderSidebar()
        const row = $list.querySelector<HTMLElement>(`.project-row[data-project-id="${project.id}"]`)
        row?.focus()
        save()
      }
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (focused) activateSidebarItem(focused)
    }
  }
})

// ── Button ────────────────────────────────────────────────────────────────────

$addBtn.addEventListener("click", () => void addProject())

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  if (window.minty.platform === "darwin") {
    document.body.classList.add("macos")
  }

  const data = normalizeLoadedData(await window.minty.loadProjects())
  projects = data.projects

  // Render all projects and pre-create terminal wrappers for existing tabs.
  for (const project of projects) {
    for (const terminalTab of project.terminals) {
      createSession(project, terminalTab)
    }
  }

  activeProjectId = data.activeProjectId
  activeTerminalId = data.activeTerminalId

  renderSidebar()

  if (activeTerminalId) {
    const owner = findProjectByTerminal(activeTerminalId)
    if (owner) {
      await selectTerminal(owner.id, activeTerminalId)
      return
    }
    activeTerminalId = null
  }

  if (activeProjectId && findProject(activeProjectId)) {
    await selectProject(activeProjectId)
  } else {
    activeProjectId = null
    updateEmptyState()
  }
}

void init()
