package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type copyFaultConn struct {
	writeErr       error
	closeWriteErr  error
	writeAttempted chan struct{}
	closeWriteDone chan struct{}
	closed         chan struct{}
	writeOnce      sync.Once
	closeWriteOnce sync.Once
	closeOnce      sync.Once
	closeCount     atomic.Int32
}

func newCopyFaultConn(writeErr, closeWriteErr error) *copyFaultConn {
	return &copyFaultConn{
		writeErr:       writeErr,
		closeWriteErr:  closeWriteErr,
		writeAttempted: make(chan struct{}),
		closeWriteDone: make(chan struct{}),
		closed:         make(chan struct{}),
	}
}

func (connection *copyFaultConn) Read([]byte) (int, error) {
	<-connection.closed
	return 0, net.ErrClosed
}

func (connection *copyFaultConn) Write(value []byte) (int, error) {
	connection.writeOnce.Do(func() { close(connection.writeAttempted) })
	if connection.writeErr != nil {
		return 0, connection.writeErr
	}
	return len(value), nil
}

func (connection *copyFaultConn) CloseWrite() error {
	connection.closeWriteOnce.Do(func() { close(connection.closeWriteDone) })
	return connection.closeWriteErr
}

func (connection *copyFaultConn) Close() error {
	connection.closeOnce.Do(func() {
		connection.closeCount.Add(1)
		close(connection.closed)
	})
	return nil
}

func (connection *copyFaultConn) LocalAddr() net.Addr              { return dummyAddr("local") }
func (connection *copyFaultConn) RemoteAddr() net.Addr             { return dummyAddr("remote") }
func (connection *copyFaultConn) SetDeadline(time.Time) error      { return nil }
func (connection *copyFaultConn) SetReadDeadline(time.Time) error  { return nil }
func (connection *copyFaultConn) SetWriteDeadline(time.Time) error { return nil }

type dummyAddr string

func (address dummyAddr) Network() string { return "test" }
func (address dummyAddr) String() string  { return string(address) }

func TestForwarderCopyFaultClosesBothDirections(t *testing.T) {
	tests := []struct {
		name          string
		writeErr      error
		closeWriteErr error
	}{
		{name: "write error", writeErr: errors.New("injected write failure")},
		{name: "close-write error", closeWriteErr: errors.New("injected close-write failure")},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			remote := newCopyFaultConn(test.writeErr, test.closeWriteErr)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			forwarder, err := StartForwarder(ctx, func(context.Context, string, string) (net.Conn, error) {
				return remote, nil
			}, "10.8.0.1:7891")
			if err != nil {
				t.Fatal(err)
			}
			defer forwarder.Close()

			clientRaw, err := net.Dial("tcp4", forwarder.Addr())
			if err != nil {
				t.Fatal(err)
			}
			client := clientRaw.(*net.TCPConn)
			defer client.Close()
			if _, err := client.Write([]byte("trigger")); err != nil {
				t.Fatal(err)
			}
			if test.writeErr == nil {
				if err := client.CloseWrite(); err != nil {
					t.Fatal(err)
				}
			}

			select {
			case <-remote.closed:
			case <-time.After(time.Second):
				t.Fatal("copy fault did not fully close the remote connection")
			}
			if got := remote.closeCount.Load(); got != 1 {
				t.Fatalf("remote Close count = %d, want 1", got)
			}
			if err := client.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
				t.Fatal(err)
			}
			if _, err := client.Read(make([]byte, 1)); err == nil {
				t.Fatal("local connection remained open after copy fault")
			} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				t.Fatal("local connection was not closed within the deadline")
			}
			if err := forwarder.Close(); err != nil {
				t.Fatal(err)
			}
			if got := remote.closeCount.Load(); got != 1 {
				t.Fatalf("remote Close count after shutdown = %d, want 1", got)
			}
		})
	}
}

