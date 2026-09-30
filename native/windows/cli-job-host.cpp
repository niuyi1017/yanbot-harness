// Owned-process lifecycle boundary. Not a security sandbox for hostile same-user code.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <io.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

static FILE* control = nullptr;

struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE h = nullptr) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};

static int fail(const char* stage, DWORD code) {
  FILE* destination = control ? control : stderr;
  std::fprintf(destination, "{\"protocolVersion\":1,\"type\":\"error\",\"stage\":\"%s\",\"code\":%lu}\n", stage, code);
  std::fflush(destination);
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
  control = _fdopen(3, "wb");
  if (!control) return fail("control-pipe", ERROR_INVALID_HANDLE);
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

  const intptr_t inputRaw = _get_osfhandle(4);
  if (inputRaw == -1 || inputRaw == -2) return fail("input-pipe", ERROR_INVALID_HANDLE);
  auto inheritPipe = [](HANDLE source) -> HANDLE {
    HANDLE result = nullptr;
    if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &result, 0, TRUE, DUPLICATE_SAME_ACCESS))
      fail("duplicate-pipe", GetLastError());
    return result;
  };
  Handle input(inheritPipe(reinterpret_cast<HANDLE>(inputRaw)));
  Handle output(inheritPipe(GetStdHandle(STD_OUTPUT_HANDLE)));
  Handle errors(inheritPipe(GetStdHandle(STD_ERROR_HANDLE)));
  std::vector<HANDLE> inherited{input.value, output.value, errors.value};
  SetEnvironmentVariableW(L"NODE_CHANNEL_FD", nullptr);

  SIZE_T size = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
  std::vector<unsigned char> storage(size);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &size)) return fail("attributes", GetLastError());
  struct AttributesGuard { LPPROC_THREAD_ATTRIBUTE_LIST value; ~AttributesGuard() { DeleteProcThreadAttributeList(value); } } guard{attributes};
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.value, sizeof(HANDLE), nullptr, nullptr) ||
      !UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(), inherited.size() * sizeof(HANDLE), nullptr, nullptr))
    return fail("job-and-handle-list", GetLastError());

  // Only vendor stdin/stdout/stderr are inherited. Lease and proof pipes remain host-private.
  const int count = static_cast<int>(inherited.size());
  std::vector<unsigned char> fdTable(sizeof(int) + inherited.size() * (sizeof(unsigned char) + sizeof(HANDLE)), 0);
  std::memcpy(fdTable.data(), &count, sizeof(count));
  for (int i = 0; i < count; ++i) {
    fdTable[sizeof(int) + i] = 0x09;
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
  std::fprintf(control, "{\"protocolVersion\":1,\"type\":\"started\",\"hostPid\":%lu,\"childPid\":%lu}\n", GetCurrentProcessId(), child.dwProcessId);
  std::fflush(control);
  if (ResumeThread(thread.value) == static_cast<DWORD>(-1)) return fail("resume", GetLastError());
  HANDLE events[]{closed.value, process.value};
  const DWORD wait = WaitForMultipleObjects(2, events, FALSE, INFINITE);
  if (wait != WAIT_OBJECT_0 && wait != WAIT_OBJECT_0 + 1) return fail("wait", GetLastError());
  DWORD exitCode = 1;
  if (wait == WAIT_OBJECT_0 + 1 && !GetExitCodeProcess(process.value, &exitCode)) return fail("exit-code", GetLastError());
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
  std::fprintf(control, "{\"protocolVersion\":1,\"type\":\"stopped\",\"activeProcesses\":0,\"exitCode\":%lu}\n", exitCode);
  std::fflush(control);
  // ExitProcess tears down the blocked lease thread without allowing it to touch destructed stack objects.
  ExitProcess(InterlockedCompareExchange(&lease->invalid, 0, 0) ? 1 : exitCode);
}
