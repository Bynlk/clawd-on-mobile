package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

func TestProcessSignalsInterruptOpenConfigInput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows does not provide POSIX SIGINT/SIGTERM process semantics")
	}

	binary := filepath.Join(t.TempDir(), "wg-relay-tunnel")
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build sidecar: %v: %s", err, output)
	}

	const partialSecret = "process-secret-must-not-appear"
	tests := []struct {
		name   string
		signal os.Signal
		input  string
	}{
		{name: "SIGINT empty", signal: os.Interrupt},
		{name: "SIGTERM empty", signal: syscall.Signal(15)},
		{name: "SIGINT partial secret", signal: os.Interrupt, input: `{"PrivateKey":"` + partialSecret},
		{name: "SIGTERM partial secret", signal: syscall.Signal(15), input: `{"PrivateKey":"` + partialSecret},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			command := exec.Command(binary)
			stdin, err := command.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			var stdout, stderr bytes.Buffer
			command.Stdout = &stdout
			command.Stderr = &stderr
			if err := command.Start(); err != nil {
				t.Fatal(err)
			}
			waitDone := make(chan error, 1)
			go func() { waitDone <- command.Wait() }()
			exited := false
			defer func() {
				_ = stdin.Close()
				if !exited {
					_ = command.Process.Kill()
					<-waitDone
				}
			}()

			if test.input != "" {
				if _, err := io.WriteString(stdin, test.input); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case err := <-waitDone:
				exited = true
				t.Fatalf("sidecar exited before signal: %v", err)
			case <-time.After(750 * time.Millisecond):
			}

			if err := command.Process.Signal(test.signal); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-waitDone:
				exited = true
				if err != nil {
					t.Fatalf("sidecar signal exit: %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("sidecar did not exit within 2 seconds")
			}

			if command.ProcessState == nil || !command.ProcessState.Exited() {
				t.Fatal("sidecar process was not fully reaped")
			}
			combined := stdout.String() + stderr.String()
			for _, forbidden := range []string{partialSecret, "PrivateKey", testPrivateKey(), testPublicKey()} {
				if strings.Contains(combined, forbidden) {
					t.Fatalf("sidecar output exposed %q: %q", forbidden, combined)
				}
			}
		})
	}
}

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

type endpointResolverStub struct {
	addresses []netip.Addr
	err       error
	wait      bool
	network   string
	host      string
}

func (resolver *endpointResolverStub) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	resolver.network = network
	resolver.host = host
	if resolver.wait {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return resolver.addresses, resolver.err
}

type ipcSetterStub struct {
	config string
}

func (device *ipcSetterStub) IpcSet(config string) error {
	device.config = config
	return nil
}

func TestConfigureDeviceResolvesHostnameToCanonicalNumericIPC(t *testing.T) {
	tests := []struct {
		name      string
		addresses []netip.Addr
		endpoint  string
	}{
		{
			name:      "IPv4",
			addresses: []netip.Addr{netip.MustParseAddr("203.0.113.10")},
			endpoint:  "203.0.113.10:51820",
		},
		{
			name:      "IPv6",
			addresses: []netip.Addr{netip.MustParseAddr("2001:db8::10")},
			endpoint:  "[2001:db8::10]:51820",
		},
		{
			name: "multiple results choose sorted IPv4 deterministically",
			addresses: []netip.Addr{
				netip.MustParseAddr("2001:db8::20"),
				netip.MustParseAddr("203.0.113.20"),
				netip.MustParseAddr("203.0.113.10"),
				netip.MustParseAddr("203.0.113.10"),
			},
			endpoint: "203.0.113.10:51820",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config := parsedTestConfig(t, nil)
			resolver := &endpointResolverStub{addresses: test.addresses}
			device := &ipcSetterStub{}
			if err := configureDevice(context.Background(), device, resolver, config); err != nil {
				t.Fatalf("configureDevice() error = %v", err)
			}
			if resolver.network != "ip" || resolver.host != "relay.example.com" {
				t.Fatalf("resolver called with network=%q host=%q", resolver.network, resolver.host)
			}
			if !strings.Contains(device.config, "endpoint="+test.endpoint+"\n") {
				t.Fatalf("IPC config missing canonical endpoint %q: %q", test.endpoint, device.config)
			}
			if strings.Contains(device.config, config.Endpoint) {
				t.Fatal("IPC config contains the unresolved hostname")
			}
			endpointLine := strings.Split(strings.Split(device.config, "endpoint=")[1], "\n")[0]
			if _, err := netip.ParseAddrPort(endpointLine); err != nil {
				t.Fatalf("IPC endpoint is not numeric AddrPort: %q", endpointLine)
			}
		})
	}
}

