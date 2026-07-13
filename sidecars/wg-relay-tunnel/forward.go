package main

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"sort"
	"strconv"
	"sync"
	"time"

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

const endpointResolutionTimeout = 10 * time.Second

type endpointResolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

type ipcSetter interface {
	IpcSet(string) error
}

func StartTunnel(ctx context.Context, config Config) (*Tunnel, error) {
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
	if err := configureDevice(ctx, wireGuardDevice, net.DefaultResolver, config); err != nil {
		_ = tunnel.Close()
		return nil, err
	}
	if err := wireGuardDevice.Up(); err != nil {
		_ = tunnel.Close()
		return nil, &tunnelError{code: "device_start_failed"}
	}
	return tunnel, nil
}

func configureDevice(ctx context.Context, device ipcSetter, resolver endpointResolver, config Config) error {
	endpoint, err := resolveEndpointWithTimeout(ctx, resolver, config.Endpoint, endpointResolutionTimeout)
	if err != nil {
		return err
	}
	config.Endpoint = endpoint
	ipcConfig, err := buildIPCConfig(config)
	if err != nil {
		return err
	}
	if err := device.IpcSet(ipcConfig); err != nil {
		return &tunnelError{code: "device_config_failed"}
	}
	return nil
}

func resolveEndpointWithTimeout(ctx context.Context, resolver endpointResolver, endpoint string, timeout time.Duration) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", endpointResolutionError(ctx, err)
	}
	host, portText, err := net.SplitHostPort(endpoint)
	if err != nil {
		return "", &tunnelError{code: "endpoint_resolution_failed"}
	}
	portValue, err := strconv.ParseUint(portText, 10, 16)
	if err != nil || portValue == 0 {
		return "", &tunnelError{code: "endpoint_resolution_failed"}
	}
	port := uint16(portValue)
	if address, parseErr := netip.ParseAddr(host); parseErr == nil {
		return netip.AddrPortFrom(address.Unmap(), port).String(), nil
	}

	lookupContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	addresses, lookupErr := resolver.LookupNetIP(lookupContext, "ip", host)
	if lookupErr != nil {
		return "", endpointResolutionError(lookupContext, lookupErr)
	}
	if lookupErr = lookupContext.Err(); lookupErr != nil {
		return "", endpointResolutionError(lookupContext, lookupErr)
	}

	unique := make(map[netip.Addr]struct{}, len(addresses))
	for _, address := range addresses {
		address = address.Unmap()
		if address.IsValid() && address.Zone() == "" && (address.Is4() || address.Is6()) {
			unique[address] = struct{}{}
		}
	}
	addresses = addresses[:0]
	for address := range unique {
		addresses = append(addresses, address)
	}
	sort.Slice(addresses, func(left, right int) bool {
		if addresses[left].Is4() != addresses[right].Is4() {
			return addresses[left].Is4()
		}
		return addresses[left].Compare(addresses[right]) < 0
	})
	if len(addresses) == 0 {
		return "", &tunnelError{code: "endpoint_resolution_failed"}
	}
	return netip.AddrPortFrom(addresses[0], port).String(), nil
}

func endpointResolutionError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
		return &tunnelError{code: "endpoint_resolution_canceled"}
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return &tunnelError{code: "endpoint_resolution_timeout"}
	}
	return &tunnelError{code: "endpoint_resolution_failed"}
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

	var closeOnce sync.Once
	closeBoth := func() {
		closeOnce.Do(func() {
			forwarder.untrackAndClose(local)
			forwarder.untrackAndClose(remote)
		})
	}
	defer closeBoth()

	copyDone := make(chan error, 2)
	go func() { copyDone <- copyHalf(remote, local) }()
	go func() { copyDone <- copyHalf(local, remote) }()
	if err := <-copyDone; err != nil {
		closeBoth()
	}
	if err := <-copyDone; err != nil {
		closeBoth()
	}
}

func copyHalf(destination, source net.Conn) error {
	if _, err := io.Copy(destination, source); err != nil {
		return err
	}
	return closeWrite(destination)
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
	_, tracked := forwarder.connections[connection]
	if tracked {
		delete(forwarder.connections, connection)
	}
	forwarder.connectionsMu.Unlock()
	if tracked {
		_ = connection.Close()
	}
}

func (forwarder *Forwarder) shutdown() {
	forwarder.closeOnce.Do(func() {
		forwarder.cancel()
		_ = forwarder.listener.Close()
		<-forwarder.acceptDone

		forwarder.connectionsMu.Lock()
		connections := make([]net.Conn, 0, len(forwarder.connections))
		for connection := range forwarder.connections {
			delete(forwarder.connections, connection)
			connections = append(connections, connection)
		}
		forwarder.connectionsMu.Unlock()
		for _, connection := range connections {
			_ = connection.Close()
		}

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
