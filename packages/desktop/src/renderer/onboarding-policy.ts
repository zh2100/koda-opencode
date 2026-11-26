export function shouldOpenDefaultProject(input: {
  builtin: boolean
  initialUrl: string
  tabs: number
  projects: number
  recentlyClosed: number
}) {
  return (
    input.builtin && input.initialUrl === "/" && input.tabs === 0 && input.projects === 0 && input.recentlyClosed === 0
  )
}
