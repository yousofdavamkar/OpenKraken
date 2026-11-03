package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
)

// A non-*os.File writer makes exec.Wait retain ownership while descendants still
// hold stdout/stderr. It streams bytes without collecting command output.
type supervisedOutput struct{ file *os.File }

func (output supervisedOutput) Write(data []byte) (int, error) { return output.file.Write(data) }

func runSupervised(args []string) int {
	if len(args) < 2 {
		return 125
	}
	parent, err := strconv.Atoi(args[0])
	if err != nil || parent <= 1 || os.Getppid() != parent {
		return 125
	}
	finish, err := armSupervisor(parent)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Native process supervision is unavailable")
		return 125
	}
	command := exec.Command(args[1], args[2:]...)
	configureSupervisedCommand(command)
	command.Stdin = os.Stdin
	command.Stdout = supervisedOutput{os.Stdout}
	command.Stderr = supervisedOutput{os.Stderr}
	code := 0
	if err := command.Run(); err != nil {
		if exited, ok := err.(*exec.ExitError); ok {
			code = exited.ExitCode()
			if code < 0 {
				code = 128
			}
		} else {
			fmt.Fprintln(os.Stderr, "Could not start or stream the supervised command")
			code = 125
		}
	}
	finish(code)
	return code
}
