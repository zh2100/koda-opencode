import type { Tool } from "./tool"

// Capability belongs to the registered implementation, never its provider-visible name.
export const guardedImageTools = new WeakSet<Tool.AnyTool>()
export const inventoryTools = new WeakSet<Tool.AnyTool>()
// One accessible candidate is sufficient to require review, no file contents are read.
export const inventoryPattern =
  "**/*.{[pP][nN][gG],[jJ][pP][gG],[jJ][pP][eE][gG],[wW][eE][bB][pP],[gG][iI][fF],[sS][vV][gG],[aA][vV][iI][fF],[bB][mM][pP],[tT][iI][fF],[tT][iI][fF][fF]}"
