export type TerminalStatus = 'idle' | 'working' | 'waiting'

export interface Terminal {
  id: string
  name: string
  projectPath: string
  startCommand: string
  order: number
  /** Pinned tiles span 2x2 cells on the wall. Optional so older saved files load unchanged. */
  pinned?: boolean
}

/** A terminal's best-known working directory and where that knowledge came from. */
export interface PaneCwd {
  cwd: string
  /** agent: the shell's foreground child (OS); shell: the shell itself (OS);
   * reported: the shell's OSC 7 / 9;9 / 633 report; start: the folder it was started in. */
  source: 'agent' | 'shell' | 'reported' | 'start'
}

export interface Workspace {
  id: string
  name: string
  order: number
  terminals: Terminal[]
}

export interface TerminalRuntimeState {
  status: TerminalStatus
  unreadCount: number
  ptyStarted: boolean
}

export type AppTheme = 'dark' | 'light' | 'dracula' | 'nord' | 'solarized'

/** Grid wall tile scale: 'auto' fits the wall (max 0.5, floor 0.33), or a fixed target scale. */
export type TileScaleMode = 'auto' | '0.5' | '0.4' | '0.33'
export const TILE_SCALE_MODES: readonly TileScaleMode[] = ['auto', '0.5', '0.4', '0.33']

export interface AppSettings {
  windowBounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean }

  filePanelWidth: number
  activeWorkspaceId: string | null
  theme: AppTheme
  notificationsEnabled: boolean
  defaultStartCommand: string
  idleDebounceMs: number
  /** Unused since the grid wall replaced column tiling; kept so the saved format stays stable. */
  paneColFractions: number[]
  tileScale: TileScaleMode
}

/** The subset of AppSettings worth offering to restore from someone else's export — pure
 * preferences, never window/layout/session state (bounds, active workspace, pane layout). */
export interface RestorableSettings {
  theme: AppTheme
  notificationsEnabled: boolean
  defaultStartCommand: string
  idleDebounceMs: number
}

export interface PersistedState {
  workspaces: Workspace[]
  settings: AppSettings
}

export interface CreateWorkspaceInput {
  name: string
}

export interface CreateTerminalInput {
  workspaceId: string
  name: string
  projectPath: string
  startCommand?: string
}

export interface HookEventPayload {
  hookEventName: 'Notification' | 'Stop' | 'SubagentStop' | string
  projectPath: string
  message?: string
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
}

export type ListDirResult =
  | { ok: true; entries: FileEntry[] }
  | { ok: false; message: string }

export type ReadFileResult =
  | { ok: true; content: string; truncated: boolean }
  | { ok: false; reason: 'binary' | 'error'; message?: string }

export const HOOK_SERVER_PORT = 47823

export const IPC = {
  workspacesGet: 'workspaces:get',
  workspaceCreate: 'workspace:create',
  workspaceRename: 'workspace:rename',
  workspaceDelete: 'workspace:delete',
  workspaceReorder: 'workspace:reorder',
  workspacesExport: 'workspaces:export',
  workspacesImportPrepare: 'workspaces:importPrepare',
  workspacesImportCommit: 'workspaces:importCommit',

  terminalCreate: 'terminal:create',
  terminalRename: 'terminal:rename',
  terminalDelete: 'terminal:delete',
  terminalReorder: 'terminal:reorder',
  terminalRestart: 'terminal:restart',
  terminalPickFolder: 'terminal:pickFolder',
  terminalMarkRead: 'terminal:markRead',

  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  fsListDir: 'fs:listDir',
  fsReadFile: 'fs:readFile',

  ptyStart: 'pty:start',
  ptyInput: 'pty:input',
  ptyResize: 'pty:resize',
  ptyData: 'pty:data',
  ptyExit: 'pty:exit',
  ptyAck: 'pty:ack',
  ptySetPriority: 'pty:setPriority',
  ptyGetCwd: 'pty:getCwd',
  terminalSetPinned: 'terminal:setPinned',

  statusChanged: 'status:changed',
  gitBranchChanged: 'git:branchChanged',

  hookServerInfo: 'hooks:getServerInfo',
  hookEventReceived: 'hooks:eventReceived',
  terminalFocusRequest: 'terminal:focusRequest',

  showNotification: 'notification:show',

  appGetVersion: 'app:getVersion'
} as const

export interface ImportPreviewEntry {
  name: string
  terminals: Array<{ name: string; projectPath: string; startCommand: string }>
}

export type ExportResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'error'; message: string }

export type ImportPrepareResult =
  | { ok: true; entries: ImportPreviewEntry[]; settings: RestorableSettings | null }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'error'; message: string }

export type ImportCommitResult =
  | { ok: true; count: number }
  | { ok: false; reason: 'error'; message: string }

export interface ImportCommitInput {
  entries: ImportPreviewEntry[]
  settings: RestorableSettings | null
}
