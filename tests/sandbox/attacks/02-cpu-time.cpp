// Attack 2 of 9: a CPU time limit (brief section 5, PA#3 rubric criterion 2).
//
// The submission spins forever on the CPU. It never sleeps and never prints, so only
// a limit on CPU time stops it.
//
// Expected: the sandbox answers `time_limit` for the test, and the time it reports is
// close to the lab's CPU limit (1 s by default, FAQ-05), not the wall-clock limit.
// If the sandbox has no CPU limit, the run lasts until the wall-clock kill instead.
int main() {
  volatile unsigned long long counter = 0;
  for (;;) {
    counter = counter + 1;
  }
}
