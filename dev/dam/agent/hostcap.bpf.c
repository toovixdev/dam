//go:build ignore

// TooVix DAM Agent — host (eBPF) capture.
//
// Uprobes on OpenSSL's SSL_read/SSL_write capture *plaintext* database traffic
// BELOW TLS: the DB server (mysqld/postgres) hands libssl the cleartext to
// encrypt (SSL_write) and libssl hands the server the decrypted bytes it read
// (SSL_read). By hooking those calls we see the wire protocol in the clear even
// when the client negotiated TLS — the one thing passive network capture can't do.
//
// On the *server* process the directions invert vs. a client:
//   SSL_read  → bytes the server received  = client→server = the SQL query
//   SSL_write → bytes the server is sending = server→client = the result set
// so userspace feeds SSL_read into the query decoder and SSL_write into the
// response parser (the same decoders the network agent uses).
//
// Only user memory is touched (no kernel struct reads) → no CO-RE/vmlinux.h and
// no BTF needed at build time; the object is portable across kernels.

#include <linux/bpf.h>
#include <asm/ptrace.h> // full struct pt_regs for the target arch (BPF_UPROBE arg macros)
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

char LICENSE[] SEC("license") = "GPL";

#define MAX_DATA 16384
#define TASK_COMM_LEN 16
// offsetof is provided by bpf_helpers.h

enum evt_dir { DIR_READ = 0, DIR_WRITE = 1, DIR_CLOSE = 2 };

// Wire layout is parsed byte-offset by userspace; keep field order/sizes stable.
struct ssl_event {
	__u32 pid;   // process id (tgid)
	__u32 tid;   // thread id
	__u64 ssl;   // SSL* — identifies the TLS connection (reassembly key)
	__u32 len;   // bytes of data that follow (<= MAX_DATA-1)
	__u8  dir;   // enum evt_dir
	__u8  truncated;
	char  comm[TASK_COMM_LEN];
	__u8  data[MAX_DATA];
};

struct {
	__uint(type, BPF_MAP_TYPE_RINGBUF);
	__uint(max_entries, 1 << 24); // 16 MiB
} events SEC(".maps");

// SSL_read args stashed at entry (uprobe), read at return (uretprobe) — keyed
// per-thread so concurrent backends don't clobber each other.
struct read_args {
	__u64 ssl;
	__u64 buf;
};
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, 10240);
	__type(key, __u64); // pid_tgid
	__type(value, struct read_args);
} active_reads SEC(".maps");

// Single-entry filter: only emit for processes whose comm matches (e.g. "mysqld",
// "postgres"). Empty (want[0]==0) disables the filter (emit for everything).
struct {
	__uint(type, BPF_MAP_TYPE_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, char[TASK_COMM_LEN]);
} target_comm SEC(".maps");

// The event is far larger than the 512-byte BPF stack, so it is built in a
// per-CPU scratch slot and copied to the ring buffer by exact length.
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 1);
	__type(key, __u32);
	__type(value, struct ssl_event);
} scratch SEC(".maps");

static __always_inline int comm_matches(const char *comm)
{
	__u32 z = 0;
	char *want = bpf_map_lookup_elem(&target_comm, &z);
	if (!want)
		return 0;
	if (want[0] == 0) // empty filter → match all
		return 1;
#pragma unroll
	for (int i = 0; i < TASK_COMM_LEN; i++) {
		if (want[i] != comm[i])
			return 0;
		if (want[i] == 0)
			break;
	}
	return 1;
}

static __always_inline void submit(__u64 ssl, const void *buf, __s64 count, __u8 dir)
{
	if (dir != DIR_CLOSE && count <= 0)
		return;

	__u32 z = 0;
	struct ssl_event *e = bpf_map_lookup_elem(&scratch, &z);
	if (!e)
		return;

	bpf_get_current_comm(&e->comm, sizeof(e->comm));
	if (!comm_matches(e->comm))
		return;

	__u64 id = bpf_get_current_pid_tgid();
	e->pid = id >> 32;
	e->tid = (__u32)id;
	e->ssl = ssl;
	e->dir = dir;
	e->truncated = 0;

	__u32 cap = 0;
	if (dir != DIR_CLOSE) {
		cap = (__u32)count;
		if (cap > MAX_DATA - 1) {
			cap = MAX_DATA - 1;
			e->truncated = 1;
		}
		if (buf && cap > 0)
			bpf_probe_read_user(&e->data, cap, buf);
	}
	e->len = cap;

	__u64 sz = offsetof(struct ssl_event, data) + cap;
	bpf_ringbuf_output(&events, e, sz, 0);
}

SEC("uprobe/SSL_write")
int BPF_UPROBE(uprobe_ssl_write, void *ssl, const void *buf, int num)
{
	submit((__u64)ssl, buf, num, DIR_WRITE);
	return 0;
}

SEC("uprobe/SSL_read")
int BPF_UPROBE(uprobe_ssl_read, void *ssl, void *buf, int num)
{
	__u64 id = bpf_get_current_pid_tgid();
	struct read_args a = {.ssl = (__u64)ssl, .buf = (__u64)buf};
	bpf_map_update_elem(&active_reads, &id, &a, BPF_ANY);
	return 0;
}

SEC("uretprobe/SSL_read")
int BPF_URETPROBE(uretprobe_ssl_read, int ret)
{
	__u64 id = bpf_get_current_pid_tgid();
	struct read_args *a = bpf_map_lookup_elem(&active_reads, &id);
	if (!a)
		return 0;
	if (ret > 0)
		submit(a->ssl, (void *)a->buf, ret, DIR_READ);
	bpf_map_delete_elem(&active_reads, &id);
	return 0;
}

// SSL_free marks a connection gone so userspace can drop its reassembly state.
SEC("uprobe/SSL_free")
int BPF_UPROBE(uprobe_ssl_free, void *ssl)
{
	submit((__u64)ssl, 0, 0, DIR_CLOSE);
	return 0;
}
