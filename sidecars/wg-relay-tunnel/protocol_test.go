package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func parsedTestConfig(t *testing.T, mutate func(map[string]any)) Config {
	t.Helper()
	config, err := ParseConfig(strings.NewReader(validConfigJSON(t, mutate)))
	if err != nil {
		t.Fatal(err)
	}
	return config
}

func TestBuildIPCConfigHasExactlyOnePeerAndAllowedIP(t *testing.T) {
	config := parsedTestConfig(t, nil)
	ipcConfig, err := buildIPCConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(ipcConfig, "public_key="); got != 1 {
		t.Fatalf("public_key count = %d, want 1", got)
	}
	if got := strings.Count(ipcConfig, "allowed_ip="); got != 1 {
		t.Fatalf("allowed_ip count = %d, want 1", got)
	}
	if !strings.Contains(ipcConfig, "allowed_ip=10.8.0.0/24\n") {
		t.Fatal("IPC config does not contain the configured AllowedIP")
	}
	if strings.Contains(ipcConfig, "0.0.0.0/0") {
		t.Fatal("IPC config contains a default route")
	}
}

func TestStartTunnelUsesUserspaceNetstack(t *testing.T) {
	config := parsedTestConfig(t, func(value map[string]any) {
		value["Endpoint"] = "127.0.0.1:51820"
	})
	tunnel, err := StartTunnel(config)
	if err != nil {
		t.Fatalf("StartTunnel() error = %v", err)
	}
	if err := tunnel.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
}

type protocolTunnel struct {
	closed    atomic.Bool
	done      chan struct{}
	closeOnce sync.Once
}

func newProtocolTunnel() *protocolTunnel {
	return &protocolTunnel{done: make(chan struct{})}
}

func (tunnel *protocolTunnel) DialContext(context.Context, string, string) (net.Conn, error) {
	return nil, errors.New("unused")
}

func (tunnel *protocolTunnel) Close() error {
	tunnel.closeOnce.Do(func() {
		tunnel.closed.Store(true)
		close(tunnel.done)
	})
	return nil
}

func (tunnel *protocolTunnel) Done() <-chan struct{} { return tunnel.done }

func (tunnel *protocolTunnel) fail() { tunnel.closeOnce.Do(func() { close(tunnel.done) }) }

type protocolForwarder struct {
	done      chan struct{}
	closeOnce sync.Once
	closed    atomic.Bool
}

func newProtocolForwarder() *protocolForwarder {
	return &protocolForwarder{done: make(chan struct{})}
}

func (forwarder *protocolForwarder) Addr() string { return "127.0.0.1:43127" }

func (forwarder *protocolForwarder) Wait() error {
	<-forwarder.done
	return nil
}

func (forwarder *protocolForwarder) Close() error {
	forwarder.closeOnce.Do(func() {
		forwarder.closed.Store(true)
		close(forwarder.done)
	})
	return nil
}

type statusRecorder struct {
	mu     sync.Mutex
	buffer bytes.Buffer
	notify chan struct{}
}

func newStatusRecorder() *statusRecorder {
	return &statusRecorder{notify: make(chan struct{}, 16)}
}

func (recorder *statusRecorder) Write(value []byte) (int, error) {
	recorder.mu.Lock()
	written, err := recorder.buffer.Write(value)
	recorder.mu.Unlock()
	select {
	case recorder.notify <- struct{}{}:
	default:
	}
	return written, err
}

func (recorder *statusRecorder) String() string {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return recorder.buffer.String()
}

func (recorder *statusRecorder) waitForType(t *testing.T, statusType string) map[string]any {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		for _, line := range strings.Split(strings.TrimSpace(recorder.String()), "\n") {
			var status map[string]any
			if json.Unmarshal([]byte(line), &status) == nil && status["type"] == statusType {
				return status
			}
		}
		select {
		case <-recorder.notify:
		case <-deadline:
			t.Fatalf("did not receive status type %q; output = %q", statusType, recorder.String())
		}
	}
}

func protocolDependencies(tunnel *protocolTunnel, forwarder *protocolForwarder) runDependencies {
	return runDependencies{
		startTunnel: func(Config) (tunnelRuntime, error) { return tunnel, nil },
		startForwarder: func(context.Context, DialContextFunc, string) (forwarderRuntime, error) {
			return forwarder, nil
		},
	}
}

