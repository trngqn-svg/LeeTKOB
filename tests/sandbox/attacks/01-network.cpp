// Attack 1 of 9: no network (brief section 5, PA#3 rubric criterion 2).
//
// The submission tries three ways out: a DNS lookup, a TCP connection to a public
// address, and a UDP datagram to a public DNS server. With `--network none` the
// container has only a loopback interface, so all three fail at once.
//
// Expected: one line, "network: blocked". The test gives this as the expected output,
// so the sandbox answers `accepted` when it holds and `wrong_answer` when any way out
// works. The program never sends anything a server could act on.
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>

static bool dnsWorks() {
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  addrinfo* result = nullptr;
  int rc = getaddrinfo("example.com", "80", &hints, &result);
  if (result != nullptr) freeaddrinfo(result);
  return rc == 0;
}

static bool tcpWorks() {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return false;
  timeval timeout{2, 0};
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(80);
  inet_pton(AF_INET, "1.1.1.1", &addr.sin_addr);
  bool ok = connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr) == 0;
  close(fd);
  return ok;
}

static bool udpWorks() {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return false;
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(53);
  inet_pton(AF_INET, "8.8.8.8", &addr.sin_addr);
  const char payload[] = "x";
  // Without a route, sendto fails with ENETUNREACH; with a network it succeeds.
  bool ok = sendto(fd, payload, sizeof payload, 0,
                   reinterpret_cast<sockaddr*>(&addr), sizeof addr) >= 0;
  close(fd);
  return ok;
}

int main() {
  bool dns = dnsWorks();
  bool tcp = tcpWorks();
  bool udp = udpWorks();
  if (!dns && !tcp && !udp) {
    std::puts("network: blocked");
  } else {
    std::printf("network: open (dns=%d tcp=%d udp=%d)\n", dns, tcp, udp);
  }
  return 0;
}
