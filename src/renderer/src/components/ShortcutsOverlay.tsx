interface Props {
  onClose: () => void
}

// Two modes. Wall mode: no terminal has focus; keys drive the wall. Terminal mode: every key
// goes to the focused terminal, except the Ctrl+Shift chords below.
const SHORTCUTS: Array<[string, string]> = [
  ['Arrow keys', 'Wall mode: move the highlight between tiles'],
  ['Enter', 'Wall mode: zoom the highlighted tile and type into it'],
  ['Ctrl+Shift+Enter', 'Leave the terminal (restores a zoomed tile) / zoom from wall mode'],
  ['Click a tile', 'Type into it in place'],
  ['Double-click a tile', 'Zoom it over the wall'],
  ['Drag a tile', 'Reorder the wall'],
  ['Right-click a tile', 'Pin it at 2x2 (again to unpin)'],
  ['Click empty wall / dim', 'Back to wall mode (deselects / restores)'],
  ['Esc', 'Restore a zoomed tile (only when focus is not in a terminal)'],
  ['Ctrl+Shift+E', 'Files for the selected tile'],
  ['Ctrl+F', 'Search the zoomed terminal'],
  ['Ctrl+1 … Ctrl+9', 'Jump to workspace 1–9'],
  ['Ctrl+N', 'New workspace'],
  ['Ctrl+K', 'Command palette (outside terminals)'],
  ['?', 'Toggle this overview']
]

export default function ShortcutsOverlay({ onClose }: Props): React.JSX.Element {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard shortcuts</h2>
        <table className="shortcuts-table">
          <tbody>
            {SHORTCUTS.map(([keys, desc]) => (
              <tr key={keys}>
                <td className="shortcuts-keys">{keys}</td>
                <td>{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
