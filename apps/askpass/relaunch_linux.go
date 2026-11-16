package main

import (
	"bufio"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// This mode proves readiness before shutdown, then waits for explicit arming.
// It runs from the private profile, outside the retiring AppImage mount, and
// never interprets a shell command.
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
	// Keep the directory inode reserved until supervision ends. A later installation
	// of the same versions can have a journal with exactly the same bytes.
	folderPath := args[1] + ".openkraken-update"
	folder, folderErr := os.OpenFile(folderPath, os.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW, 0)
	var originalFolder os.FileInfo
	if folderErr == nil {
		defer folder.Close()
		originalFolder, folderErr = folder.Stat()
	}
	if folderErr != nil && !os.IsNotExist(folderErr) {
		return 125
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
	// The parent owns the write end while committing the update. EOF means
	// the commit finished or the parent died. In either case its actual exit
	// is still required before launching or recovering an image.
	if _, err := reader.ReadByte(); err != io.EOF {
		return 125
	}
	deadline := time.Now().Add(20 * time.Second)
	for os.Getppid() == parent {
		if time.Now().After(deadline) {
			return 125
		}
		time.Sleep(10 * time.Millisecond)
	}
	current, err := os.Lstat(folderPath)
	if err == nil {
		if originalFolder == nil || !os.SameFile(originalFolder, current) {
			return 125
		}
	} else if !os.IsNotExist(err) || originalFolder != nil {
		return 125
	}
	restore := func(beforeRename bool) int {
		return reopenPredecessor(args[1], args[2], args[3], size, args[5], previousSize, args[7], beforeRename, originalFolder)
	}
	if _, ok := restartVerifiedFile(args[1], args[3], size, 1, false); !ok {
		return restore(true)
	}
	commandToRun := restartCommand(args[1], args[2], false)
	if commandToRun.Start() != nil {
		return restore(false)
	}
	finished := make(chan struct{})
	var exited <-chan struct{} = finished
	go func() { _ = commandToRun.Wait(); close(finished) }()
	launcherExited := false
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(60 * time.Second)
	defer timeout.Stop()
	slow := false
	for {
		select {
		case <-ticker.C:
		case <-timeout.C:
			// A slow start may still confirm, or the user may close the stalled app.
			// Retain the group identity and check less frequently until either happens.
			slow = true
			ticker.Reset(2 * time.Second)
		case <-exited:
			launcherExited = true
			exited = nil
		}
		current, err := os.Lstat(folderPath)
		if os.IsNotExist(err) {
			return 0
		}
		if err != nil || originalFolder == nil || !os.SameFile(originalFolder, current) {
			return 125
		}
		if launcherExited {
			switch inspectRestartGroup() {
			case restartGroupEmpty:
				return restore(false)
			case restartGroupUnknown:
				if slow {
					return 125
				}
			}
		}
	}
}
