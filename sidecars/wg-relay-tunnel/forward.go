package main

import (
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sync"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

type DialContextFunc func(context.Context, string, string) (net.Conn, error)

type Tunnel struct {
	device    *device.Device
	network   *netstack.Net
	closeOnce sync.Once
}

func StartTunnel(config Config) (*Tunnel, error) {
	address, err := netip.ParsePrefix(config.Address)
	if err != nil {
		return nil, &tunnelError{code: "device_config_failed"}
	}
	tunDevice, network, err := netstack.CreateNetTUN([]netip.Addr{address.Addr()}, nil, 1420)
	if err != nil {
		return nil, &tunnelError{code: "device_create_failed"}
	}
	wireGuardDevice := device.NewDevice(
		tunDevice,
		conn.NewDefaultBind(),
		device.NewLogger(device.LogLevelSilent, ""),
	)
	tunnel := &Tunnel{device: wireGuardDevice, network: network}
	ipcConfig, err := buildIPCConfig(config)
	if err != nil {
		_ = tunnel.Close()
		return nil, err
	}
	if err := wireGuardDevice.IpcSet(ipcConfig); err != nil {
		_ = tunnel.Close()
		return nil, &tunnelError{code: "device_config_failed"}
	}
	if err := wireGuardDevice.Up(); err != nil {
		_ = tunnel.Close()
		return nil, &tunnelError{code: "device_start_failed"}
	}
	return tunnel, nil
}

func buildIPCConfig(config Config) (string, error) {
	privateKey, privateOK := decodeKey(config.PrivateKey)
	publicKey, publicOK := decodeKey(config.ServerPublicKey)
	if !privateOK || !publicOK {
		return "", &tunnelError{code: "device_config_failed"}
	}
	return fmt.Sprintf(
		"private_key=%s\nreplace_peers=true\npublic_key=%s\nendpoint=%s\npersistent_keepalive_interval=%d\nreplace_allowed_ips=true\nallowed_ip=%s\n",
		hex.EncodeToString(privateKey),
		hex.EncodeToString(publicKey),
		config.Endpoint,
		config.KeepaliveSeconds,
		config.AllowedIP,
	), nil
}

func (tunnel *Tunnel) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	return tunnel.network.DialContext(ctx, network, address)
}

func (tunnel *Tunnel) Done() <-chan struct{} {
	return tunnel.device.Wait()
}

func (tunnel *Tunnel) Close() error {
	tunnel.closeOnce.Do(func() {
		tunnel.device.Close()
	})
	return nil
}

type tunnelError struct {
	code string
}

func (err *tunnelError) Error() string {
	return err.code
}

func (err *tunnelError) ErrorCode() string {
	return err.code
}

type Forwarder struct {
	ctx      context.Context
	cancel   context.CancelFunc
	dial     DialContextFunc
	target   string
	listener net.Listener

	acceptDone chan struct{}
	done       chan struct{}
	closeOnce  sync.Once
	workers    sync.WaitGroup

	connectionsMu sync.Mutex
	connections   map[net.Conn]struct{}
	waitErr       error
}

func StartForwarder(parent context.Context, dial DialContextFunc, target string) (*Forwarder, error) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return nil, &forwardError{code: "listen_failed"}
	}
	ctx, cancel := context.WithCancel(parent)
	forwarder := &Forwarder{
		ctx:         ctx,
		cancel:      cancel,
		dial:        dial,
		target:      target,
		listener:    listener,
		acceptDone:  make(chan struct{}),
		done:        make(chan struct{}),
		connections: make(map[net.Conn]struct{}),
	}
	go forwarder.acceptLoop()
	go func() {
		select {
		case <-ctx.Done():
			forwarder.shutdown()
		case <-forwarder.done:
		}
	}()
	return forwarder, nil
}

func (forwarder *Forwarder) Addr() string {
	return forwarder.listener.Addr().String()
}

func (forwarder *Forwarder) Wait() error {
	<-forwarder.done
	forwarder.connectionsMu.Lock()
	defer forwarder.connectionsMu.Unlock()
	return forwarder.waitErr
}

func (forwarder *Forwarder) Close() error {
	forwarder.shutdown()
	return nil
}

func (forwarder *Forwarder) acceptLoop() {
	defer close(forwarder.acceptDone)
	for {
		connection, err := forwarder.listener.Accept()
		if err != nil {
			if forwarder.ctx.Err() == nil {
				forwarder.connectionsMu.Lock()
				forwarder.waitErr = &forwardError{code: "listener_failed"}
				forwarder.connectionsMu.Unlock()
				forwarder.cancel()
			}
			return
		}
		if !forwarder.track(connection) {
			continue
		}
		forwarder.workers.Add(1)
		go forwarder.forward(connection)
	}
}

func (forwarder *Forwarder) forward(local net.Conn) {
	defer forwarder.workers.Done()
	defer forwarder.untrackAndClose(local)

	remote, err := forwarder.dial(forwarder.ctx, "tcp4", forwarder.target)
	if err != nil {
		return
	}
	if !forwarder.track(remote) {
		return
	}
	defer forwarder.untrackAndClose(remote)

	copyDone := make(chan struct{}, 2)
	go copyHalf(remote, local, copyDone)
	go copyHalf(local, remote, copyDone)
	<-copyDone
	<-copyDone
}

func copyHalf(destination, source net.Conn, done chan<- struct{}) {
	_, _ = io.Copy(destination, source)
	_ = closeWrite(destination)
	done <- struct{}{}
}

func closeWrite(connection net.Conn) error {
	if halfCloser, ok := connection.(interface{ CloseWrite() error }); ok {
		return halfCloser.CloseWrite()
	}
	return connection.Close()
}

func (forwarder *Forwarder) track(connection net.Conn) bool {
	forwarder.connectionsMu.Lock()
	defer forwarder.connectionsMu.Unlock()
	if forwarder.ctx.Err() != nil {
		_ = connection.Close()
		return false
	}
	forwarder.connections[connection] = struct{}{}
	return true
}

func (forwarder *Forwarder) untrackAndClose(connection net.Conn) {
	forwarder.connectionsMu.Lock()
	delete(forwarder.connections, connection)
	forwarder.connectionsMu.Unlock()
	_ = connection.Close()
}

func (forwarder *Forwarder) shutdown() {
	forwarder.closeOnce.Do(func() {
		forwarder.cancel()
		_ = forwarder.listener.Close()
		<-forwarder.acceptDone

		forwarder.connectionsMu.Lock()
		for connection := range forwarder.connections {
			_ = connection.Close()
		}
		forwarder.connectionsMu.Unlock()

		forwarder.workers.Wait()
		close(forwarder.done)
	})
	<-forwarder.done
}

type forwardError struct {
	code string
}

func (err *forwardError) Error() string {
	return err.code
}

func (err *forwardError) ErrorCode() string {
	return err.code
}
