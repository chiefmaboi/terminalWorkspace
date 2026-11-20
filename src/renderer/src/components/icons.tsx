// Small inline SVG icons (stroke = currentColor), so the UI uses no emoji glyphs.

export function PinIcon(): React.JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M6 2h4l-.5 4 2.5 2.5v1H4v-1L6.5 6 6 2z" strokeLinejoin="round" />
      <path d="M8 9.5V14" strokeLinecap="round" />
    </svg>
  )
}

export function GearIcon(): React.JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <circle cx="8" cy="8" r="2.2" />
      <path
        d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
        strokeLinecap="round"
      />
    </svg>
  )
}
