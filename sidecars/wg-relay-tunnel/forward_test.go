package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

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
