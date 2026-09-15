#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <string>

int wmain(int argc, wchar_t** argv) {
  if (argc != 5) return 2;
  std::wstring command;
  for (int i = 1; i < argc; ++i) {
    if (std::wstring(argv[i]).find(L'"') != std::wstring::npos) return 2;
    if (i != 1) command += L' ';
    command += L"\"" + std::wstring(argv[i]) + L"\"";
  }
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  const BOOL created = CreateProcessW(argv[1], command.data(), nullptr, nullptr, FALSE,
      CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child);
  const DWORD error = created ? 0 : GetLastError();
  if (created) {
    // A 30-second self-expiring authenticated fixture, observed after outer Job closure.
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
  }
  std::printf("{\"created\":%s,\"error\":%lu}\n", created ? "true" : "false", error);
  return 0;
}
