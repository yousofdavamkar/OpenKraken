package main

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func restartSame(a, b os.FileInfo) bool {
	left, leftOK := a.Sys().(*syscall.Stat_t)
	right, rightOK := b.Sys().(*syscall.Stat_t)
	return leftOK && rightOK && os.SameFile(a, b) && a.Size() == b.Size() && a.Mode() == b.Mode() && a.ModTime().Equal(b.ModTime()) && left.Ctim == right.Ctim && left.Nlink == right.Nlink
}

func restartVerifiedFile(path, expected string, size int64, links uint64, private bool) (os.FileInfo, bool) {
	info, err := os.Lstat(path)
	mask := os.FileMode(0022)
	if private {
		mask = 0077
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&mask != 0 || info.Size() != size {
		return nil, false
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(owner.Uid) != os.Getuid() || uint64(owner.Nlink) != links {
		return nil, false
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, false
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !restartSame(info, opened) {
		return nil, false
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(file, size+1))
	after, statErr := os.Lstat(path)
	if err != nil || count != size || statErr != nil || !restartSame(info, after) || hex.EncodeToString(hash.Sum(nil)) != expected {
		return nil, false
	}
	return info, true
}

func restartCommand(target, profile string, detached bool) *exec.Cmd {
	command := exec.Command(target, "--user-data-dir="+profile)
	command.Dir = filepath.Dir(target)
	for _, value := range os.Environ() {
		name, _, _ := strings.Cut(value, "=")
		if name != "APPIMAGE" && name != "APPDIR" && name != "ARGV0" && name != "OWD" {
			command.Env = append(command.Env, value)
		}
	}
	if detached {
		command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	}
	return command
}

type restartGroupState int

const (
	restartGroupUnknown restartGroupState = iota
	restartGroupRunning
	restartGroupEmpty
)

// The helper remains its group leader, preventing reuse of this group identity.
// Ordinary replacement descendants must be gone before a recovery rename.
func inspectRestartGroup() restartGroupState {
	folder, err := os.Open("/proc")
	if err != nil {
		return restartGroupUnknown
	}
	names, err := folder.Readdirnames(131073)
	folder.Close()
	if (err != nil && err != io.EOF) || len(names) > 131072 {
		return restartGroupUnknown
	}
	for _, name := range names {
		pid, err := strconv.Atoi(name)
		if err != nil || pid == os.Getpid() {
			continue
		}
		group, err := syscall.Getpgid(pid)
		if err == syscall.ESRCH {
			continue
		}
		if err != nil {
			return restartGroupUnknown
		}
		if group != os.Getpid() {
			continue
		}
		file, err := os.Open(filepath.Join("/proc", name, "stat"))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return restartGroupUnknown
		}
		data, err := io.ReadAll(io.LimitReader(file, 4097))
		file.Close()
		if err != nil || len(data) > 4096 {
			return restartGroupUnknown
		}
		end := strings.LastIndex(string(data), ")")
		if end < 0 {
			return restartGroupUnknown
		}
		fields := strings.Fields(string(data[end+1:]))
		if len(fields) < 3 {
			return restartGroupUnknown
		}
		if fields[0] != "Z" && fields[0] != "X" && fields[0] != "x" {
			return restartGroupRunning
		}
	}
	return restartGroupEmpty
}

func restartDirectory(path string, private bool) bool {
	info, err := os.Lstat(path)
	mask := os.FileMode(0022)
	if private {
		mask = 0077
	}
	if err != nil || !info.IsDir() || info.Mode().Perm()&mask != 0 {
		return false
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	return ok && int(owner.Uid) == os.Getuid()
}

func restartSync(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	return file.Sync() == nil
}

// After the rename, restore from the backup. Before the rename, the installed
// predecessor must still be the backup's other hard link. Launch it in place.
func reopenPredecessor(target, profile, nextHash string, nextSize int64, previousHash string, previousSize int64, journalHash string, beforeRename bool, originalFolder os.FileInfo) int {
	folder := target + ".openkraken-update"
	if !restartDirectory(filepath.Dir(target), false) || !restartDirectory(folder, true) || inspectRestartGroup() != restartGroupEmpty {
		return 125
	}
	folderBefore, folderErr := os.Lstat(folder)
	parentBefore, parentErr := os.Lstat(filepath.Dir(target))
	if folderErr != nil || parentErr != nil || originalFolder == nil || !os.SameFile(originalFolder, folderBefore) {
		return 125
	}
	directory, err := os.Open(folder)
	if err != nil {
		return 125
	}
	replacement := target
	backupLinks := uint64(1)
	entryCount := 2
	if beforeRename {
		replacement = filepath.Join(folder, "next.AppImage")
		backupLinks = 2
		entryCount = 3
	}
	// All expected entries are opened by name below; reject extra entries.
	names, err := directory.Readdirnames(entryCount + 1)
	directory.Close()
	if (err != nil && err != io.EOF) || len(names) != entryCount {
		return 125
	}
	journal := filepath.Join(folder, "transaction.json")
	info, err := os.Lstat(journal)
	if err != nil || info.Size() < 1 || info.Size() > 4096 {
		return 125
	}
	journalBefore, ok := restartVerifiedFile(journal, journalHash, info.Size(), 1, true)
	if !ok {
		return 125
	}
	current, ok := restartVerifiedFile(replacement, nextHash, nextSize, 1, beforeRename)
	if !ok {
		return 125
	}
	backup := filepath.Join(folder, "previous.AppImage")
	previous, ok := restartVerifiedFile(backup, previousHash, previousSize, backupLinks, false)
	if !ok {
		return 125
	}
	if inspectRestartGroup() != restartGroupEmpty {
		return 125
	}
	verified := map[string]os.FileInfo{replacement: current, backup: previous, journal: journalBefore, folder: folderBefore, filepath.Dir(target): parentBefore}
	if beforeRename {
		verified[target] = previous
	}
	for path, before := range verified {
		after, err := os.Lstat(path)
		if err != nil {
			return 125
		}
		same := restartSame(before, after)
		if path == filepath.Dir(target) {
			left, right := before.Sys().(*syscall.Stat_t), after.Sys().(*syscall.Stat_t)
			same = os.SameFile(before, after) && before.Mode() == after.Mode() && left.Uid == right.Uid
		}
		if !same {
			return 125
		}
	}
	if !beforeRename {
		if os.Rename(backup, target) != nil {
			return 125
		}
		parentSynced := restartSync(filepath.Dir(target))
		folderSynced := restartSync(folder)
		if !parentSynced || !folderSynced {
			// The rename already restored the predecessor. Its startup retries both
			// syncs before clearing the journal. Recheck the installed file first.
			restored, ok := restartVerifiedFile(target, previousHash, previousSize, 1, false)
			if !ok || !os.SameFile(previous, restored) || !restartDirectory(filepath.Dir(target), false) {
				return 125
			}
		}
		restartRestorationNotice(profile)
	}
	// Leave the journal for the restored app's normal startup recovery. No retry loop.
	command := restartCommand(target, profile, true)
	if command.Start() != nil {
		return 125
	}
	command.Process.Release()
	return 0
}

func restartRestorationNotice(profile string) {
	folder := filepath.Join(profile, "updates")
	if !restartDirectory(folder, true) {
		return
	}
	target := filepath.Join(folder, "rollback-notice.json")
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		return
	}
	temporary := filepath.Join(folder, "rollback-notice.tmp")
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return
	}
	_, err = file.WriteString(`{"schemaVersion":1,"outcome":"restored"}`)
	if err == nil {
		err = file.Sync()
	}
	file.Close()
	if err != nil {
		return
	}
	if _, err := os.Lstat(target); !os.IsNotExist(err) {
		return
	}
	if os.Rename(temporary, target) == nil {
		restartSync(folder)
	}
}
