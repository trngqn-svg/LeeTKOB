// Attack 3 of 9: a wall-clock limit that kills the container, not only the process
// (brief section 5, PA#3 rubric criterion 2).
//
// The submission uses no CPU at all, so a CPU limit never fires. It forks a child that
// leaves the parent's session and process group, then both sleep forever. A sandbox
// that only kills the main process on timeout leaves the child running.
//
// Expected: the sandbox answers `time_limit` once the wall-clock limit (3 times the CPU
// limit) has passed, and afterwards no container and no process of this run is left
// on the host. The test checks both: the result, and that `docker ps -a` lists no
// container of this run.
#include <unistd.h>

int main() {
  pid_t child = fork();
  if (child == 0) {
    setsid();  // a new session and process group: a kill of the parent's group misses it
    for (;;) pause();
  }
  for (;;) pause();
}
