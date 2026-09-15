// Owned-process lifecycle boundary. Not a security sandbox for hostile same-user code.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <io.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE h = nullptr) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

static int fail(const char* stage, DWORD code) {
  std::fprintf(stderr, "{\"protocolVersion\":1,\"type\":\"error\",\"stage\":\"%s\",\"code\":%lu}\n", stage, code);
  std::fflush(stderr);
  ExitProcess(1); // Also closes any owned Job; never race a blocked lease reader against stack teardown.
}

static std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\"";
  size_t slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') { ++slashes; continue; }
    result.append(slashes * (c == L'"' ? 2 : 1), L'\\');
    slashes = 0;
    if (c == L'"') result += L'\\';
    result += c;
  }
  result.append(slashes * 2, L'\\');
  return result + L'"';
}

struct Lease { HANDLE closed; volatile LONG invalid = 0; };
static DWORD WINAPI watchLease(void* raw) {
  auto* lease = static_cast<Lease*>(raw);
  const std::string expected = "stop\n";
  size_t index = 0;
  for (;;) {
    char value = 0;
    DWORD count = 0;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), &value, 1, &count, nullptr) || count == 0) break;
    if (index >= expected.size() || value != expected[index++]) {
      InterlockedExchange(&lease->invalid, 1);
      break;
    }
    if (index == expected.size()) break;
  }
  // A partially written command is a protocol error, but still closes the entire Job.
  if (index != 0 && index != expected.size()) InterlockedExchange(&lease->invalid, 1);
  SetEvent(lease->closed);
  return 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 3 || std::wstring(argv[1]) != L"--") return fail("arguments", ERROR_INVALID_PARAMETER);
  std::wstring command;
  for (int i = 2; i < argc; ++i) { if (i != 2) command += L' '; command += quote(argv[i]); }
  if (command.size() >= 32767) return fail("arguments", ERROR_BAD_LENGTH);

  Handle job(CreateJobObjectW(nullptr, nullptr));
  if (!job.value) return fail("create-job", GetLastError());
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    return fail("job-limits", GetLastError());

  Handle closed(CreateEventW(nullptr, TRUE, FALSE, nullptr));
  if (!closed.value) return fail("lease-event", GetLastError());
  // Heap lifetime survives every early return until process teardown; the reader must not see a freed stack.
  auto* lease = new Lease{closed.value};
  Handle leaseThread(CreateThread(nullptr, 0, watchLease, lease, 0, nullptr));
  if (!leaseThread.value) return fail("lease-thread", GetLastError());

  SECURITY_ATTRIBUTES inheritable{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  Handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, 0, nullptr));
  Handle output(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, 0, nullptr));
  Handle errors(CreateFileW(L"NUL", GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, 0, nullptr));
  if (input.value == INVALID_HANDLE_VALUE || output.value == INVALID_HANDLE_VALUE || errors.value == INVALID_HANDLE_VALUE)
    return fail("null-streams", GetLastError());
  std::vector<HANDLE> inherited{input.value, output.value, errors.value};
  wchar_t ipcFd[16]{};
  const DWORD ipcLength = GetEnvironmentVariableW(L"NODE_CHANNEL_FD", ipcFd, 16);
  const bool ipc = ipcLength > 0;
  if (ipc) {
    if (ipcLength != 1 || ipcFd[0] != L'3') return fail("ipc-fd", ERROR_INVALID_PARAMETER);
    const intptr_t raw = _get_osfhandle(3);
    if (raw == -1 || raw == -2) return fail("ipc-handle", ERROR_INVALID_HANDLE);
    HANDLE channel = reinterpret_cast<HANDLE>(raw);
    if (!SetHandleInformation(channel, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return fail("ipc-inherit", GetLastError());
    inherited.push_back(channel);
  }

  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
  std::vector<unsigned char> storage(size);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &size)) return fail("attributes", GetLastError());
  struct AttributesGuard { LPPROC_THREAD_ATTRIBUTE_LIST value; ~AttributesGuard() { DeleteProcThreadAttributeList(value); } } guard{attributes};
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.value, sizeof(HANDLE), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(), inherited.size() * sizeof(HANDLE), nullptr, nullptr))
    return fail("job-and-handle-list", GetLastError());

  // MS CRT fd table, including Node's optional private IPC descriptor 3. No other parent handles are inherited.
  const int count = static_cast<int>(inherited.size());
  std::vector<unsigned char> fdTable(sizeof(int) + inherited.size() * (sizeof(unsigned char) + sizeof(HANDLE)), 0);
  std::memcpy(fdTable.data(), &count, sizeof(count));
  for (int i = 0; i < count; ++i) {
    fdTable[sizeof(int) + i] = static_cast<unsigned char>(i == 3 ? 0x09 : 0x01);
    std::memcpy(fdTable.data() + sizeof(int) + count + i * sizeof(HANDLE), &inherited[i], sizeof(HANDLE));
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = input.value;
  startup.StartupInfo.hStdOutput = output.value;
  startup.StartupInfo.hStdError = errors.value;
  startup.StartupInfo.cbReserved2 = static_cast<WORD>(fdTable.size());
  startup.StartupInfo.lpReserved2 = fdTable.data();
  startup.lpAttributeList = attributes;
  if (WaitForSingleObject(closed.value, 0) == WAIT_OBJECT_0) return fail("lease-closed-before-start", ERROR_BROKEN_PIPE);
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(argv[2], command.data(), nullptr, nullptr, TRUE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
      nullptr, nullptr, &startup.StartupInfo, &child)) return fail("create-contained-process", GetLastError());
  Handle process(child.hProcess);
  Handle thread(child.hThread);
  // SDK owns the other end. Closing this copy lets Runtime observe real IPC EOF.
  if (ipc) _close(3);
  std::printf("{\"protocolVersion\":1,\"type\":\"started\",\"hostPid\":%lu,\"runtimePid\":%lu}\n", GetCurrentProcessId(), child.dwProcessId);
  std::fflush(stdout);
  if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) return fail("resume", GetLastError());
  HANDLE events[]{closed.value, process.value};
  const DWORD wait = WaitForMultipleObjects(2, events, FALSE, INFINITE);
  if (wait != WAIT_OBJECT_0 && wait != WAIT_OBJECT_0 + 1) return fail("wait", GetLastError());
  if (!TerminateJobObject(job.value, 1)) return fail("terminate-job", GetLastError());
  const ULONGLONG deadline = GetTickCount64() + 5000;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info{};
    if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &info, sizeof(info), nullptr))
      return fail("query-job", GetLastError());
    if (info.ActiveProcesses == 0) break;
    if (GetTickCount64() >= deadline) return fail("job-not-empty", WAIT_TIMEOUT);
    Sleep(10);
  }
  std::printf("{\"protocolVersion\":1,\"type\":\"stopped\",\"activeProcesses\":0}\n");
  std::fflush(stdout);
  // ExitProcess tears down the blocked lease thread without allowing it to touch destructed stack objects.
  ExitProcess(InterlockedCompareExchange(&lease->invalid, 0, 0) ? 1 : 0);
}