func TestResolveEndpointReturnsStableRedactedErrors(t *testing.T) {
	tests := []struct {
		name     string
		ctx      func() context.Context
		resolver *endpointResolverStub
		endpoint string
		code     string
		timeout  time.Duration
	}{
		{
			name:     "empty result",
			ctx:      context.Background,
			resolver: &endpointResolverStub{},
			endpoint: "relay.example.com:51820",
			code:     "endpoint_resolution_failed",
			timeout:  time.Second,
		},
		{
			name:     "lookup failure",
			ctx:      context.Background,
			resolver: &endpointResolverStub{err: errors.New("lookup relay.example.com failed")},
			endpoint: "relay.example.com:51820",
			code:     "endpoint_resolution_failed",
			timeout:  time.Second,
		},
		{
			name: "canceled",
			ctx: func() context.Context {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				return ctx
			},
			resolver: &endpointResolverStub{wait: true},
			endpoint: "relay.example.com:51820",
			code:     "endpoint_resolution_canceled",
			timeout:  time.Second,
		},
		{
			name:     "timeout",
			ctx:      context.Background,
			resolver: &endpointResolverStub{wait: true},
			endpoint: "relay.example.com:51820",
			code:     "endpoint_resolution_timeout",
			timeout:  10 * time.Millisecond,
		},
		{
			name: "numeric endpoint canceled",
			ctx: func() context.Context {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				return ctx
			},
			resolver: &endpointResolverStub{},
			endpoint: "203.0.113.10:51820",
			code:     "endpoint_resolution_canceled",
			timeout:  time.Second,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := resolveEndpointWithTimeout(test.ctx(), test.resolver, test.endpoint, test.timeout)
			if err == nil {
				t.Fatal("resolveEndpointWithTimeout() returned nil error")
			}
			if got := errorCode(err, "fallback"); got != test.code {
				t.Fatalf("error code = %q, want %q", got, test.code)
			}
			if strings.Contains(err.Error(), "relay.example.com") {
				t.Fatal("resolution error exposed the endpoint hostname")
			}
		})
	}
}

func TestStartTunnelUsesUserspaceNetstack(t *testing.T) {
	config := parsedTestConfig(t, func(value map[string]any) {
		value["Endpoint"] = "127.0.0.1:51820"
	})
	tunnel, err := StartTunnel(context.Background(), config)
	if err != nil {
		t.Fatalf("StartTunnel() error = %v", err)
	}
	if err := tunnel.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
}

type parsedIPCGetPeer struct {
	publicKey  [32]byte
	allowedIPs []netip.Prefix
	seen       map[string]struct{}
}

type parsedIPCGetState struct {
	peers []parsedIPCGetPeer
}

