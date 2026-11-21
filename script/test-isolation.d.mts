type GlobalPaths = {
  home: string
  data: string
  config: string
  state: string
  cache: string
  tmp: string
  bin: string
  log: string
  repos: string
  lockContext: { data: string; config: string; state: string; cache: string }
}
export type Admission = {
  root: string
  paths: { data: string; config: string; state: string; cache: string }
  home: string
  tmp: string
  registration: string
  checksum: string | null
  marker: string
  markerChecksum: string | null
  env: string
}
export function identity(target: string): string
export function requireInside(root: string, target: string): string
export function configure(root: string): void
export function admit(root: string, options?: { registered?: boolean; global?: Partial<GlobalPaths> }): Admission
export function confirm(admission: Admission): void
export function reconcile(admission: Admission, global: GlobalPaths): void
export function preload(prefix: string): Admission
export function loadGlobal(root: string, options?: { registered?: boolean }): Promise<Admission>
