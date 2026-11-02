package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"unicode/utf8"
)

// The service validates and writes the requested file. The helper only acknowledges success.
func runEditor(path string) int {
	if len(path) == 0 || len(path) > 16384 || !utf8.ValidString(path) || strings.ContainsRune(path, '\x00') {
		return 1
	}
	token := os.Getenv("OPENKRAKEN_EDITOR_TOKEN")
	decoded, err := hex.DecodeString(token)
	if err != nil || len(decoded) != 32 {
		return 1
	}
	conn, err := connect(os.Getenv("OPENKRAKEN_EDITOR_SOCKET"))
	if err != nil {
		return 1
	}
	defer conn.Close()
	if json.NewEncoder(conn).Encode(struct {
		Token string `json:"token"`
		Path  string `json:"path"`
	}{token, path}) != nil {
		return 1
	}
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 128), 1024)
	if !scanner.Scan() {
		return 1
	}
	var reply struct {
		OK bool `json:"ok"`
	}
	if json.Unmarshal(scanner.Bytes(), &reply) != nil || !reply.OK {
		return 1
	}
	return 0
}
