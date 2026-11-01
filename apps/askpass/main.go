package main

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
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
	if len(os.Args) != 2 || len(os.Args[1]) > 16384 || !utf8.ValidString(os.Args[1]) {
		return 1
	}
	address := os.Getenv("OPENKRAKEN_ASKPASS_ADDRESS")
	host, _, err := net.SplitHostPort(address)
	if err != nil || host != "127.0.0.1" {
		return 1
	}
	token := os.Getenv("OPENKRAKEN_ASKPASS_TOKEN")
	decoded, err := hex.DecodeString(token)
	if err != nil || len(decoded) != 32 {
		return 1
	}
	conn, err := net.DialTimeout("tcp4", address, 3*time.Second)
	if err != nil {
		return 1
	}
	defer conn.Close()
	if err = conn.SetDeadline(time.Now().Add(3 * time.Minute)); err != nil {
		return 1
	}
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
func main() { os.Exit(run()) }
