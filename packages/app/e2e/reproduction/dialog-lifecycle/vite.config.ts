import { defineConfig, mergeConfig } from "vite"
import { fileURLToPath } from "node:url"
import app from "../../../vite.config"

export default mergeConfig(
  app,
  defineConfig({
    build: {
      sourcemap: false,
      rollupOptions: {
        input: {
          app: fileURLToPath(new URL("../../../index.html", import.meta.url)),
          dialogs: fileURLToPath(new URL("./index.html", import.meta.url)),
        },
      },
    },
  }),
)