func parseIPCGetState(raw string) (parsedIPCGetState, error) {
	invalid := func() (parsedIPCGetState, error) {
		return parsedIPCGetState{}, errors.New("invalid_ipc_state")
	}
	if raw == "" || !strings.HasSuffix(raw, "\n") {
		return invalid()
	}
	lines := strings.Split(strings.TrimSuffix(raw, "\n"), "\n")
	state := parsedIPCGetState{}
	deviceSeen := make(map[string]struct{})
	var current *parsedIPCGetPeer
	finishPeer := func() bool {
		if current == nil {
			return true
		}
		for _, required := range []string{
			"preshared_key", "protocol_version", "endpoint", "last_handshake_time_sec",
			"last_handshake_time_nsec", "tx_bytes", "rx_bytes", "persistent_keepalive_interval",
		} {
			if _, ok := current.seen[required]; !ok {
				return false
			}
		}
		if len(current.allowedIPs) == 0 {
			return false
		}
		state.peers = append(state.peers, *current)
		return true
	}

	for _, line := range lines {
		key, value, ok := strings.Cut(line, "=")
		if !ok || key == "" || value == "" {
			return invalid()
		}
		if key == "public_key" {
			if !finishPeer() {
				return invalid()
			}
			publicKey, ok := parseCanonicalIPCKey(value, false)
			if !ok {
				return invalid()
			}
			for _, peer := range state.peers {
				if peer.publicKey == publicKey {
					return invalid()
				}
			}
			current = &parsedIPCGetPeer{publicKey: publicKey, seen: make(map[string]struct{})}
			continue
		}
		if current == nil {
			if _, duplicate := deviceSeen[key]; duplicate {
				return invalid()
			}
			deviceSeen[key] = struct{}{}
			switch key {
			case "private_key":
				if _, ok := parseCanonicalIPCKey(value, false); !ok {
					return invalid()
				}
			case "listen_port":
				port, err := strconv.ParseUint(value, 10, 16)
				if err != nil || port == 0 || strconv.FormatUint(port, 10) != value {
					return invalid()
				}
			case "fwmark":
				mark, err := strconv.ParseUint(value, 10, 32)
				if err != nil || mark == 0 || strconv.FormatUint(mark, 10) != value {
					return invalid()
				}
			default:
				return invalid()
			}
			continue
		}

		if key == "allowed_ip" {
			prefix, err := netip.ParsePrefix(value)
			if err != nil || prefix.String() != value {
				return invalid()
			}
			if slices.Contains(current.allowedIPs, prefix) {
				return invalid()
			}
			current.allowedIPs = append(current.allowedIPs, prefix)
			continue
		}
		if _, duplicate := current.seen[key]; duplicate {
			return invalid()
		}
		current.seen[key] = struct{}{}
		switch key {
		case "preshared_key":
			if _, ok := parseCanonicalIPCKey(value, true); !ok {
				return invalid()
			}
		case "protocol_version":
			if value != "1" {
				return invalid()
			}
		case "endpoint":
			endpoint, err := netip.ParseAddrPort(value)
			if err != nil || endpoint.String() != value {
				return invalid()
			}
		case "last_handshake_time_sec", "tx_bytes", "rx_bytes":
			number, err := strconv.ParseUint(value, 10, 64)
			if err != nil || strconv.FormatUint(number, 10) != value {
				return invalid()
			}
		case "last_handshake_time_nsec":
			nanoseconds, err := strconv.ParseUint(value, 10, 32)
			if err != nil || nanoseconds >= uint64(time.Second) || strconv.FormatUint(nanoseconds, 10) != value {
				return invalid()
			}
		case "persistent_keepalive_interval":
			keepalive, err := strconv.ParseUint(value, 10, 16)
			if err != nil || keepalive == 0 || strconv.FormatUint(keepalive, 10) != value {
				return invalid()
			}
		default:
			return invalid()
		}
	}
	if _, ok := deviceSeen["private_key"]; !ok || !finishPeer() || len(state.peers) == 0 {
		return invalid()
	}
	return state, nil
}

