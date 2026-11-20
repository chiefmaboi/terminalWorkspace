import { createContext, useContext } from 'react'
import type { Terminal } from '../../../shared/types'

/** Per-terminal actions a tile's ⋯ menu offers; the dialogs for them live at the app level. */
export interface TileActions {
  rename: (terminal: Terminal) => void
  restart: (terminal: Terminal) => void
  remove: (terminal: Terminal) => void
}

export const TileActionsContext = createContext<TileActions | null>(null)

export function useTileActions(): TileActions | null {
  return useContext(TileActionsContext)
}
