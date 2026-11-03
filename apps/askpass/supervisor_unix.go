//go:build !windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
	"time"
)

func configureSupervisedCommand(command *exec.Cmd) {}

func armSupervisor(parent int) (func(int), error) {
	group, err := syscall.Getpgid(0)
	if err != nil || group != os.Getpid() || os.Getppid() != parent {
		return nil, errors.New("supervisor requires its own process group and a live parent")
	}
	// A broken output pipe must not kill the supervisor before it cleans up Git.
	signal.Ignore(syscall.SIGPIPE)
	stopping := make(chan os.Signal, 1)
	signal.Notify(stopping, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	done := make(chan struct{})
	kill := func() {
		// This process is still the group leader, so its group ID cannot be reused.
		_ = syscall.Kill(-os.Getpid(), syscall.SIGKILL)
		os.Exit(125)
	}
	go func() {
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
	selectLoop:
		for {
			select {
			case <-done:
				break selectLoop
			case <-ticker.C:
				if os.Getppid() != parent {
					kill()
				}
			case <-stopping:
				// The group has already received the signal from the runner. Keep
				// this leader alive long enough to kill descendants that ignore it.
				select {
				case <-done:
					return
				case <-time.After(100 * time.Millisecond):
					kill()
				}
			}
		}
	}()
	return func(code int) {
		if os.Getppid() != parent {
			kill()
		}
		close(done)
		signal.Stop(stopping)
	}, nil
}