func parseCanonicalIPCKey(value string, allowZero bool) ([32]byte, bool) {
	var key [32]byte
	if len(value) != hex.EncodedLen(len(key)) {
		return key, false
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || hex.EncodeToString(decoded) != value {
		return key, false
	}
	copy(key[:], decoded)
	if !allowZero && key == [32]byte{} {
		return [32]byte{}, false
	}
	return key, true
}

func TestStartTunnelIpcGetHasExactlyConfiguredPeerAndAllowedIP(t *testing.T) {
	config := parsedTestConfig(t, func(value map[string]any) {
		value["Endpoint"] = "127.0.0.1:51820"
	})
	tunnel, err := StartTunnel(context.Background(), config)
	if err != nil {
		t.Fatalf("StartTunnel() error = %v", err)
	}
	defer tunnel.Close()
	rawState, err := tunnel.device.IpcGet()
	if err != nil {
		t.Fatal(err)
	}
	state, err := parseIPCGetState(rawState)
	if err != nil {
		t.Fatalf("parseIPCGetState() error = %v", err)
	}
	if len(state.peers) != 1 {
		t.Fatalf("peer count = %d, want 1", len(state.peers))
	}
	expectedPublicKey, ok := decodeKey(config.ServerPublicKey)
	if !ok {
		t.Fatal("test server public key is invalid")
	}
	if !bytes.Equal(state.peers[0].publicKey[:], expectedPublicKey) {
		t.Fatal("IpcGet peer public key does not match the configured server")
	}
	if got, want := state.peers[0].allowedIPs, []netip.Prefix{netip.MustParsePrefix(config.AllowedIP)}; !slices.Equal(got, want) {
		t.Fatalf("AllowedIPs = %v, want %v", got, want)
	}
}

func TestParseIPCGetStateRejectsMalformedOrAmbiguousOutput(t *testing.T) {
	config := parsedTestConfig(t, func(value map[string]any) {
		value["Endpoint"] = "127.0.0.1:51820"
	})
	tunnel, err := StartTunnel(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	rawState, err := tunnel.device.IpcGet()
	_ = tunnel.Close()
	if err != nil {
		t.Fatal(err)
	}
	privateKey, _ := decodeKey(config.PrivateKey)
	privateHex := hex.EncodeToString(privateKey)
	publicKey, _ := decodeKey(config.ServerPublicKey)
	publicHex := hex.EncodeToString(publicKey)
	missingRequired := rawState
	for _, line := range strings.Split(rawState, "\n") {
		if strings.HasPrefix(line, "tx_bytes=") {
			missingRequired = strings.Replace(rawState, line+"\n", "", 1)
			break
		}
	}
	tests := map[string]string{
		"unknown field":         rawState + "unknown=1\n",
		"duplicate singleton":   strings.Replace(rawState, "protocol_version=1\n", "protocol_version=1\nprotocol_version=1\n", 1),
		"duplicate AllowedIP":   strings.Replace(rawState, "allowed_ip="+config.AllowedIP+"\n", "allowed_ip="+config.AllowedIP+"\nallowed_ip="+config.AllowedIP+"\n", 1),
		"missing required":      missingRequired,
		"malformed line":        rawState + "not-a-pair\n",
		"missing final newline": strings.TrimSuffix(rawState, "\n"),
	}
	for name, malformed := range tests {
		t.Run(name, func(t *testing.T) {
			_, err := parseIPCGetState(malformed)
			if err == nil {
				t.Fatal("parseIPCGetState() accepted malformed output")
			}
			if strings.Contains(err.Error(), privateHex) || strings.Contains(err.Error(), publicHex) {
				t.Fatal("parseIPCGetState() error exposed a WireGuard key")
			}
		})
	}
}

func TestUserspaceWireGuardNetstackTCPForwarding(t *testing.T) {
	serverPrivate := make([]byte, 32)
	serverPrivate[0] = 16
	serverPrivate[31] = 64
	clientPrivate, ok := decodeKey(testPrivateKey())
	if !ok {
		t.Fatal("invalid test client private key")
	}
	serverPrivateKey, err := ecdh.X25519().NewPrivateKey(serverPrivate)
	if err != nil {
		t.Fatal(err)
	}
	clientPrivateKey, err := ecdh.X25519().NewPrivateKey(clientPrivate)
	if err != nil {
		t.Fatal(err)
	}
	serverPublic := serverPrivateKey.PublicKey().Bytes()
	clientPublic := clientPrivateKey.PublicKey().Bytes()

	serverTUN, serverNetwork, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.8.0.1")}, nil, 1420)
	if err != nil {
		t.Fatal(err)
	}
	serverDevice := device.NewDevice(serverTUN, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	defer serverDevice.Close()
	if err := serverDevice.IpcSet("private_key=" + hex.EncodeToString(serverPrivate) + "\n"); err != nil {
		t.Fatal(err)
	}
	if err := serverDevice.Up(); err != nil {
		t.Fatal(err)
	}
	serverState, err := serverDevice.IpcGet()
	if err != nil {
		t.Fatal(err)
	}
	serverPort, err := parseSingleIPCListenPort(serverState)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverDevice.IpcSet(fmt.Sprintf(
		"public_key=%s\nallowed_ip=10.8.0.2/32\n",
		hex.EncodeToString(clientPublic),
	)); err != nil {
		t.Fatal(err)
	}

	clientTUN, clientNetwork, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.8.0.2")}, nil, 1420)
	if err != nil {
		t.Fatal(err)
	}
	clientDevice := device.NewDevice(clientTUN, conn.NewDefaultBind(), device.NewLogger(device.LogLevelSilent, ""))
	defer clientDevice.Close()
	if err := clientDevice.IpcSet(fmt.Sprintf(
		"private_key=%s\npublic_key=%s\nendpoint=127.0.0.1:%d\nallowed_ip=10.8.0.1/32\npersistent_keepalive_interval=1\n",
		hex.EncodeToString(clientPrivate),
		hex.EncodeToString(serverPublic),
		serverPort,
	)); err != nil {
		t.Fatal(err)
	}
	if err := clientDevice.Up(); err != nil {
		t.Fatal(err)
	}

	backend, err := serverNetwork.ListenTCPAddrPort(netip.MustParseAddrPort("10.8.0.1:7891"))
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
		if _, writeErr := connection.Write(append([]byte("wg-reply:"), request...)); writeErr != nil {
			backendDone <- writeErr
			return
		}
		backendDone <- closeWrite(connection)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	forwarder, err := StartForwarder(ctx, clientNetwork.DialContext, "10.8.0.1:7891")
	if err != nil {
		t.Fatal(err)
	}
	defer forwarder.Close()
	localRaw, err := net.Dial("tcp4", forwarder.Addr())
	if err != nil {
		t.Fatal(err)
	}
	local := localRaw.(*net.TCPConn)
	defer local.Close()
	if err := local.SetDeadline(time.Now().Add(8 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := local.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := local.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	response, err := io.ReadAll(local)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := string(response), "wg-reply:hello"; got != want {
		t.Fatalf("response = %q, want %q", got, want)
	}
	if err := <-backendDone; err != nil {
		t.Fatal(err)
	}
}

func parseSingleIPCListenPort(raw string) (uint16, error) {
	var port uint64
	count := 0
	for _, line := range strings.Split(strings.TrimSuffix(raw, "\n"), "\n") {
		if !strings.HasPrefix(line, "listen_port=") {
			continue
		}
		value := strings.TrimPrefix(line, "listen_port=")
		parsed, err := strconv.ParseUint(value, 10, 16)
		if err != nil || parsed == 0 || strconv.FormatUint(parsed, 10) != value {
			return 0, errors.New("invalid_ipc_listen_port")
		}
		port = parsed
		count++
	}
	if count != 1 {
		return 0, errors.New("invalid_ipc_listen_port")
	}
	return uint16(port), nil
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

func TestRunCancellationDuringTunnelStartIsNotReportedAsFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	statuses := newStatusRecorder()
	dependencies := runDependencies{
		startTunnel: func(Config) (tunnelRuntime, error) {
			close(started)
			<-ctx.Done()
			return nil, &tunnelError{code: "endpoint_resolution_canceled"}
		},
	}
	runDone := make(chan int, 1)
	go func() {
		runDone <- run(ctx, strings.NewReader(validConfigJSON(t, nil)), statuses, dependencies)
	}()
	<-started
	cancel()
	select {
	case code := <-runDone:
		if code != 0 {
			t.Fatalf("run() = %d, want 0; output = %q", code, statuses.String())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("run() did not exit after tunnel startup cancellation")
	}
	if strings.Contains(statuses.String(), `"type":"error"`) {
		t.Fatalf("expected cancellation emitted an error: %q", statuses.String())
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
