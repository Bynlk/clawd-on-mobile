package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/signal"
	"syscall"
)

const maxConfigBytes = 64 * 1024

type tunnelRuntime interface {
	DialContext(context.Context, string, string) (net.Conn, error)
	Done() <-chan struct{}
	Close() error
}

type forwarderRuntime interface {
	Addr() string
	Wait() error
	Close() error
}

type runDependencies struct {
	startTunnel    func(Config) (tunnelRuntime, error)
	startForwarder func(context.Context, DialContextFunc, string) (forwarderRuntime, error)
}

type statusRecord struct {
	Type      string `json:"type"`
	Listen    string `json:"listen,omitempty"`
	Status    string `json:"status,omitempty"`
	ErrorCode string `json:"errorCode,omitempty"`
}

func main() {
	os.Exit(realMain())
}

func realMain() int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.Signal(15))
	defer stop()
	return run(ctx, os.Stdin, os.Stdout, runDependencies{})
}

func run(parent context.Context, stdin io.Reader, stdout io.Writer, dependencies runDependencies) int {
	config, err := readConfigStream(parent, stdin)
	if err != nil {
		if parent.Err() != nil {
			return 0
		}
		_ = emitError(stdout, errorCode(err, "invalid_config"))
		return 1
	}
	if parent.Err() != nil {
		return 0
	}
	if dependencies.startTunnel == nil {
		dependencies.startTunnel = func(config Config) (tunnelRuntime, error) {
			return StartTunnel(parent, config)
		}
	}
	if dependencies.startForwarder == nil {
		dependencies.startForwarder = func(ctx context.Context, dial DialContextFunc, target string) (forwarderRuntime, error) {
			return StartForwarder(ctx, dial, target)
		}
	}

	runtimeContext, cancelRuntime := context.WithCancel(parent)
	defer cancelRuntime()

	if closer, ok := stdin.(io.Closer); ok {
		defer closer.Close()
	}

	tunnel, err := dependencies.startTunnel(config)
	if err != nil {
		if parent.Err() != nil {
			return 0
		}
		_ = emitError(stdout, errorCode(err, "device_start_failed"))
		return 1
	}
	defer tunnel.Close()
	if parent.Err() != nil {
		return 0
	}

	forwarder, err := dependencies.startForwarder(runtimeContext, tunnel.DialContext, config.ForwardAddress)
	if err != nil {
		_ = emitError(stdout, errorCode(err, "listen_failed"))
		return 1
	}
	defer forwarder.Close()
	if parent.Err() != nil {
		return 0
	}

	if err := emitStatus(stdout, statusRecord{Type: "ready", Listen: forwarder.Addr()}); err != nil {
		return 1
	}

	forwarderDone := make(chan error, 1)
	go func() { forwarderDone <- forwarder.Wait() }()

	select {
	case <-parent.Done():
		return 0
	case <-tunnel.Done():
		if parent.Err() != nil || runtimeContext.Err() != nil {
			return 0
		}
		_ = emitError(stdout, "device_stopped")
		return 1
	case waitErr := <-forwarderDone:
		if parent.Err() != nil || runtimeContext.Err() != nil {
			return 0
		}
		if waitErr == nil {
			_ = emitError(stdout, "listener_stopped")
			return 1
		}
		_ = emitError(stdout, errorCode(waitErr, "listener_failed"))
		return 1
	}
}

func readConfigStream(ctx context.Context, input io.Reader) (Config, error) {
	type readResult struct {
		config Config
		err    error
	}
	result := make(chan readResult)
	go func() {
		config, err := readConfigStreamUninterruptible(input)
		select {
		case result <- readResult{config: config, err: err}:
		case <-ctx.Done():
		}
	}()
	select {
	case completed := <-result:
		return completed.config, completed.err
	case <-ctx.Done():
		if closer, ok := input.(io.Closer); ok {
			_ = closer.Close()
		}
		return Config{}, ctx.Err()
	}
}

func readConfigStreamUninterruptible(input io.Reader) (Config, error) {
	payload, err := io.ReadAll(io.LimitReader(input, maxConfigBytes+1))
	if err != nil {
		return Config{}, &configError{code: "stdin_failed"}
	}
	if len(payload) > maxConfigBytes {
		return Config{}, &configError{code: "invalid_json"}
	}
	return ParseConfig(bytes.NewReader(payload))
}

func emitError(output io.Writer, code string) error {
	return emitStatus(output, statusRecord{Type: "error", Status: "failed", ErrorCode: code})
}

func emitStatus(output io.Writer, status statusRecord) error {
	return json.NewEncoder(output).Encode(status)
}

func errorCode(err error, fallback string) string {
	type codedError interface {
		ErrorCode() string
	}
	var coded codedError
	if errors.As(err, &coded) && coded.ErrorCode() != "" {
		return coded.ErrorCode()
	}
	return fallback
}
