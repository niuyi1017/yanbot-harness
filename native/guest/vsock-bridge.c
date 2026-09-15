#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/vm_sockets.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

// Guest-only byte bridge. No host filesystem access, commands, credentials, or logging.
static void relay(int a, int b) {
  struct lane { int input, output; unsigned char data[65536]; size_t start, end; int eof; } lanes[2] = {
    {.input = a, .output = b}, {.input = b, .output = a}
  };
  fcntl(a, F_SETFL, O_NONBLOCK); fcntl(b, F_SETFL, O_NONBLOCK);
  for (;;) {
    struct pollfd events[2] = {{.fd = a}, {.fd = b}};
    int done = 0;
    for (int i = 0; i < 2; ++i) {
      struct lane *l = &lanes[i];
      if (!l->eof && l->end < sizeof(l->data)) events[i].events |= POLLIN;
      if (l->start < l->end) events[1-i].events |= POLLOUT;
      else if (l->eof) ++done;
    }
    if (done == 2 || poll(events, 2, 120000) <= 0) break;
    for (int i = 0; i < 2; ++i) {
      struct lane *l = &lanes[i];
      if (!l->eof && l->end < sizeof(l->data) && (events[i].revents & (POLLIN | POLLHUP | POLLERR))) {
        ssize_t n = read(l->input, l->data + l->end, sizeof(l->data) - l->end);
        if (n > 0) l->end += (size_t)n;
        else if (n == 0 || (errno != EAGAIN && errno != EINTR)) l->eof = 1;
      }
      if (l->start < l->end && (events[1-i].revents & POLLOUT)) {
        ssize_t n = write(l->output, l->data + l->start, l->end - l->start);
        if (n > 0) l->start += (size_t)n;
        else if (n < 0 && errno != EAGAIN && errno != EINTR) return;
      }
      if (l->start == l->end) { l->start = l->end = 0; if (l->eof) shutdown(l->output, SHUT_WR); }
    }
  }
}
int main(void) {
  signal(SIGPIPE, SIG_IGN);
  int listener = socket(AF_VSOCK, SOCK_STREAM | SOCK_CLOEXEC, 0);
  struct sockaddr_vm address = {.svm_family = AF_VSOCK, .svm_port = 1024, .svm_cid = VMADDR_CID_ANY};
  if (listener < 0 || bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 32)) return 1;
  unsigned active = 0;
  for (;;) {
    while (waitpid(-1, NULL, WNOHANG) > 0) if (active) --active;
    int peer = accept4(listener, NULL, NULL, SOCK_CLOEXEC);
    if (peer < 0) { if (errno == EINTR) continue; return 1; }
    if (active >= 64) { close(peer); continue; }
    pid_t child = fork();
    if (child == 0) {
      close(listener);
      int target = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
      struct sockaddr_in tcp = {.sin_family = AF_INET, .sin_port = htons(3100), .sin_addr.s_addr = htonl(INADDR_LOOPBACK)};
      if (target >= 0 && connect(target, (struct sockaddr *)&tcp, sizeof(tcp)) == 0) relay(peer, target);
      _exit(0);
    }
    if (child > 0) ++active;
    close(peer);
  }
}
