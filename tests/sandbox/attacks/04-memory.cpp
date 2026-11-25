// Attack 4 of 9: a memory limit, swap included (brief section 5, PA#3 rubric criterion 2).
//
// The submission allocates 1 GiB in 16 MiB blocks and writes every page, so the memory
// is really used, not only reserved. It then reads every block back into a checksum
// and prints it. Because the result depends on every byte, the compiler cannot remove
// the allocation (AGENTS.md: a memory test must read back what it allocates).
//
// 1 GiB is above the highest limit a lab may ask for (512 MB, FAQ-05), so a limit is
// always met. The sandbox must set the swap limit equal to the memory limit; otherwise
// the process moves to swap and finishes.
//
// Expected: the sandbox answers `memory_limit` for the test (the kernel kills the
// process, Docker reports OOMKilled). If the line "checksum ..." is ever printed, the
// limit did not hold.
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <vector>

int main() {
  const std::size_t block = 16u * 1024u * 1024u;
  const std::size_t blocks = 64;  // 64 x 16 MiB = 1 GiB
  std::vector<unsigned char*> memory;
  for (std::size_t i = 0; i < blocks; ++i) {
    auto* p = static_cast<unsigned char*>(std::malloc(block));
    if (p == nullptr) {
      std::puts("malloc failed");
      return 1;
    }
    for (std::size_t j = 0; j < block; j += 4096) p[j] = static_cast<unsigned char>(i + j);
    memory.push_back(p);
  }
  unsigned long long checksum = 0;
  for (std::size_t i = 0; i < blocks; ++i) {
    for (std::size_t j = 0; j < block; j += 4096) checksum += memory[i][j];
  }
  std::printf("checksum %llu\n", checksum);
  for (auto* p : memory) std::free(p);
  return 0;
}
