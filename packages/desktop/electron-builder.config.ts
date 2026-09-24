import { execFile } from "node:child_process"
import { statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"

const execFileAsync = promisify(execFile)
const packageDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(packageDir, "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")
// The Electron 42 packaging update briefly installed Linux launchers/icons under
// "opencode-desktop". Keep that hidden desktop entry around so existing GNOME/KDE
// pins still resolve after the canonical app id changes back to ai.opencode.desktop.
const legacyDesktopEntry = path.join(packageDir, "resources", "linux", "opencode-desktop.desktop")
const legacyDesktopEntryFpm = `${legacyDesktopEntry}=/usr/share/applications/opencode-desktop.desktop`

const metainfoFpm = (appId: string) =>
  `${path.join(packageDir, "resources", `${appId}.metainfo.xml`)}=/usr/share/metainfo/${appId}.metainfo.xml`

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const targetArch = process.env.OPENCODE_ELECTRON_ARCH || process.env.npm_config_arch || process.arch
const foreignNativeArch = targetArch === "arm64" ? "x64" : "arm64"
const gdalTarget = `${process.platform}-${targetArch}`
const gdalResource = path.join(packageDir, "resources", "gdal", gdalTarget)
const bundleGdal = process.env.KODA_BUNDLE_GDAL === "1"

const validateGdal: NonNullable<Configuration["beforePack"]> = async (context) => {
  if (!bundleGdal) return
  const arch = ["ia32", "x64", "armv7l", "arm64", "universal"][context.arch]
  if (context.electronPlatformName !== process.platform || arch !== targetArch) {
    throw new Error(
      "GDAL packaging requires a native-platform build and OPENCODE_ELECTRON_ARCH matching the builder target",
    )
  }
  if (requireGdalResource(gdalResource)) return
  throw new Error(
    `Bundled GDAL is missing for ${gdalTarget}. Run ` +
      "bun ./scripts/prepare-gdal.ts with KODA_GDAL_HOME or KODA_GDAL_ARCHIVE_URL and KODA_GDAL_ARCHIVE_SHA256; system GDAL is not used.",
  )
}

function requireGdalResource(prefix: string) {
  const root = process.platform === "win32" ? path.join(prefix, "Library") : prefix
  const executable = process.platform === "win32" ? ".exe" : ""
  return [
    path.join(root, "bin", `ogrinfo${executable}`),
    path.join(root, "bin", `ogr2ogr${executable}`),
    path.join(root, "share", "gdal"),
    path.join(root, "share", "proj", "proj.db"),
  ].every((item) => {
    const info = statSync(item, { throwIfNoEntry: false })
    return path.basename(item) === "gdal" ? info?.isDirectory() : info?.isFile() && info.size > 0
  })
}

function excludeForeignNativeModules() {
  return [
    `!**/node_modules/@lydell/node-pty-*-${foreignNativeArch}/**`,
    `!**/node_modules/@parcel/watcher-*-${foreignNativeArch}/**`,
    `!**/node_modules/@parcel/watcher-*-${foreignNativeArch}-*/**`,
  ]
}

const APP_IDS = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
} as const

const getBase = (appId: string): Configuration => ({
  beforePack: validateGdal,
  artifactName: "Koda-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  // Linux launchers are .desktop files, so this is the desktop file name,
  // not just the app id. For prod, app id "ai.opencode.desktop" becomes
  // "ai.opencode.desktop.desktop".
  // https://developer.gnome.org/documentation/guidelines/maintainer/integrating.html
  // https://www.electron.build/docs/linux/
  extraMetadata: {
    desktopName: `${appId}.desktop`,
  },
  files: [
    "out/**/*",
    "resources/**/*",
    "!resources/opencode-cli*",
    "!resources/gdal/**/*",
    ...excludeForeignNativeModules(),
  ],
  asarUnpack: ["**/*.node", "**/node_modules/@lydell/node-pty*/**"],
  extraResources: [
    {
      from: "resources/icons/",
      to: "icons/",
    },
    ...(channel === "dev"
      ? [
          {
            from: "resources/",
            to: "",
            filter: ["opencode-cli*"],
          },
        ]
      : []),
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
    ...(bundleGdal ? [{ from: gdalResource, to: `gdal/${gdalTarget}` }] : []),
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    identity: process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false" ? null : undefined,
    notarize: Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER),
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: process.env.CSC_IDENTITY_AUTO_DISCOVERY !== "false",
  },
  protocols: {
    name: "Koda",
    schemes: ["opencode"],
  },
  win: {
    appId: channel === "prod" ? "com.shuyuanai.koda.desktop" : appId,
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
    verifyUpdateCodeSignature: false,
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    executableName: appId,
    desktop: {
      entry: {
        // Match the installed .desktop file and hicolor icon basename so
        // Linux shells can associate the running Electron window with its launcher.
        StartupWMClass: appId,
      },
    },
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const appId = APP_IDS[channel]
  const base = getBase(appId)

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId,
        productName: "Koda Dev",
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "opencode-dev", fpm: [metainfoFpm(appId)] },
      }
    }
    case "beta": {
      return {
        ...base,
        appId,
        productName: "Koda Beta",
        protocols: { name: "Koda Beta", schemes: ["opencode"] },
        publish: { provider: "github", owner: "anomalyco", repo: "opencode-beta", channel: "latest" },
        deb: { fpm: [metainfoFpm(appId)] },
        rpm: { packageName: "opencode-beta", fpm: [metainfoFpm(appId)] },
      }
    }
    case "prod": {
      return {
        ...base,
        appId,
        productName: "Koda",
        protocols: { name: "Koda", schemes: ["opencode"] },
        deb: { fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
        rpm: { packageName: "opencode", fpm: [metainfoFpm(appId), legacyDesktopEntryFpm] },
      }
    }
  }
}

export default getConfig()
