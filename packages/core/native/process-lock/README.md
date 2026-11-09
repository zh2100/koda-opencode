# process-lock

Native file lock used only after a resource root selects `os-lock-v1`.

Build with node-gyp from this directory. The checked-in source is not a release artifact. Windows uses `CreateFileW` and `LockFileEx`. Unix uses `open` with `O_CLOEXEC` and `flock`. A successful build on one platform does not mean another platform has passed.

After installing workspace dependencies, run `bun run build:native-lock` from `packages/core` before running native lock tests. This requires Node, Python and a platform C++ toolchain. It builds from source and creates the platform module and manifest in `native/dist`. Windows uses node-gyp's default delay-load hook so the same artifact can load in Node and Bun. CI builds the module before running tests; build failures are not skipped.

The loader expects `process-lock-<platform>-<arch>.node` in `OPENCODE_NATIVE_LOCK_DIR`. Ordinary unmarked data roots never load this module.
