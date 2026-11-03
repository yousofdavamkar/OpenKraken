package main

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// This mode is launched only after accepted shutdown. It runs from the private
// profile, outside the retiring AppImage mount, and never interprets a shell command.
func runRelaunch(args []string) int {
	if len(args) != 8 {
		return 125
	}
	parent, err := strconv.Atoi(args[0])
	size, sizeErr := strconv.ParseInt(args[4], 10, 64)
	expected, hashErr := hex.DecodeString(args[3])
	previousSize, previousSizeErr := strconv.ParseInt(args[6], 10, 64)
	previousHash, previousHashErr := hex.DecodeString(args[5])
	journalHash, journalHashErr := hex.DecodeString(args[7])
	group, groupErr := syscall.Getpgid(0)
	if err != nil || parent <= 1 || os.Getppid() != parent || sizeErr != nil || size < 1 || size > 2<<30 || hashErr != nil || len(expected) != 32 || previousSizeErr != nil || previousSize < 1 || previousSize > 2<<30 || previousHashErr != nil || len(previousHash) != 32 || journalHashErr != nil || len(journalHash) != 32 || groupErr != nil || group != os.Getpid() {
		return 125
	}
	for _, path := range args[1:3] {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || strings.ContainsRune(path, 0) {
			return 125
		}
	}
	signal.Ignore(syscall.SIGHUP)
	if _, err := fmt.Fprintln(os.Stdout, "ready"); err != nil {
		return 125
	}
	reader := bufio.NewReaderSize(os.Stdin, 16)
	command, err := reader.ReadSlice('\n')
	if err != nil || string(command) != "launch\n" {
		return 125
	}
	if _, err := fmt.Fprintln(os.Stdout, "armed"); err != nil {
		return 125
	}
	deadline := time.Now().Add(20 * time.Second)
	for os.Getppid() == parent {
		if time.Now().After(deadline) {
			return 125
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, ok := restartVerifiedFile(args[1], args[3], size, false); !ok {
		return 125
	}
	commandToRun := restartCommand(args[1], args[2], false)
	if commandToRun.Start() != nil {
		return restoreFailedRestart(args[1], args[2], args[3], size, args[5], previousSize, args[7])
	}
	exited := make(chan struct{})
	go func() { _ = commandToRun.Wait(); close(exited) }()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(60 * time.Second)
	defer timeout.Stop()
	for {
		select {
		case <-ticker.C:
			if restartConfirmed(args[1]) {
				return 0
			}
		case <-timeout.C:
			// A running, unconfirmed application is not safe to replace.
			return 125
		case <-exited:
			if restartConfirmed(args[1]) {
				return 0
			}
			until := time.Now().Add(2 * time.Second)
			for !restartGroupIdle() {
				if restartConfirmed(args[1]) {
					return 0
				}
				if time.Now().After(until) {
					return 125
				}
				time.Sleep(25 * time.Millisecond)
			}
			return restoreFailedRestart(args[1], args[2], args[3], size, args[5], previousSize, args[7])
		}
	}
}