func TestRunEmitsReadyAndCleansUpOnStdinEOF(t *testing.T) {
	stdinReader, stdinWriter := io.Pipe()
	tunnel := newProtocolTunnel()
	forwarder := newProtocolForwarder()
	statuses := newStatusRecorder()
	runDone := make(chan int, 1)
	go func() {
		runDone <- run(context.Background(), stdinReader, statuses, protocolDependencies(tunnel, forwarder))
	}()
	if _, err := io.WriteString(stdinWriter, validConfigJSON(t, nil)+"\n"); err != nil {
		t.Fatal(err)
	}
	ready := statuses.waitForType(t, "ready")
	if got := ready["listen"]; got != "127.0.0.1:43127" {
		t.Fatalf("ready listen = %v", got)
	}
	if err := stdinWriter.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-runDone:
		if code != 0 {
			t.Fatalf("run() = %d, want 0", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run() did not exit after stdin EOF")
	}
	if !forwarder.closed.Load() || !tunnel.closed.Load() {
		t.Fatal("run() did not clean up forwarder and tunnel")
	}
}

func TestRunAcceptsMultilineJSONAndExitsOnEOF(t *testing.T) {
	var compact map[string]any
	if err := json.Unmarshal([]byte(validConfigJSON(t, nil)), &compact); err != nil {
		t.Fatal(err)
	}
	multiline, err := json.MarshalIndent(compact, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	stdinReader, stdinWriter := io.Pipe()
	tunnel := newProtocolTunnel()
	forwarder := newProtocolForwarder()
	statuses := newStatusRecorder()
	runDone := make(chan int, 1)
	go func() {
		runDone <- run(context.Background(), stdinReader, statuses, protocolDependencies(tunnel, forwarder))
	}()
	if _, err := stdinWriter.Write(append([]byte(" \n\t"), multiline...)); err != nil {
		t.Fatal(err)
	}
	statuses.waitForType(t, "ready")
	if err := stdinWriter.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-runDone:
		if code != 0 {
			t.Fatalf("run() = %d, want 0", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run() did not exit after multiline JSON EOF")
	}
}

func TestRunEOFWithoutTrailingNewlineIsBounded(t *testing.T) {
	tunnel := newProtocolTunnel()
	forwarder := newProtocolForwarder()
	statuses := newStatusRecorder()
	runDone := make(chan int, 1)
	go func() {
		runDone <- run(context.Background(), strings.NewReader(validConfigJSON(t, nil)), statuses, protocolDependencies(tunnel, forwarder))
	}()
	statuses.waitForType(t, "ready")
	select {
	case code := <-runDone:
		if code != 0 {
			t.Fatalf("run() = %d, want 0", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run() ignored EOF after an unframed JSON document")
	}
	if !forwarder.closed.Load() || !tunnel.closed.Load() {
		t.Fatal("run() did not clean up after EOF")
	}
}

func TestRunContextCancellationCleansUp(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	tunnel := newProtocolTunnel()
	forwarder := newProtocolForwarder()
	statuses := newStatusRecorder()
	stdinReader, stdinWriter := io.Pipe()
	defer stdinWriter.Close()
	runDone := make(chan int, 1)
	go func() {
		runDone <- run(ctx, stdinReader, statuses, protocolDependencies(tunnel, forwarder))
	}()
	if _, err := io.WriteString(stdinWriter, validConfigJSON(t, nil)+"\n"); err != nil {
		t.Fatal(err)
	}
	statuses.waitForType(t, "ready")
	cancel()
	select {
	case code := <-runDone:
		if code != 0 {
			t.Fatalf("run() = %d, want 0", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run() did not exit after cancellation")
	}
	if !forwarder.closed.Load() || !tunnel.closed.Load() {
		t.Fatal("run() did not clean up forwarder and tunnel")
	}
}

func TestRunAlreadyCanceledContextNeverReportsListenerFailure(t *testing.T) {
	for range 50 {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		tunnel := newProtocolTunnel()
		forwarder := newProtocolForwarder()
		_ = forwarder.Close()
		statuses := newStatusRecorder()
		if code := run(ctx, strings.NewReader(validConfigJSON(t, nil)), statuses, protocolDependencies(tunnel, forwarder)); code != 0 {
			t.Fatalf("run() = %d for an expected cancellation; output = %q", code, statuses.String())
		}
		if strings.Contains(statuses.String(), `"type":"error"`) {
			t.Fatalf("expected cancellation emitted an error: %q", statuses.String())
		}
	}
}

func TestRunRejectsSecondJSONWithoutStartingRuntime(t *testing.T) {
	input := validConfigJSON(t, nil) + validConfigJSON(t, nil)
	statuses := newStatusRecorder()
	started := atomic.Bool{}
	dependencies := runDependencies{
		startTunnel: func(Config) (tunnelRuntime, error) {
			started.Store(true)
			return nil, errors.New("must not start")
		},
	}
	if code := run(context.Background(), strings.NewReader(input), statuses, dependencies); code == 0 {
		t.Fatal("run() accepted a second JSON document")
	}
	if started.Load() {
		t.Fatal("run() started the runtime for invalid input")
	}
	statuses.waitForType(t, "error")
}

func TestRunRejectsDelayedSecondJSONAndCleansUp(t *testing.T) {
	stdinReader, stdinWriter := io.Pipe()
	tunnel := newProtocolTunnel()
	forwarder := newProtocolForwarder()
	statuses := newStatusRecorder()
	runDone := make(chan int, 1)
	go func() {
		runDone <- run(context.Background(), stdinReader, statuses, protocolDependencies(tunnel, forwarder))
	}()
	if _, err := io.WriteString(stdinWriter, validConfigJSON(t, nil)+"\n"); err != nil {
		t.Fatal(err)
	}
	statuses.waitForType(t, "ready")
	if _, err := io.WriteString(stdinWriter, `{"Token":"must-not-appear"}`); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-runDone:
		if code == 0 {
			t.Fatal("run() accepted delayed trailing JSON")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run() did not exit after delayed trailing JSON")
	}
	if !forwarder.closed.Load() || !tunnel.closed.Load() {
		t.Fatal("run() did not clean up after delayed trailing JSON")
	}
	if strings.Contains(statuses.String(), "must-not-appear") {
		t.Fatal("run() exposed delayed trailing input")
	}
}

func TestRunDeviceFailureIsBoundedAndRedacted(t *testing.T) {
	stdinReader, stdinWriter := io.Pipe()
	defer stdinWriter.Close()
	tunnel := newProtocolTunnel()
	forwarder := newProtocolForwarder()
	statuses := newStatusRecorder()
	runDone := make(chan int, 1)
	go func() {
		runDone <- run(context.Background(), stdinReader, statuses, protocolDependencies(tunnel, forwarder))
	}()
	if _, err := io.WriteString(stdinWriter, validConfigJSON(t, nil)+"\n"); err != nil {
		t.Fatal(err)
	}
	statuses.waitForType(t, "ready")
	tunnel.fail()
	select {
	case code := <-runDone:
		if code == 0 {
			t.Fatal("run() reported success after device failure")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run() did not exit after device failure")
	}
	errorStatus := statuses.waitForType(t, "error")
	if errorStatus["errorCode"] != "device_stopped" {
		t.Fatalf("error status = %#v", errorStatus)
	}
	if !forwarder.closed.Load() {
		t.Fatal("run() did not clean up forwarder after device failure")
	}
}

func TestRunStartupFailuresCleanUpAndUseStableCodes(t *testing.T) {
	t.Run("device", func(t *testing.T) {
		statuses := newStatusRecorder()
		dependencies := runDependencies{
			startTunnel: func(Config) (tunnelRuntime, error) {
				return nil, &tunnelError{code: "device_create_failed"}
			},
		}
		if code := run(context.Background(), strings.NewReader(validConfigJSON(t, nil)), statuses, dependencies); code == 0 {
			t.Fatal("run() reported success")
		}
		if got := statuses.waitForType(t, "error")["errorCode"]; got != "device_create_failed" {
			t.Fatalf("errorCode = %v", got)
		}
	})

	t.Run("listener", func(t *testing.T) {
		tunnel := newProtocolTunnel()
		statuses := newStatusRecorder()
		dependencies := runDependencies{
			startTunnel: func(Config) (tunnelRuntime, error) { return tunnel, nil },
			startForwarder: func(context.Context, DialContextFunc, string) (forwarderRuntime, error) {
				return nil, &forwardError{code: "listen_failed"}
			},
		}
		if code := run(context.Background(), strings.NewReader(validConfigJSON(t, nil)), statuses, dependencies); code == 0 {
			t.Fatal("run() reported success")
		}
		if got := statuses.waitForType(t, "error")["errorCode"]; got != "listen_failed" {
			t.Fatalf("errorCode = %v", got)
		}
		if !tunnel.closed.Load() {
			t.Fatal("run() did not clean up tunnel after listener failure")
		}
	})
}

func TestRunErrorStatusDoesNotExposeConfigOrSecrets(t *testing.T) {
	const secret = "must-not-appear"
	input := validConfigJSON(t, func(value map[string]any) {
		value["Token"] = secret
	})
	statuses := newStatusRecorder()
	if code := run(context.Background(), strings.NewReader(input), statuses, runDependencies{}); code == 0 {
		t.Fatal("run() accepted unknown secret input")
	}
	errorStatus := statuses.waitForType(t, "error")
	if errorStatus["status"] != "failed" || errorStatus["errorCode"] == "" {
		t.Fatalf("error status = %#v", errorStatus)
	}
	output := statuses.String()
	for _, forbidden := range []string{secret, testPrivateKey(), testPublicKey(), "relay.example.com", "10.8.0.1:7891", "Token"} {
		if strings.Contains(output, forbidden) {
			t.Fatalf("stdout exposed forbidden value %q", forbidden)
		}
	}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		var status map[string]any
		if err := json.Unmarshal([]byte(line), &status); err != nil {
			t.Fatalf("stdout line is not JSON: %q", line)
		}
	}
}
