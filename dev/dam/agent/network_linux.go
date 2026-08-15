//go:build linux

package main

import (
	"log"
	"net"
	"syscall"
)

const packetOutgoing = 4 // linux PACKET_OUTGOING (loopback delivers a tx + rx copy)

func htons(i uint16) uint16 { return (i<<8)&0xff00 | i>>8 }

// runNetwork is the passive AF_PACKET sniffer. Linux-only: AF_PACKET / SockaddrLinklayer have
// no portable equivalent, so on non-Linux platforms network capture is unavailable (see
// network_other.go). The decoders it feeds (handleFrame, frameAndDecode*) live in main.go and
// are shared with host (eBPF) mode.
func runNetwork(cfg Config) {
	iface := env("CAPTURE_IFACE", "eth0")
	// "any" (ifindex 0) sniffs ALL interfaces incl. loopback — handy when SQL is run
	// on the DB host itself (localhost connections travel over lo, not the primary NIC).
	ifIndex := 0
	if iface != "any" && iface != "" {
		ifi, err := net.InterfaceByName(iface)
		if err != nil {
			log.Fatalf("interface %s not found: %v", iface, err)
		}
		ifIndex = ifi.Index
	}
	fd, err := syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW, int(htons(0x0003))) // ETH_P_ALL
	if err != nil {
		log.Fatalf("AF_PACKET socket failed: %v (needs CAP_NET_RAW / root)", err)
	}
	defer syscall.Close(fd)
	// Large receive buffer so a burst (e.g. a big result set flooding loopback) doesn't
	// overflow the socket and drop frames — dropped frames desync the packet framer.
	// SO_RCVBUFFORCE (33) bypasses net.core.rmem_max (we hold CAP_NET_ADMIN).
	if e := syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, 33, 64*1024*1024); e != nil {
		syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_RCVBUF, 64*1024*1024)
	}
	if err := syscall.Bind(fd, &syscall.SockaddrLinklayer{Protocol: htons(0x0003), Ifindex: ifIndex}); err != nil {
		log.Fatalf("bind to %s failed: %v", iface, err)
	}
	targetPort := uint16(atoiDefault(cfg.TargetPort, 3306))
	capDebug = env("CAPTURE_DEBUG", "false") == "true"
	log.Printf("network agent sniffing %s for tcp/%d engine=%s (passive capture, debug=%v)", iface, targetPort, cfg.Engine, capDebug)

	conns := map[string]*connState{}
	// Big enough for a full IPv4 packet (65535) + link header, and for loopback GSO
	// super-segments — a too-small buffer truncates large result sets and desyncs framing.
	frame := make([]byte, 262144)
	var frames uint64
	for {
		n, from, err := syscall.Recvfrom(fd, frame, 0)
		if err != nil || n < 14 {
			continue
		}
		// On loopback, each packet is delivered twice (outgoing + incoming copy). Skip the
		// outgoing copy so we don't double-count queries/rows.
		if sll, ok := from.(*syscall.SockaddrLinklayer); ok && sll.Pkttype == packetOutgoing {
			continue
		}
		frames++
		if capDebug && frames%50 == 0 {
			log.Printf("[net-dbg] %d frames seen on %s", frames, iface)
		}
		handleFrame(cfg, frame[:n], targetPort, conns)
	}
}
