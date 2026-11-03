package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

type request struct {
	Token  string `json:"token"`
	Prompt string `json:"prompt"`
	Hint   string `json:"hint"`
}
type response struct {
	OK     bool   `json:"ok"`
	Answer string `json:"answer"`
}

func run() int {
	if len(os.Args) == 3 && os.Args[1] == "--editor" {
		return runEditor(os.Args[2])
	}
	if len(os.Args) != 2 || len(os.Args[1]) > 16384 || !utf8.ValidString(os.Args[1]) {
		return 1
	}
	token := os.Getenv("OPENKRAKEN_ASKPASS_TOKEN")
	decoded, err := hex.DecodeString(token)
	if err != nil || len(decoded) != 32 {
		return 1
	}
	conn, err := connect(os.Getenv("OPENKRAKEN_ASKPASS_SOCKET"))
	if err != nil {
		return 1
	}
	defer conn.Close()
	hint := ""
	if os.Getenv("SSH_ASKPASS_PROMPT") == "confirm" {
		hint = "confirm"
	}
	if err = json.NewEncoder(conn).Encode(request{token, os.Args[1], hint}); err != nil {
		return 1
	}
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 1024), 32768)
	if !scanner.Scan() {
		return 1
	}
	var reply response
	if json.Unmarshal(scanner.Bytes(), &reply) != nil || !reply.OK || len(reply.Answer) > 16384 || !utf8.ValidString(reply.Answer) || strings.ContainsAny(reply.Answer, "\x00\r\n") {
		return 1
	}
	if _, err = fmt.Fprintln(os.Stdout, reply.Answer); err != nil {
		return 1
	}
	return 0
}
func main() {
	if len(os.Args) > 1 && os.Args[1] == "--supervise" {
		os.Exit(runSupervised(os.Args[2:]))
	}
	result := make(chan int, 1)
	go func() { result <- run() }()
	select {
	case code := <-result:
		os.Exit(code)
	case <-time.After(3 * time.Minute):
		os.Exit(1)
	}
}
