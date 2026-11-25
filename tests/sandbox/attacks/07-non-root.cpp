// Attack 7 of 9: a non-root user (brief section 5, PA#3 rubric criterion 2).
//
// The submission checks who it runs as, then tries to become root and to write where
// only root may write. Each of these must fail for a non-root user with no extra
// capabilities.
//
// Expected: one line, "user: not root". The test gives this as the expected output,
// so the sandbox answers `accepted` when the program is not root and cannot become
// root, and `wrong_answer` otherwise.
#include <fcntl.h>
#include <unistd.h>

#include <cstdio>

int main() {
  bool isRoot = getuid() == 0 || geteuid() == 0;
  bool becameRoot = setuid(0) == 0;
  int fd = open("/etc/leetkob-attack", O_WRONLY | O_CREAT, 0644);
  bool wroteEtc = fd >= 0;
  if (fd >= 0) close(fd);
  if (!isRoot && !becameRoot && !wroteEtc) {
    std::puts("user: not root");
  } else {
    std::printf("user: root (uid=%d euid=%d setuid=%d etc=%d)\n", static_cast<int>(getuid()),
                static_cast<int>(geteuid()), becameRoot, wroteEtc);
  }
  return 0;
}
