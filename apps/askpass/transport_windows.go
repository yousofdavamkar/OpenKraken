package main

import (
	"errors"
	"io"
	"os"
	"strings"
)

func connect(path string) (io.ReadWriteCloser, error) {
	if !strings.HasPrefix(path, `\\.\pipe\openkraken-`) || strings.ContainsAny(strings.TrimPrefix(path, `\\.\pipe\`), `\/`) {
		return nil, errors.New("invalid pipe")
	}
	return os.OpenFile(path, os.O_RDWR, 0)
}