func TestForwarderPeerRSTClosesBlockedOppositeDirection(t *testing.T) {
	backend, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	backendDone := make(chan error, 1)
	go func() {
		connection, acceptErr := backend.Accept()
		if acceptErr != nil {
			backendDone <- acceptErr
			return
		}
		tcpConnection := connection.(*net.TCPConn)
		if lingerErr := tcpConnection.SetLinger(0); lingerErr != nil {
			_ = connection.Close()
			backendDone <- lingerErr
			return
		}
		backendDone <- connection.Close()
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	forwarder, err := StartForwarder(ctx, (&net.Dialer{}).DialContext, backend.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer forwarder.Close()
	client, err := net.Dial("tcp4", forwarder.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := <-backendDone; err != nil {
		t.Fatal(err)
	}
	if err := client.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Read(make([]byte, 1)); err == nil {
		t.Fatal("local connection remained open after peer RST")
	} else if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
		t.Fatal("peer RST did not wake the blocked opposite copy")
	}
	waitForTrackedConnectionCount(t, forwarder, 0)
}

func TestForwarderRepeatedCopyFaultsDoNotLeakResources(t *testing.T) {
	baselineGoroutines := runtime.NumGoroutine()
	baselineFDs, hasFDCount := openFDCount()
	remoteConnections := make(chan *copyFaultConn, 1)
	ctx, cancel := context.WithCancel(context.Background())
	forwarder, err := StartForwarder(ctx, func(context.Context, string, string) (net.Conn, error) {
		connection := newCopyFaultConn(errors.New("injected write failure"), nil)
		remoteConnections <- connection
		return connection, nil
	}, "10.8.0.1:7891")
	if err != nil {
		t.Fatal(err)
	}

	const iterations = 100
	for index := range iterations {
		client, dialErr := net.Dial("tcp4", forwarder.Addr())
		if dialErr != nil {
			t.Fatalf("iteration %d dial: %v", index, dialErr)
		}
		remote := <-remoteConnections
		if _, writeErr := client.Write([]byte("trigger")); writeErr != nil {
			_ = client.Close()
			t.Fatalf("iteration %d write: %v", index, writeErr)
		}
		select {
		case <-remote.closed:
		case <-time.After(time.Second):
			_ = client.Close()
			t.Fatalf("iteration %d remote connection remained open", index)
		}
		if got := remote.closeCount.Load(); got != 1 {
			_ = client.Close()
			t.Fatalf("iteration %d Close count = %d, want 1", index, got)
		}
		_ = client.Close()
	}
	waitForTrackedConnectionCount(t, forwarder, 0)
	cancel()
	closeDone := make(chan error, 1)
	go func() { closeDone <- forwarder.Close() }()
	select {
	case err := <-closeDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Forwarder.Close did not return after repeated copy faults")
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		runtime.GC()
		goroutinesOK := runtime.NumGoroutine() <= baselineGoroutines+2
		fdsOK := true
		if hasFDCount {
			currentFDs, ok := openFDCount()
			fdsOK = ok && currentFDs <= baselineFDs+2
		}
		if goroutinesOK && fdsOK {
			break
		}
		if time.Now().After(deadline) {
			currentFDs, _ := openFDCount()
			t.Fatalf("resources did not return to baseline: goroutines %d -> %d, fds %d -> %d", baselineGoroutines, runtime.NumGoroutine(), baselineFDs, currentFDs)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForTrackedConnectionCount(t *testing.T, forwarder *Forwarder, want int) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		forwarder.connectionsMu.Lock()
		got := len(forwarder.connections)
		forwarder.connectionsMu.Unlock()
		if got == want {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("tracked connections = %d, want %d", got, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func openFDCount() (int, bool) {
	entries, err := os.ReadDir("/dev/fd")
	if err != nil {
		return 0, false
	}
	return len(entries), true
}

func TestForwarderIsLoopbackOnlyAndPreservesBidirectionalHalfClose(t *testing.T) {
	backend, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()

	backendDone := make(chan error, 1)
	go func() {
		connection, acceptErr := backend.Accept()
		if acceptErr != nil {
			backendDone <- acceptErr
			return
		}
		defer connection.Close()
		request, readErr := io.ReadAll(connection)
		if readErr != nil {
			backendDone <- readErr
			return
		}
		if _, writeErr := connection.Write(append([]byte("reply:"), request...)); writeErr != nil {
			backendDone <- writeErr
			return
		}
		backendDone <- closeWrite(connection)
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	forwarder, err := StartForwarder(ctx, (&net.Dialer{}).DialContext, backend.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer forwarder.Close()

	listenAddress, err := net.ResolveTCPAddr("tcp4", forwarder.Addr())
	if err != nil {
		t.Fatal(err)
	}
	if !listenAddress.IP.IsLoopback() || listenAddress.IP.String() != "127.0.0.1" || listenAddress.Port == 0 {
		t.Fatalf("forwarder address = %q, want 127.0.0.1:<ephemeral>", forwarder.Addr())
	}

	clientRaw, err := net.Dial("tcp4", forwarder.Addr())
	if err != nil {
		t.Fatal(err)
	}
	client := clientRaw.(*net.TCPConn)
	defer client.Close()
	if _, err := client.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := client.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(client)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(response), "reply:hello"; got != want {
		t.Fatalf("response = %q, want %q", got, want)
	}
	if err := <-backendDone; err != nil {
		t.Fatal(err)
	}
}

func TestForwarderContextCancellationCleansConcurrentConnections(t *testing.T) {
	backend, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()

	const connectionCount = 12
	accepted := make(chan struct{}, connectionCount)
	backendClosed := make(chan struct{})
	var backendConnections sync.WaitGroup
	backendConnections.Add(connectionCount)
	go func() {
		for range connectionCount {
			connection, acceptErr := backend.Accept()
			if acceptErr != nil {
				return
			}
			accepted <- struct{}{}
			go func() {
				defer backendConnections.Done()
				defer connection.Close()
				_, _ = io.Copy(io.Discard, connection)
			}()
		}
		backendConnections.Wait()
		close(backendClosed)
	}()

	ctx, cancel := context.WithCancel(context.Background())
	forwarder, err := StartForwarder(ctx, (&net.Dialer{}).DialContext, backend.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	clients := make([]net.Conn, 0, connectionCount)
	for index := range connectionCount {
		client, dialErr := net.Dial("tcp4", forwarder.Addr())
		if dialErr != nil {
			t.Fatalf("dial %d: %v", index, dialErr)
		}
		clients = append(clients, client)
		if _, writeErr := fmt.Fprintf(client, "connection-%d", index); writeErr != nil {
			t.Fatal(writeErr)
		}
	}
	for range connectionCount {
		select {
		case <-accepted:
		case <-time.After(2 * time.Second):
			t.Fatal("backend did not accept all forwarded connections")
		}
	}

	cancel()
	waitDone := make(chan error, 1)
	go func() { waitDone <- forwarder.Wait() }()
	select {
	case err := <-waitDone:
		if err != nil {
			t.Fatalf("Wait() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Wait() did not return after context cancellation")
	}
	select {
	case <-backendClosed:
	case <-time.After(2 * time.Second):
		t.Fatal("active backend connections were not cleaned up")
	}
	for _, client := range clients {
		_ = client.Close()
	}
}
