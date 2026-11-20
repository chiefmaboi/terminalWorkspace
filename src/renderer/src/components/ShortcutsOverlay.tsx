interface Props {
  onClose: () => void
}

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl+K', 'Open the command palette'],
  ['Ctrl+1 … Ctrl+9', 'Jump to workspace 1–9'],
  ['Ctrl+N', 'New workspace'],
  ['Click a tile', 'Select it and type into it'],
  ['Double-click a tile', 'Maximize it'],
  ['Ctrl+Shift+Enter', 'Maximize / restore the selected tile'],
  ['Esc', 'Back to the grid (only when focus is not in a terminal)'],
  ['Ctrl+F', 'Search the maximized terminal'],
  ['Click ⚙', 'Open settings'],
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
