#include <napi.h>
#include <string>
#include <unordered_map>
#include <mutex>
#include <cstdint>
#include <cerrno>
#include <cstring>

#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#endif

namespace {

struct Held {
  bool closed = false;
  uint64_t envId = 0;
#ifdef _WIN32
  HANDLE handle = INVALID_HANDLE_VALUE;
#else
  int fd = -1;
#endif
};

struct Environment {
  uint64_t id = 0;
  bool cleaned = false;
};

std::mutex registryMutex;
std::unordered_map<std::string, Held> registry;
uint64_t nextToken = 1;
uint64_t nextEnv = 1;

void setError(Napi::Env env, const char* operation, int code, const std::string& file) {
  // node-addon-api 8 Error::New accepts a message string, not an object.
  Napi::Error error = Napi::Error::New(env, std::string(operation) + " failed");
  error.Set("operation", operation);
  error.Set("code", static_cast<double>(code));
  error.Set("path", file);
  error.ThrowAsJavaScriptException();
}

#ifdef _WIN32
bool widePath(const std::string& file, std::wstring& wide, int& error) {
  if (file.empty()) {
    error = ERROR_INVALID_NAME;
    return false;
  }
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, file.data(), static_cast<int>(file.size()), nullptr, 0);
  if (size <= 0) {
    error = GetLastError();
    return false;
  }
  wide.assign(static_cast<size_t>(size), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, file.data(), static_cast<int>(file.size()), wide.data(), size) <= 0) {
    error = GetLastError();
    return false;
  }
  return true;
}
#endif

bool makeToken(std::string& token) {
  if (nextToken == UINT64_MAX) return false;
  token = std::to_string(nextToken++);
  return true;
}

struct CloseResult {
  bool ok = true;
  int code = 0;
  const char* operation = "close";
};

CloseResult closeOnce(Held& held) {
  CloseResult result;
  if (held.closed) return result;
#ifdef _WIN32
  if (held.handle != INVALID_HANDLE_VALUE) {
    OVERLAPPED overlapped = {};
    if (!UnlockFileEx(held.handle, 0, 1, 0, &overlapped)) {
      result.ok = false;
      result.code = GetLastError();
      result.operation = "UnlockFileEx";
    }
    if (!CloseHandle(held.handle)) {
      if (result.ok) {
        result.ok = false;
        result.code = GetLastError();
        result.operation = "CloseHandle";
      }
    }
    held.handle = INVALID_HANDLE_VALUE;
  }
#else
  if (held.fd >= 0) {
    if (flock(held.fd, LOCK_UN) != 0) {
      result.ok = false;
      result.code = errno;
      result.operation = "flock";
    }
    if (close(held.fd) != 0 && result.ok) {
      result.ok = false;
      result.code = errno;
      result.operation = "close";
    }
    held.fd = -1;
  }
#endif
  held.closed = true;
  return result;
}

void cleanupEnvironment(void* data) {
  auto* environment = static_cast<Environment*>(data);
  std::lock_guard<std::mutex> guard(registryMutex);
  if (environment->cleaned) return;
  environment->cleaned = true;
  for (auto it = registry.begin(); it != registry.end();) {
    if (it->second.envId != environment->id) {
      ++it;
      continue;
    }
    closeOnce(it->second);
    it = registry.erase(it);
  }
}

Napi::Value TryAcquire(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "lock file path is required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string file = info[0].As<Napi::String>().Utf8Value();
  auto* environment = static_cast<Environment*>(info.Data());
  if (!environment || environment->cleaned) {
    setError(env, "tryAcquire", EINVAL, file);
    return env.Undefined();
  }
  Napi::Object result = Napi::Object::New(env);
#ifdef _WIN32
  std::wstring wide;
  int pathError = 0;
  if (!widePath(file, wide, pathError)) {
    setError(env, "MultiByteToWideChar", pathError, file);
    return env.Undefined();
  }
  HANDLE handle = CreateFileW(wide.c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                              OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    setError(env, "CreateFileW", GetLastError(), file);
    return env.Undefined();
  }
  OVERLAPPED overlapped = {};
  if (!LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped)) {
    const DWORD code = GetLastError();
    CloseHandle(handle);
    if (code == ERROR_LOCK_VIOLATION) {
      result.Set("status", "busy");
      return result;
    }
    setError(env, "LockFileEx", static_cast<int>(code), file);
    return env.Undefined();
  }
#else
  int fd = open(file.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
  if (fd < 0) {
    setError(env, "open", errno, file);
    return env.Undefined();
  }
  if (flock(fd, LOCK_EX | LOCK_NB) != 0) {
    const int code = errno;
    close(fd);
    if (code == EWOULDBLOCK || code == EAGAIN) {
      result.Set("status", "busy");
      return result;
    }
    setError(env, "flock", code, file);
    return env.Undefined();
  }
#endif
  std::string token;
  {
    std::lock_guard<std::mutex> guard(registryMutex);
    if (!makeToken(token)) {
#ifdef _WIN32
      CloseHandle(handle);
#else
      close(fd);
#endif
      setError(env, "token", ERANGE, file);
      return env.Undefined();
    }
    Held held;
    held.envId = environment->id;
#ifdef _WIN32
    held.handle = handle;
#else
    held.fd = fd;
#endif
    registry.emplace(token, held);
  }
  result.Set("status", "acquired");
  result.Set("token", token);
  return result;
}

Napi::Value Release(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "lock token is required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string token = info[0].As<Napi::String>().Utf8Value();
  auto* environment = static_cast<Environment*>(info.Data());
  std::lock_guard<std::mutex> guard(registryMutex);
  const auto found = registry.find(token);
  if (found == registry.end() || found->second.closed) return Napi::String::New(env, "already-released");
  if (!environment || found->second.envId != environment->id) {
    setError(env, "release", EPERM, token);
    return env.Undefined();
  }
  const CloseResult closed = closeOnce(found->second);
  registry.erase(found);
  if (!closed.ok) {
    setError(env, closed.operation, closed.code, token);
    return env.Undefined();
  }
  return Napi::String::New(env, "released");
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  auto* environment = new Environment();
  {
    std::lock_guard<std::mutex> guard(registryMutex);
    environment->id = nextEnv++;
  }
  napi_add_env_cleanup_hook(env, cleanupEnvironment, environment);
  exports.Set("tryAcquire", Napi::Function::New(env, TryAcquire, "tryAcquire", environment));
  exports.Set("release", Napi::Function::New(env, Release, "release", environment));
  return exports;
}

}  // namespace

NODE_API_MODULE(process_lock, Init)
