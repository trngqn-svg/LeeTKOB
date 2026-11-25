// Attack 5 of 9: a process limit (brief section 5, PA#3 rubric criterion 2).
//
// A fork bomb, with a ceiling so the test stays safe on a machine with no limit: the
// submission forks up to 200 children that each wait, and counts how many forks
// succeed. With the sandbox's limit (16 processes, FAQ-05), fork fails with EAGAIN long
// before 200. The children are killed and reaped before the program prints, so the
// output never depends on the order of processes.
//
// Expected: one line, "processes: limited". The test gives this as the expected
// output, so the sandbox answers `accepted` when the limit holds and `wrong_answer`
// when all 200 forks succeed.
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cstdio>
#include <vector>

int main() {
  const int ceiling = 200;
  std::vector<pid_t> children;
  bool refused = false;
  for (int i = 0; i < ceiling; ++i) {
    pid_t pid = fork();
    if (pid < 0) {
      refused = true;
      break;
    }
    if (pid == 0) {
      for (;;) pause();
    }
    children.push_back(pid);
  }
  for (pid_t pid : children) kill(pid, SIGKILL);
  for (pid_t pid : children) waitpid(pid, nullptr, 0);
  if (refused) {
    std::puts("processes: limited");
  } else {
    std::printf("processes: unlimited (%d children)\n", ceiling);
  }
  return 0;
}
