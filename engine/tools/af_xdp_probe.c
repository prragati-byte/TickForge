/* AF_XDP feasibility probe. It builds nothing into the engine: it tries each step
 * AF_XDP needs on a veth device and prints which ones this machine allows.
 *
 *   cc -O1 -o af_xdp_probe engine/tools/af_xdp_probe.c
 *   unshare -Urn sh -c 'ip link add veth0 type veth peer name veth1 &&
 *     ip link set veth0 up && ip link set veth1 up && ./af_xdp_probe veth0'
 *
 * Run it without unshare, as root, to see what a privileged user gets.
 */
#include <errno.h>
#include <linux/bpf.h>
#include <linux/if_xdp.h>
#include <net/if.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef AF_XDP
#define AF_XDP 44
#endif
#ifndef SOL_XDP
#define SOL_XDP 283
#endif

static int step(const char *name, int ok) {
  printf("%-52s %s%s%s\n", name, ok ? "ok" : "FAILED: ", ok ? "" : strerror(errno), "");
  return ok;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: af_xdp_probe <device>\n");
    return 2;
  }
  unsigned ifindex = if_nametoindex(argv[1]);
  step("device exists", ifindex != 0);

  int fd = socket(AF_XDP, SOCK_RAW, 0);
  if (!step("socket(AF_XDP)", fd >= 0)) return 1;

  size_t size = 4096 * 64;
  void *mem = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  struct xdp_umem_reg reg;
  memset(&reg, 0, sizeof(reg));
  reg.addr = (unsigned long long)mem;
  reg.len = size;
  reg.chunk_size = 4096;
  step("register UMEM", setsockopt(fd, SOL_XDP, XDP_UMEM_REG, &reg, sizeof(reg)) == 0);

  int entries = 64;
  step("fill ring", setsockopt(fd, SOL_XDP, XDP_UMEM_FILL_RING, &entries, sizeof(entries)) == 0);
  step("completion ring", setsockopt(fd, SOL_XDP, XDP_UMEM_COMPLETION_RING, &entries, sizeof(entries)) == 0);
  step("RX ring", setsockopt(fd, SOL_XDP, XDP_RX_RING, &entries, sizeof(entries)) == 0);
  step("TX ring", setsockopt(fd, SOL_XDP, XDP_TX_RING, &entries, sizeof(entries)) == 0);

  struct sockaddr_xdp addr;
  memset(&addr, 0, sizeof(addr));
  addr.sxdp_family = AF_XDP;
  addr.sxdp_ifindex = ifindex;
  addr.sxdp_queue_id = 0;
  addr.sxdp_flags = XDP_COPY; /* the mode generic / skb XDP uses */
  step("bind to the device in copy mode", bind(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0);

  /* Receiving needs an XDP program with an XSKMAP to redirect packets to the socket. */
  union bpf_attr map;
  memset(&map, 0, sizeof(map));
  map.map_type = BPF_MAP_TYPE_XSKMAP;
  map.key_size = 4;
  map.value_size = 4;
  map.max_entries = 1;
  int map_fd = (int)syscall(__NR_bpf, BPF_MAP_CREATE, &map, sizeof(map));
  step("create the XSKMAP (needed to receive)", map_fd >= 0);

  struct bpf_insn insns[2];
  memset(insns, 0, sizeof(insns));
  insns[0].code = BPF_ALU64 | BPF_MOV | BPF_K; /* r0 = XDP_PASS */
  insns[0].dst_reg = BPF_REG_0;
  insns[0].imm = XDP_PASS;
  insns[1].code = BPF_JMP | BPF_EXIT;
  union bpf_attr prog;
  memset(&prog, 0, sizeof(prog));
  prog.prog_type = BPF_PROG_TYPE_XDP;
  prog.insns = (unsigned long long)insns;
  prog.insn_cnt = 2;
  prog.license = (unsigned long long)"GPL";
  int prog_fd = (int)syscall(__NR_bpf, BPF_PROG_LOAD, &prog, sizeof(prog));
  step("load an XDP program (needed to receive)", prog_fd >= 0);

  int receive = map_fd >= 0 && prog_fd >= 0;
  printf("\nresult: this environment %s receive packets through AF_XDP\n", receive ? "can" : "CANNOT");
  return receive ? 0 : 1;
}
