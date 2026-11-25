// Attack 6 of 9: an output size limit (brief section 5, PA#3 rubric criterion 2).
//
// The submission writes 64 MiB to standard output as fast as it can. Without a limit
// the worker would read all of it into memory, and a few such submissions at once
// would exhaust the VM.
//
// Expected: the sandbox stops reading after 1 MiB (FAQ-05) and answers `runtime_error`
// for the test (our mapping of output over the limit, docs/ARCHITECTURE.md section 3).
// The run must end quickly: well before the wall-clock limit, and without the worker
// holding 64 MiB.
#include <cstdio>
#include <cstring>

int main() {
  static char line[4096];
  std::memset(line, 'A', sizeof line - 1);
  line[sizeof line - 1] = '\n';
  const long total = 64L * 1024 * 1024;
  for (long written = 0; written < total; written += static_cast<long>(sizeof line)) {
    if (std::fwrite(line, 1, sizeof line, stdout) != sizeof line) return 1;
  }
  return 0;
}
