#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) return 2;
  std::wstring command = L"\"" + std::wstring(argv[1]) + L"\" -e \"setTimeout(()=>{},30000)\"";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  const BOOL created = CreateProcessW(argv[1], command.data(), nullptr, nullptr, FALSE,
      CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child);
  const DWORD error = created ? 0 : GetLastError();
  if (created) {
    // Test-only safety cleanup uses the newly created handle, never a later PID lookup.
    TerminateProcess(child.hProcess, 1);
    WaitForSingleObject(child.hProcess, 5000);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
  }
  std::printf("{\"created\":%s,\"error\":%lu}\n", created ? "true" : "false", error);
  return 0;
}
