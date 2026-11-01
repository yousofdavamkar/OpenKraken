//go:build !windows

package main

import (
	"errors"
	"io"
	"net"
	"path/filepath"
	"time"
)

func connect(path string) (io.ReadWriteCloser, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("invalid socket")
	}
	return net.DialTimeout("unix", path, 3*time.Second)
}
