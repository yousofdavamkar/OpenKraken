package main

import (
	"errors"
	"os/exec"
	"syscall"
	"unsafe"
)

type jobBasicLimits struct {
	ProcessTime, JobTime                 int64
	Flags                                uint32
	MinimumWorkingSet, MaximumWorkingSet uintptr
	ActiveProcesses                      uint32
	Affinity                             uintptr
	Priority, Scheduling                 uint32
}
type jobExtendedLimits struct {
	Basic                                          jobBasicLimits
	IO                                             [6]uint64
	ProcessMemory, JobMemory, PeakProcess, PeakJob uintptr
}

func configureSupervisedCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

func processCreated(handle syscall.Handle) (uint64, error) {
	var creation, exit, kernel, user syscall.Filetime
	if err := syscall.GetProcessTimes(handle, &creation, &exit, &kernel, &user); err != nil {
		return 0, err
	}
	return uint64(creation.HighDateTime)<<32 | uint64(creation.LowDateTime), nil
}

func armSupervisor(parent int) (func(int), error) {
	parentHandle, err := syscall.OpenProcess(0x00100000|0x1000, false, uint32(parent))
	if err != nil {
		return nil, err
	}
	current, err := syscall.GetCurrentProcess()
	if err != nil {
		syscall.CloseHandle(parentHandle)
		return nil, err
	}
	parentCreated, parentErr := processCreated(parentHandle)
	ownCreated, ownErr := processCreated(current)
	status, waitErr := syscall.WaitForSingleObject(parentHandle, 0)
	if parentErr != nil || ownErr != nil || parentCreated > ownCreated || waitErr != nil || status != 258 {
		syscall.CloseHandle(parentHandle)
		return nil, errors.New("parent is unavailable or its process ID was reused")
	}
	kernel := syscall.NewLazyDLL("kernel32.dll")
	createJob := kernel.NewProc("CreateJobObjectW")
	setLimits := kernel.NewProc("SetInformationJobObject")
	assign := kernel.NewProc("AssignProcessToJobObject")
	terminate := kernel.NewProc("TerminateJobObject")
	job, _, err := createJob.Call(0, 0)
	if job == 0 {
		syscall.CloseHandle(parentHandle)
		return nil, err
	}
	limits := jobExtendedLimits{}
	limits.Basic.Flags = 0x2000 // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
	ok, _, err := setLimits.Call(job, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		syscall.CloseHandle(syscall.Handle(job))
		syscall.CloseHandle(parentHandle)
		return nil, err
	}
	// Join before starting Git, so every ordinary descendant inherits the job.
	ok, _, err = assign.Call(job, uintptr(current))
	if ok == 0 {
		syscall.CloseHandle(syscall.Handle(job))
		syscall.CloseHandle(parentHandle)
		return nil, err
	}
	finish := func(code int) {
		// The helper is a member too. Terminating the job preserves the chosen
		// exit code and also covers descendants whose streams are already closed.
		terminate.Call(job, uintptr(uint32(code)))
	}
	go func() {
		// The open handle retains process identity, independent of PID reuse.
		syscall.WaitForSingleObject(parentHandle, 0xffffffff)
		finish(125)
	}()
	return finish, nil
}
