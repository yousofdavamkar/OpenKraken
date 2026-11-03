package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
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
	if len(args) != 5 {
		return 125
	}
	parent, err := strconv.Atoi(args[0])
	size, sizeErr := strconv.ParseInt(args[4], 10, 64)
	expected, hashErr := hex.DecodeString(args[3])
	if err != nil || parent <= 1 || os.Getppid() != parent || sizeErr != nil || size < 1 || size > 2<<30 || hashErr != nil || len(expected) != 32 {
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
	info, err := os.Lstat(args[1])
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0022 != 0 || info.Size() != size {
		return 125
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(owner.Uid) != os.Getuid() || owner.Nlink != 1 {
		return 125
	}
	file, err := os.Open(args[1])
	if err != nil {
		return 125
	}
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		file.Close()
		return 125
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(file, size+1))
	file.Close()
	after, statErr := os.Lstat(args[1])
	if err != nil || count != size || statErr != nil || !os.SameFile(info, after) || !info.ModTime().Equal(after.ModTime()) || hex.EncodeToString(hash.Sum(nil)) != args[3] {
		return 125
	}
	commandToRun := exec.Command(args[1], "--user-data-dir="+args[2])
	commandToRun.Dir = filepath.Dir(args[1])
	for _, value := range os.Environ() {
		name, _, _ := strings.Cut(value, "=")
		if name != "APPIMAGE" && name != "APPDIR" && name != "ARGV0" && name != "OWD" {
			commandToRun.Env = append(commandToRun.Env, value)
		}
	}
	commandToRun.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if commandToRun.Start() != nil {
		return 125
	}
	commandToRun.Process.Release()
	return 0
}
