//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const winServiceName = "TooVixDAMAgent"

// platformMain adapts the agent to Windows. With a subcommand it manages the service
// (install / uninstall / start / stop). With no args it either runs under the Service Control
// Manager (when launched by the SCM) or in the foreground (from a console).
func platformMain(run func()) {
	if len(os.Args) > 1 {
		var err error
		cmd := os.Args[1]
		switch cmd {
		case "install":
			err = winInstall()
		case "uninstall", "remove":
			err = winUninstall()
		case "start":
			err = winStart()
		case "stop":
			err = winStop()
		default:
			log.Fatalf("unknown command %q — use: install | uninstall | start | stop (or run with no args)", cmd)
		}
		if err != nil {
			log.Fatalf("%s: %v", cmd, err)
		}
		log.Printf("%s: ok", cmd)
		return
	}

	isSvc, err := svc.IsWindowsService()
	if err != nil {
		log.Fatalf("could not determine service context: %v", err)
	}
	if !isSvc {
		run() // foreground / console (useful for a manual test run)
		return
	}
	setupServiceLogging() // no stderr under the SCM — log to a file
	if err := svc.Run(winServiceName, &damService{run: run}); err != nil {
		log.Fatalf("service failed: %v", err)
	}
}

// damService bridges the SCM control protocol to the agent's run loop.
type damService struct{ run func() }

func (s *damService) Execute(_ []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending}
	go s.run() // the agent enrolls, heartbeats, and captures for the process lifetime
	changes <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	for c := range r {
		switch c.Cmd {
		case svc.Interrogate:
			changes <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			changes <- svc.Status{State: svc.StopPending}
			log.Printf("service stop requested — exiting")
			return false, 0
		}
	}
	return false, 0
}

// setupServiceLogging redirects the agent's log to a file beside the config, since a service has
// no console. Kept append-mode so restarts don't truncate the history.
func setupServiceLogging() {
	dir := filepath.Dir(defaultEnvFilePath())
	_ = os.MkdirAll(dir, 0o755)
	f, err := os.OpenFile(filepath.Join(dir, "dam-agent.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err == nil {
		log.SetOutput(f) // intentionally left open for the process lifetime
	}
}

func winInstall() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	if s, err := m.OpenService(winServiceName); err == nil {
		s.Close()
		return fmt.Errorf("service %q is already installed", winServiceName)
	}
	s, err := m.CreateService(winServiceName, exe, mgr.Config{
		DisplayName: "TooVix DAM Agent",
		Description: "TooVix Database Activity Monitoring agent (SQL Server — audit-forward / Extended Events).",
		StartType:   mgr.StartAutomatic,
	})
	if err != nil {
		return err
	}
	defer s.Close()
	return nil
}

func winUninstall() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(winServiceName)
	if err != nil {
		return fmt.Errorf("service %q is not installed", winServiceName)
	}
	defer s.Close()
	return s.Delete()
}

func winStart() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(winServiceName)
	if err != nil {
		return fmt.Errorf("service %q is not installed", winServiceName)
	}
	defer s.Close()
	return s.Start()
}

func winStop() error {
	m, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer m.Disconnect()
	s, err := m.OpenService(winServiceName)
	if err != nil {
		return err
	}
	defer s.Close()
	st, err := s.Control(svc.Stop)
	if err != nil {
		return err
	}
	deadline := time.Now().Add(20 * time.Second)
	for st.State != svc.Stopped && time.Now().Before(deadline) {
		time.Sleep(400 * time.Millisecond)
		if st, err = s.Query(); err != nil {
			return err
		}
	}
	return nil
}
