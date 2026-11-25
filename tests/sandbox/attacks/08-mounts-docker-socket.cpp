// Attack 8 of 9: no host mounts and no Docker socket (brief section 5, PA#3 rubric
// criterion 2).
//
// Docker socket: the submission looks for the socket at its usual paths and tries to
// connect to it. Whoever reaches the socket controls the host.
//
// Host mounts: it reads /proc/self/mountinfo and looks for a mount backed by a disk
// filesystem (ext4, xfs, btrfs and the like), which is what a bind mount from the host
// looks like. Docker itself bind-mounts /etc/hosts, /etc/hostname and /etc/resolv.conf
// into every container, so those three are allowed. The sandbox must give the source
// to the container another way (standard input, `docker cp` or a tmpfs), never as a
// folder of the host.
//
// Expected: one line, "docker socket: absent; host mounts: none". The test gives this
// as the expected output, so the sandbox answers `accepted` when both hold and
// `wrong_answer` otherwise.
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <fstream>
#include <set>
#include <sstream>
#include <string>

static bool socketReachable(const char* path) {
  if (access(path, F_OK) == 0) return true;
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return false;
  sockaddr_un addr{};
  addr.sun_family = AF_UNIX;
  std::strncpy(addr.sun_path, path, sizeof addr.sun_path - 1);
  bool ok = connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr) == 0;
  close(fd);
  return ok;
}

// Counts the mounts that come from a disk of the host, other than Docker's own three.
static int hostMounts() {
  const std::set<std::string> diskTypes = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs",
                                           "vfat", "ntfs", "fuseblk", "9p", "virtiofs"};
  const std::set<std::string> dockerFiles = {"/etc/hosts", "/etc/hostname",
                                             "/etc/resolv.conf"};
  std::ifstream mountinfo("/proc/self/mountinfo");
  std::string line;
  int count = 0;
  while (std::getline(mountinfo, line)) {
    // Fields: id parent major:minor root mountpoint options ... - fstype source options
    std::istringstream fields(line);
    std::string id, parent, device, root, mountPoint;
    fields >> id >> parent >> device >> root >> mountPoint;
    std::size_t dash = line.find(" - ");
    if (dash == std::string::npos) continue;
    std::istringstream tail(line.substr(dash + 3));
    std::string fsType;
    tail >> fsType;
    if (diskTypes.count(fsType) != 0 && dockerFiles.count(mountPoint) == 0) ++count;
  }
  return count;
}

int main() {
  const char* sockets[] = {"/var/run/docker.sock", "/run/docker.sock",
                           "/var/run/docker/docker.sock", "/run/containerd/containerd.sock"};
  bool socketFound = false;
  for (const char* path : sockets) socketFound = socketFound || socketReachable(path);
  int mounts = hostMounts();
  if (!socketFound && mounts == 0) {
    std::puts("docker socket: absent; host mounts: none");
  } else {
    std::printf("docker socket: %s; host mounts: %d\n", socketFound ? "reachable" : "absent",
                mounts);
  }
  return 0;
}
