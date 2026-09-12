export function sessionPanelLayout(input: { review: boolean; terminal: boolean; files: boolean }) {
  return {
    visible: input.review || input.terminal || input.files,
    stacked: input.review && input.terminal,
  }
}

export function relayWorkspaceLayout(available: number) {
  if (available < 700) return { left: "overlay" as const, right: "overlay" as const }
  if (available < 960) return { left: "rail" as const, right: "drawer" as const }
  return { left: "rail" as const, right: "dock" as const }
}

export const RELAY_RIGHT_WIDTH_MIN = 280
export const RELAY_RIGHT_WIDTH_MAX = 480
export const RELAY_RIGHT_WIDTH_DEFAULT = 320

export function relayRightWidth(stored: number) {
  if (stored < RELAY_RIGHT_WIDTH_MIN) return RELAY_RIGHT_WIDTH_DEFAULT
  if (stored > RELAY_RIGHT_WIDTH_MAX) return RELAY_RIGHT_WIDTH_MAX
  return stored
}
