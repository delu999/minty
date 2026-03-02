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
  path: string | null
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
  rootTerminals: TerminalTab[]
  activeProjectId: string | null
  activeTerminalId: string | null
}

interface MintyAPI {
  platform: string
  loadProjects(): Promise<unknown>
  saveProjects(data: ProjectsData): Promise<void>
  openFolderDialog(): Promise<string | null>
  spawnPty(id: string, cwd?: string | null): Promise<void>
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

type DragPayload =
  | { type: "project"; projectId: string }
  | { type: "terminal"; terminalId: string; sourceProjectId: string | null }

// ── State ─────────────────────────────────────────────────────────────────────

let projects: Project[] = []
let rootTerminals: TerminalTab[] = []
let activeProjectId: string | null = null
let activeTerminalId: string | null = null
let sidebarVisible = true
let dragPayload: DragPayload | null = null
const sessions = new Map<string, TerminalSession>()

// ── DOM refs ──────────────────────────────────────────────────────────────────

const $sidebar = document.getElementById("sidebar")!
const $list = document.getElementById("project-list")!
const $addBtn = document.getElementById("add-btn")!
const $newFolderBtn = document.getElementById("new-folder-btn")!
const $newTerminalBtn = document.getElementById("new-terminal-btn")!
const $container = document.getElementById("terminals-container")!
const $empty = document.getElementById("empty-state")!

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

function parseProjectId(raw: string | undefined): string | null {
  if (!raw || raw.trim().length === 0) return null
  return raw
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
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

function findTerminalLocation(
  terminalId: string,
): { ownerProjectId: string | null; index: number; terminal: TerminalTab } | null {
  const rootIndex = rootTerminals.findIndex((terminal) => terminal.id === terminalId)
  if (rootIndex >= 0) {
    return {
      ownerProjectId: null,
      index: rootIndex,
      terminal: rootTerminals[rootIndex],
    }
  }

  for (const project of projects) {
    const index = project.terminals.findIndex((terminal) => terminal.id === terminalId)
    if (index >= 0) {
      return {
        ownerProjectId: project.id,
        index,
        terminal: project.terminals[index],
      }
    }
  }

  return null
}

function findTerminalById(terminalId: string): TerminalTab | undefined {
  return findTerminalLocation(terminalId)?.terminal
}

function getTerminalOwnerProjectId(terminalId: string): string | null | undefined {
  return findTerminalLocation(terminalId)?.ownerProjectId
}

function getTerminalList(ownerProjectId: string | null): TerminalTab[] | null {
  if (ownerProjectId === null) return rootTerminals
  return findProject(ownerProjectId)?.terminals ?? null
}

function terminalExistsInData(terminalId: string, data: Project[], root: TerminalTab[]): boolean {
  if (root.some((terminal) => terminal.id === terminalId)) return true
  return data.some((project) => project.terminals.some((terminal) => terminal.id === terminalId))
}

function findProjectByTerminalIn(terminalId: string, data: Project[]): Project | undefined {
  return data.find((project) => project.terminals.some((terminal) => terminal.id === terminalId))
}

function nextTerminalName(usedList: TerminalTab[]): string {
  const used = new Set(usedList.map((terminal) => terminal.name))
  let index = 1
  while (used.has(`Terminal ${index}`)) index += 1
  return `Terminal ${index}`
}

function nextEmptyFolderName(): string {
  const used = new Set(projects.map((project) => project.name))
  let index = 1
  while (used.has(`Folder ${index}`)) index += 1
  return `Folder ${index}`
}

function cwdForProject(projectId: string | null): string | null {
  if (!projectId) return null
  return findProject(projectId)?.path ?? null
}

function isBeforeMidpoint(element: HTMLElement, clientY: number): boolean {
  const rect = element.getBoundingClientRect()
  return clientY < rect.top + rect.height / 2
}

function clearDragIndicators(): void {
  for (const element of $list.querySelectorAll<HTMLElement>(
    ".drag-over-before, .drag-over-after, .drag-over-inside, .drag-over-root",
  )) {
    element.classList.remove("drag-over-before", "drag-over-after", "drag-over-inside", "drag-over-root")
  }
}

function setDragPayload(payload: DragPayload, event: DragEvent): void {
  dragPayload = payload
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = "move"
  event.dataTransfer.setData("text/plain", JSON.stringify(payload))
}

function clearDragState(): void {
  dragPayload = null
  clearDragIndicators()
}

function normalizeLoadedData(raw: unknown): ProjectsData {
  if (!isRecord(raw)) {
    return {
      projects: [],
      rootTerminals: [],
      activeProjectId: null,
      activeTerminalId: null,
    }
  }

  const rawProjects = Array.isArray(raw.projects) ? raw.projects : []
  const normalizedProjects: Project[] = []

  for (const item of rawProjects) {
    if (!isRecord(item)) continue
    if (typeof item.id !== "string" || typeof item.name !== "string") continue

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
      path: typeof item.path === "string" ? item.path : null,
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

  let normalizedRootTerminals: TerminalTab[] = []
  if (Array.isArray(raw.rootTerminals)) {
    normalizedRootTerminals = raw.rootTerminals
      .filter((terminal): terminal is Record<string, unknown> => isRecord(terminal))
      .filter((terminal) => typeof terminal.id === "string" && typeof terminal.name === "string")
      .map((terminal) => ({ id: terminal.id as string, name: terminal.name as string }))
  }

  let nextActiveProjectId: string | null = null
  if (typeof raw.activeProjectId === "string" && normalizedProjects.some((project) => project.id === raw.activeProjectId)) {
    nextActiveProjectId = raw.activeProjectId
  } else if (typeof raw.activeIndex === "number") {
    const byIndex = normalizedProjects[raw.activeIndex]
    nextActiveProjectId = byIndex?.id ?? null
  }

  let nextActiveTerminalId: string | null = null
  if (
    typeof raw.activeTerminalId === "string" &&
    terminalExistsInData(raw.activeTerminalId, normalizedProjects, normalizedRootTerminals)
  ) {
    nextActiveTerminalId = raw.activeTerminalId
  }

  if (nextActiveTerminalId) {
    const owner = findProjectByTerminalIn(nextActiveTerminalId, normalizedProjects)
    nextActiveProjectId = owner?.id ?? null
  }

  if (!nextActiveProjectId && !nextActiveTerminalId && normalizedProjects.length > 0) {
    nextActiveProjectId = normalizedProjects[0].id
  }

  return {
    projects: normalizedProjects,
    rootTerminals: normalizedRootTerminals,
    activeProjectId: nextActiveProjectId,
    activeTerminalId: nextActiveTerminalId,
  }
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
    hint.textContent = "Use the + button next to the folder name to open a terminal"
  } else if (projects.length === 0 && rootTerminals.length === 0) {
    title.textContent = "No terminal selected"
    hint.textContent = "Use New Terminal, New Empty Folder, or Add Project"
  } else {
    title.textContent = "No terminal selected"
    hint.textContent = "Select a terminal from the sidebar"
  }
}

// ── Terminal theming ──────────────────────────────────────────────────────────

const TERMINAL_THEME = {
  background: "#0f0f0f",
  foreground: "#c0caf5",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#c0caf5",
  cursor: "#c0caf5",
  cursorAccent: "#0f0f0f",
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

function createSession(terminalTab: TerminalTab): TerminalSession {
  const wrapper = document.createElement("div")
  wrapper.className = "terminal-wrapper"
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
    if (k === "k" || k === "K") return false
    if (k === "n" || k === "N") return false
    if (k === "w" || k === "W") return false
    if (k === "b" || k === "B") return false
    if (e.metaKey && (k === "l" || k === "L")) return false
    if (k >= "1" && k <= "9") return false
    return true
  })

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

function getOrCreateSession(terminalTab: TerminalTab): TerminalSession {
  return sessions.get(terminalTab.id) ?? createSession(terminalTab)
}

async function ensureSpawned(terminalId: string, session: TerminalSession): Promise<void> {
  if (session.spawned) return
  session.spawned = true

  const ownerProjectId = getTerminalOwnerProjectId(terminalId)
  const cwd = cwdForProject(ownerProjectId ?? null)

  await window.minty.spawnPty(terminalId, cwd)

  session.cleanupData = window.minty.onPtyData(terminalId, (data) => {
    session.terminal.write(data)
  })

  session.cleanupExit = window.minty.onPtyExit(terminalId, () => {
    session.terminal.write("\r\n\x1b[2m[session ended — press any key to restart]\x1b[0m\r\n")
    session.spawned = false
    session.cleanupData?.()
    session.cleanupData = null
    session.cleanupExit = null
  })
}

function destroySession(terminalId: string): void {
  const session = sessions.get(terminalId)
  if (!session) return
  session.cleanupData?.()
  session.cleanupExit?.()
  session.terminal.dispose()
  session.wrapper.remove()
  sessions.delete(terminalId)
  void window.minty.killPty(terminalId)
}

// ── Sidebar item rendering ────────────────────────────────────────────────────

function makeTerminalItem(ownerProjectId: string | null, terminalTab: TerminalTab, topLevel: boolean): HTMLLIElement {
  const terminalItem = document.createElement("li")
  terminalItem.className = "terminal-item"
  if (topLevel) terminalItem.classList.add("terminal-item-top-level")
  terminalItem.role = "treeitem"
  terminalItem.tabIndex = 0
  terminalItem.dataset.projectId = ownerProjectId ?? ""
  terminalItem.dataset.terminalId = terminalTab.id

  const ownerName = ownerProjectId ? (findProject(ownerProjectId)?.name ?? "Folder") : "Standalone"
  terminalItem.title = `${ownerName} · ${terminalTab.name}`

  const dot = document.createElement("span")
  dot.className = "terminal-dot"
  const label = document.createElement("span")
  label.className = "terminal-name"
  label.textContent = terminalTab.name

  terminalItem.append(dot, label)

  terminalItem.addEventListener("click", () => {
    void selectTerminal(ownerProjectId, terminalTab.id)
  })

  terminalItem.addEventListener("contextmenu", (event) => {
    event.preventDefault()
    event.stopPropagation()
    void selectTerminal(ownerProjectId, terminalTab.id)
  })

  terminalItem.addEventListener("dblclick", (event) => {
    event.preventDefault()
    event.stopPropagation()
    void renameTerminal(terminalTab.id)
  })

  terminalItem.draggable = true
  terminalItem.addEventListener("dragstart", (event) => {
    setDragPayload(
      {
        type: "terminal",
        terminalId: terminalTab.id,
        sourceProjectId: ownerProjectId,
      },
      event,
    )
  })

  terminalItem.addEventListener("dragend", () => {
    clearDragState()
  })

  terminalItem.addEventListener("dragover", (event) => {
    if (!dragPayload || dragPayload.type !== "terminal") return
    event.preventDefault()
    clearDragIndicators()
    if (isBeforeMidpoint(terminalItem, event.clientY)) {
      terminalItem.classList.add("drag-over-before")
    } else {
      terminalItem.classList.add("drag-over-after")
    }
  })

  terminalItem.addEventListener("dragleave", () => {
    terminalItem.classList.remove("drag-over-before", "drag-over-after")
  })

  terminalItem.addEventListener("drop", (event) => {
    if (!dragPayload || dragPayload.type !== "terminal") return
    event.preventDefault()

    const targetLocation = findTerminalLocation(terminalTab.id)
    if (!targetLocation) {
      clearDragState()
      return
    }

    const before = isBeforeMidpoint(terminalItem, event.clientY)
    const targetIndex = before ? targetLocation.index : targetLocation.index + 1
    moveTerminal(dragPayload.terminalId, targetLocation.ownerProjectId, targetIndex)
    clearDragState()
  })

  return terminalItem
}

function addProjectRowDropHandlers(row: HTMLElement, project: Project): void {
  row.draggable = true

  row.addEventListener("dragstart", (event) => {
    setDragPayload({ type: "project", projectId: project.id }, event)
  })

  row.addEventListener("dragend", () => {
    clearDragState()
  })

  row.addEventListener("dragover", (event) => {
    if (!dragPayload) return

    if (dragPayload.type === "project") {
      event.preventDefault()
      clearDragIndicators()
      if (isBeforeMidpoint(row, event.clientY)) {
        row.classList.add("drag-over-before")
      } else {
        row.classList.add("drag-over-after")
      }
      return
    }

    if (dragPayload.type === "terminal") {
      event.preventDefault()
      clearDragIndicators()
      row.classList.add("drag-over-inside")
    }
  })

  row.addEventListener("dragleave", () => {
    row.classList.remove("drag-over-before", "drag-over-after", "drag-over-inside")
  })

  row.addEventListener("drop", (event) => {
    if (!dragPayload) return
    event.preventDefault()

    if (dragPayload.type === "project") {
      const before = isBeforeMidpoint(row, event.clientY)
      reorderProject(dragPayload.projectId, project.id, !before)
      clearDragState()
      return
    }

    if (dragPayload.type === "terminal") {
      moveTerminal(dragPayload.terminalId, project.id, null)
      clearDragState()
    }
  })
}

function renderSidebar(): void {
  $list.innerHTML = ""

  const rootGroup = document.createElement("li")
  rootGroup.className = "standalone-group"

  const rootTitle = document.createElement("div")
  rootTitle.className = "standalone-title"
  rootTitle.textContent = "Standalone Terminals"

  const rootList = document.createElement("ul")
  rootList.className = "terminal-root-list"

  rootList.addEventListener("dragover", (event) => {
    if (!dragPayload || dragPayload.type !== "terminal") return
    event.preventDefault()
    clearDragIndicators()
    rootList.classList.add("drag-over-root")
  })

  rootList.addEventListener("dragleave", () => {
    rootList.classList.remove("drag-over-root")
  })

  rootList.addEventListener("drop", (event) => {
    if (!dragPayload || dragPayload.type !== "terminal") return
    event.preventDefault()
    moveTerminal(dragPayload.terminalId, null, null)
    clearDragState()
  })

  if (rootTerminals.length === 0) {
    const empty = document.createElement("li")
    empty.className = "terminal-empty standalone-empty"
    empty.textContent = "No standalone terminals"
    rootList.appendChild(empty)
  } else {
    for (const terminalTab of rootTerminals) {
      rootList.appendChild(makeTerminalItem(null, terminalTab, true))
    }
  }

  rootGroup.append(rootTitle, rootList)
  $list.appendChild(rootGroup)

  for (const project of projects) {
    const group = document.createElement("li")
    group.className = "project-group"
    group.dataset.projectId = project.id

    const row = document.createElement("div")
    row.className = "project-row"
    row.role = "treeitem"
    row.tabIndex = 0
    row.title = project.path ?? "Empty folder"
    row.dataset.projectId = project.id

    addProjectRowDropHandlers(row, project)

    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.className = "project-toggle"
    toggle.textContent = project.expanded ? "▾" : "▸"
    toggle.title = project.expanded ? "Collapse folder" : "Expand folder"
    toggle.addEventListener("click", (event) => {
      event.stopPropagation()
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
    addTerminalBtn.addEventListener("click", (event) => {
      event.stopPropagation()
      void addTerminal(project.id)
    })

    actions.appendChild(addTerminalBtn)
    row.append(toggle, folderIcon, name, actions)

    row.addEventListener("click", () => {
      void selectProject(project.id)
    })

    row.addEventListener("contextmenu", (event) => {
      event.preventDefault()
      event.stopPropagation()
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
        terminalList.appendChild(makeTerminalItem(project.id, terminalTab, false))
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

// ── Data mutations ────────────────────────────────────────────────────────────

function reorderProject(projectId: string, targetProjectId: string, placeAfter: boolean): void {
  if (projectId === targetProjectId) return

  const sourceIndex = projects.findIndex((project) => project.id === projectId)
  const targetIndex = projects.findIndex((project) => project.id === targetProjectId)
  if (sourceIndex < 0 || targetIndex < 0) return

  const [project] = projects.splice(sourceIndex, 1)

  let insertAt = targetIndex
  if (sourceIndex < targetIndex) insertAt -= 1
  if (placeAfter) insertAt += 1
  insertAt = clamp(insertAt, 0, projects.length)

  projects.splice(insertAt, 0, project)
  renderSidebar()
  save()
}

function moveTerminal(terminalId: string, targetProjectId: string | null, targetIndex: number | null): void {
  const source = findTerminalLocation(terminalId)
  const targetList = getTerminalList(targetProjectId)
  if (!source || !targetList) return

  const sourceList = getTerminalList(source.ownerProjectId)
  if (!sourceList) return

  sourceList.splice(source.index, 1)

  let insertAt = targetIndex === null ? targetList.length : clamp(targetIndex, 0, targetList.length)
  if (source.ownerProjectId === targetProjectId && insertAt > source.index) {
    insertAt -= 1
  }

  targetList.splice(insertAt, 0, source.terminal)

  if (targetProjectId) {
    const destinationProject = findProject(targetProjectId)
    if (destinationProject) destinationProject.expanded = true
  }

  if (activeTerminalId === terminalId) {
    activeProjectId = targetProjectId
  }

  renderSidebar()
  save()
}

// ── Project / terminal selection ──────────────────────────────────────────────

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

async function selectTerminal(projectId: string | null, terminalId: string): Promise<void> {
  const ownerProjectId = getTerminalOwnerProjectId(terminalId)
  if (ownerProjectId === undefined) return

  const terminalTab = findTerminalById(terminalId)
  if (!terminalTab) return

  hideActiveTerminal()
  activeProjectId = ownerProjectId
  activeTerminalId = terminalTab.id

  if (ownerProjectId) {
    const owner = findProject(ownerProjectId)
    if (owner && !owner.expanded) {
      owner.expanded = true
      renderSidebar()
    } else {
      refreshListUI()
      updateEmptyState()
    }
  } else {
    refreshListUI()
    updateEmptyState()
  }

  const session = getOrCreateSession(terminalTab)
  session.wrapper.classList.add("active")

  await ensureSpawned(terminalTab.id, session)

  requestAnimationFrame(() => {
    try {
      session.fitAddon.fit()
      void window.minty.resizePty(terminalTab.id, session.terminal.cols, session.terminal.rows)
    } catch {
      // not yet laid out
    }
    session.terminal.focus()
  })

  refreshListUI()
  updateEmptyState()
  save()
}

// ── Add / Remove / Rename ────────────────────────────────────────────────────

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

async function addEmptyFolder(): Promise<void> {
  const project: Project = {
    id: genProjectId(),
    name: nextEmptyFolderName(),
    path: null,
    terminals: [],
    expanded: true,
  }

  projects.push(project)
  activeProjectId = project.id
  activeTerminalId = null

  renderSidebar()
  save()
}

async function addStandaloneTerminal(): Promise<void> {
  const terminalTab: TerminalTab = {
    id: genTerminalId(),
    name: nextTerminalName(rootTerminals),
  }

  rootTerminals.push(terminalTab)
  createSession(terminalTab)

  renderSidebar()
  await selectTerminal(null, terminalTab.id)
}

async function addTerminal(projectId: string): Promise<void> {
  const project = findProject(projectId)
  if (!project) return

  const terminalTab: TerminalTab = {
    id: genTerminalId(),
    name: nextTerminalName(project.terminals),
  }

  project.terminals.push(terminalTab)
  project.expanded = true
  createSession(terminalTab)

  renderSidebar()
  await selectTerminal(project.id, terminalTab.id)
}

async function renameTerminal(terminalId: string): Promise<void> {
  const target = findTerminalById(terminalId)
  if (!target) return

  const nextName = window.prompt("Rename terminal", target.name)
  if (nextName === null) return

  const trimmed = nextName.trim()
  if (!trimmed || trimmed === target.name) return

  target.name = trimmed
  renderSidebar()
  save()
}

async function removeProject(projectId: string): Promise<void> {
  const index = projects.findIndex((project) => project.id === projectId)
  if (index < 0) return

  const [project] = projects.splice(index, 1)

  const removedTerminalIds = new Set(project.terminals.map((terminal) => terminal.id))
  if (activeTerminalId && removedTerminalIds.has(activeTerminalId)) {
    hideActiveTerminal()
    activeTerminalId = null
  }

  for (const terminalTab of project.terminals) {
    destroySession(terminalTab.id)
  }

  if (activeProjectId === projectId) {
    activeProjectId = projects[Math.min(index, projects.length - 1)]?.id ?? null
  }

  renderSidebar()
  save()
}

async function removeTerminal(projectId: string | null, terminalId: string): Promise<void> {
  const location = findTerminalLocation(terminalId)
  if (!location) return
  if (location.ownerProjectId !== projectId) return

  const list = getTerminalList(location.ownerProjectId)
  if (!list) return

  const removingActive = activeTerminalId === terminalId
  list.splice(location.index, 1)
  destroySession(terminalId)

  if (removingActive) {
    hideActiveTerminal()

    if (list.length > 0) {
      const nextTerminal = list[Math.min(location.index, list.length - 1)]
      renderSidebar()
      await selectTerminal(location.ownerProjectId, nextTerminal.id)
      return
    }

    activeTerminalId = null
    if (location.ownerProjectId) {
      activeProjectId = location.ownerProjectId
    } else {
      activeProjectId = projects[0]?.id ?? null
    }
  }

  renderSidebar()
  save()
}

// ── Persistence ───────────────────────────────────────────────────────────────

function save(): void {
  void window.minty.saveProjects({
    projects,
    rootTerminals,
    activeProjectId,
    activeTerminalId,
  })
}

// ── Sidebar visibility ────────────────────────────────────────────────────────

function toggleSidebar(): void {
  sidebarVisible = !sidebarVisible
  $sidebar.classList.toggle("collapsed", !sidebarVisible)
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
  } catch {
    // ignore if not ready
  }
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
    const projectId = parseProjectId(item.dataset.projectId)
    const terminalId = item.dataset.terminalId
    if (terminalId) void selectTerminal(projectId, terminalId)
  }
}

function focusSidebar(): void {
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

document.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey
  const focused = document.activeElement as HTMLElement | null
  const inSidebar =
    focused?.classList.contains("project-row") ||
    focused?.classList.contains("terminal-item") ||
    false

  if (mod) {
    switch (event.key) {
      case "n":
      case "N":
        event.preventDefault()
        void addProject()
        return
      case "w":
      case "W":
        event.preventDefault()
        if (activeTerminalId) {
          const ownerProjectId = getTerminalOwnerProjectId(activeTerminalId)
          if (ownerProjectId !== undefined) {
            void removeTerminal(ownerProjectId, activeTerminalId)
          }
        } else if (activeProjectId) {
          void removeProject(activeProjectId)
        }
        return
      case "b":
      case "B":
        event.preventDefault()
        toggleSidebar()
        return
      case "k":
      case "K":
        event.preventDefault()
        focusSidebar()
        return
      case "l":
      case "L":
        event.preventDefault()
        focusTerminal()
        return
    }

    if (event.key >= "1" && event.key <= "9") {
      event.preventDefault()
      const index = parseInt(event.key, 10) - 1
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

  if (inSidebar) {
    const items = sidebarItems()
    const idx = focused ? items.indexOf(focused) : -1

    if (event.key === "ArrowDown" && idx >= 0 && idx < items.length - 1) {
      event.preventDefault()
      const target = items[idx + 1]
      target.focus()
      activateSidebarItem(target)
    } else if (event.key === "ArrowUp" && idx > 0) {
      event.preventDefault()
      const target = items[idx - 1]
      target.focus()
      activateSidebarItem(target)
    } else if (event.key === "ArrowRight" && focused?.classList.contains("project-row")) {
      const projectId = focused.dataset.projectId
      const project = projectId ? findProject(projectId) : undefined
      if (project && !project.expanded) {
        event.preventDefault()
        project.expanded = true
        renderSidebar()
        const row = $list.querySelector<HTMLElement>(`.project-row[data-project-id="${project.id}"]`)
        row?.focus()
        save()
      }
    } else if (event.key === "ArrowLeft" && focused?.classList.contains("project-row")) {
      const projectId = focused.dataset.projectId
      const project = projectId ? findProject(projectId) : undefined
      if (project && project.expanded) {
        event.preventDefault()
        project.expanded = false
        renderSidebar()
        const row = $list.querySelector<HTMLElement>(`.project-row[data-project-id="${project.id}"]`)
        row?.focus()
        save()
      }
    } else if (event.key === "Enter") {
      event.preventDefault()
      if (focused) activateSidebarItem(focused)
    }
  }
})

// ── Buttons ───────────────────────────────────────────────────────────────────

$addBtn.addEventListener("click", () => void addProject())
$newFolderBtn.addEventListener("click", () => void addEmptyFolder())
$newTerminalBtn.addEventListener("click", () => void addStandaloneTerminal())

// ── Init ──────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  if (window.minty.platform === "darwin") {
    document.body.classList.add("macos")
  }

  const data = normalizeLoadedData(await window.minty.loadProjects())
  projects = data.projects
  rootTerminals = data.rootTerminals

  for (const terminalTab of rootTerminals) {
    createSession(terminalTab)
  }
  for (const project of projects) {
    for (const terminalTab of project.terminals) {
      createSession(terminalTab)
    }
  }

  activeProjectId = data.activeProjectId
  activeTerminalId = data.activeTerminalId

  renderSidebar()

  if (activeTerminalId) {
    const ownerProjectId = getTerminalOwnerProjectId(activeTerminalId)
    if (ownerProjectId !== undefined) {
      await selectTerminal(ownerProjectId, activeTerminalId)
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
