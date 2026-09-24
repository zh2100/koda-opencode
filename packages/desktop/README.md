# OpenCode Desktop

The OpenCode Desktop app, built with Electron.

## Development

```bash
bun install
bun dev
```

## Build

Run the `build` script to build the app's JS assets, then `package` to
bundle the assets as an application. The resulting app will be in `dist/`.

```bash
bun run build && bun run package
```

## Bundled GDAL

Desktop packaging never searches `PATH` for GDAL. GDAL bundling is opt-in. Set
`KODA_BUNDLE_GDAL=1`, then provide either
`KODA_GDAL_HOME`, an unpacked GDAL prefix, or both
`KODA_GDAL_ARCHIVE_URL` and `KODA_GDAL_ARCHIVE_SHA256` for a `.tar.gz` archive.
Run `bun run prepare:gdal` from this package. The archive is downloaded and checked
with SHA-256 before it is staged.

The staged directory is `resources/gdal/<platform>-<arch>`. Unix prefixes must
contain `bin/ogrinfo`, `bin/ogr2ogr`, `share/gdal/`, and
`share/proj/proj.db`. Windows prefixes must contain the same files below
`Library/` and the executables must have `.exe` suffixes. The prefix must also
include the platform's GDAL shared libraries beside the executables or in its
normal library directory.

Packaged apps set `KODA_GDAL_HOME` to the bundled prefix automatically. An
absolute `KODA_GDAL_HOME` supplied by the user overrides that path, but it is
validated against the same layout. An absent optional bundle does not prevent
desktop startup; GIS reports unavailable. An explicitly configured or present
but incomplete runtime is fatal; system GDAL is not used.

The acquisition script selects conda-forge GDAL 3.10.3 and PROJ 9.6.2. As an
alternative to the environment override, put a prefix in
`packages/desktop/vendor/gdal/<platform>-<arch>/`. Package scripts stage it
automatically. Set `OPENCODE_ELECTRON_ARCH` to `x64` or `arm64`, matching the
electron-builder target; use native-platform builders (no universal macOS build).

Archives must have the prefix contents directly at their root, with no enclosing
directory. Include GDAL >= 3.7 (for `ogrinfo -json`), matching PROJ data, license
notices, all transitive DLLs in `Library/bin` on Windows, and shared libraries in
`lib` on Unix. Preserve executable permissions. Linux artifacts must target the
oldest supported glibc; macOS libraries must use relocatable `@rpath` or
`@loader_path` install names and be compatible with app signing/notarization.
Do not archive an arbitrary system installation or an unrelocated Conda prefix.
Only required OS libraries may remain external. Drivers used by GIS must be
built in because the GIS runtime disables plugin discovery.

To opt into bundling in existing release CI, configure repository variables `KODA_GDAL_<TARGET>_ARCHIVE_URL` and
`KODA_GDAL_<TARGET>_SHA256`, where TARGET is `WIN_X64`, `WIN_ARM64`,
`LINUX_X64`, `LINUX_ARM64`, `DARWIN_X64`, or `DARWIN_ARM64`. Use immutable,
versioned HTTPS URLs and audited SHA-256 digests. Workflows cache archives by
target and checksum and reverify the digest before every extraction.
No system package manager GDAL installation is used as a fallback.

Staging validates required files and runs both tools plus a GeoJSON-to-GPKG
EPSG:4326-to-3857 conversion on native-architecture runners. Cross-architecture
builds validate layout only and require a native smoke test before release.
These checks do not prove library closure: test the relocated installed app on
clean Windows/Linux/macOS hosts without GDAL, Conda, or Homebrew installed.
Windows native CLI relocation has been tested locally, but clean-host installed
application validation has not been performed.

### Reproducible Windows acquisition

On a native Windows x64 runner, `bun run acquire:gdal` uses the official
micromamba executable and strict-channel-priority conda-forge to solve GDAL
3.10.3, libgdal-core 3.10.3, and PROJ 9.6.2. Set `MICROMAMBA_EXE` and
`CONDA_PACK_EXE` to the downloaded tools, or set `KODA_GDAL_SOURCE` to an
existing prefix. The tool writes an explicit package inventory and license
texts, creates a conda-pack archive, extracts it, and runs the smoke test from
a different prefix before staging only the native CLI/data closure. It does
not claim that the complete Python conda environment is relocatable: conda-pack
requires prefix cleanup, and after `conda-unpack` that environment cannot be
moved again. Conda-forge transitive licenses, including GPL/LGPL packages,
must be reviewed before redistribution.

The smoke test covers `ogrinfo` and `ogr2ogr`, GeoJSON to GeoPackage with
EPSG:4326 to EPSG:3857, and GeoJSON, Shapefile, and FlatGeobuf output. CI can
reproduce acquisition with the same pinned specs and publish the resulting
archive only after an immutable URL, SHA-256, license review, and clean-host
native test are recorded. Missing GDAL variables leave normal desktop builds
unchanged; packaging with `KODA_BUNDLE_GDAL=1` is strict.

Install the standalone micromamba 2.3.2 tool from the official
[mamba-org release](https://github.com/mamba-org/micromamba-releases/releases/tag/2.3.2-0).
Install packing tools separately: `python -m venv <tools>`, then use that venv's
Python to `-m pip install conda-pack==0.8.1 setuptools==80.9.0`.
Do not install packing tools with pip into the conda runtime. `conda-pack 0.8.1`
requires `pkg_resources`, removed in newer setuptools.
Set `KODA_GDAL_WORK` to a fresh preparation directory. `explicit.txt` records the
complete solved package URLs and checksums; pass it as `KODA_GDAL_LOCK` on a
subsequent native acquisition to replay the exact solve. Version pins alone do
not lock transitive dependencies. Preserve the package cache for license collection.

Linux/macOS can run the same script on native runners as an experimental
preparation/smoke option. They are intentionally not staged automatically:
post-unpack relocation, library closure, glibc compatibility and macOS signing
must be qualified on those systems. Windows ARM64 acquisition is rejected.
The conda-pack archive is an intermediate, NOT an archive to feed directly to
`prepare:gdal`; archive the tested Windows `vendor/gdal/win32-x64` contents for
release staging instead. The payload keeps all `Library/bin`, `Library/share`
and license files, rather than claiming a minimized dependency closure.

Local evidence: `D:\\tmp\\opencode\\gdal-preparation\\smoke.json` and
`explicit.txt`. Original source and extracted prefixes were renamed out of the
way during the relocated smoke; PATH contained only the relocated Library/bin.
Both tools reported GDAL 3.10.3. Point (1,1) reprojected to
(111319.49079327357,111325.1428663851), with one feature retained. All four
formats above passed. Runtime license texts include `vc14_runtime`, `ucrt`,
and `vcomp14`; the inventory flags upstream packages without license files
(SQLite public-domain packages and the `vc` metapackage). GPL dependencies
include `lzo` and `librttopo`; license texts/recipes alone do not fulfill all
source-distribution obligations. This is not redistribution approval.

The environment is set after loading the login-shell environment and inherited
by newly spawned local sidecars. Remote servers, WSL servers, and already-running
background daemons are separate processes and must provision their own runtime;
they cannot use the host app's bundled prefix automatically.
