package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

func testPrivateKey() string {
	key := make([]byte, 32)
	key[0] = 8
	key[31] = 64
	return base64.StdEncoding.EncodeToString(key)
}

func testPublicKey() string {
	key := bytes.Repeat([]byte{2}, 32)
	return base64.StdEncoding.EncodeToString(key)
}

func validConfigJSON(t *testing.T, mutate func(map[string]any)) string {
	t.Helper()
	value := map[string]any{
		"PrivateKey":       testPrivateKey(),
		"Address":          "10.8.0.2/32",
		"ServerPublicKey":  testPublicKey(),
		"Endpoint":         "relay.example.com:51820",
		"AllowedIP":        "10.8.0.0/24",
		"ForwardAddress":   "10.8.0.1:7891",
		"KeepaliveSeconds": 25,
	}
	if mutate != nil {
		mutate(value)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func TestParseConfigAcceptsExactlyOneJSONDocument(t *testing.T) {
	input := validConfigJSON(t, nil) + "\n\t "
	if _, err := ParseConfig(strings.NewReader(input)); err != nil {
		t.Fatalf("ParseConfig() error = %v", err)
	}
}

func TestParseConfigRejectsUnknownField(t *testing.T) {
	input := validConfigJSON(t, func(value map[string]any) {
		value["Token"] = "must-not-appear"
	})
	_, err := ParseConfig(strings.NewReader(input))
	if err == nil {
		t.Fatal("ParseConfig() accepted an unknown field")
	}
	if strings.Contains(err.Error(), "must-not-appear") {
		t.Fatal("ParseConfig() exposed an input value")
	}
}

func TestParseConfigRejectsDuplicateOrMisCasedFields(t *testing.T) {
	valid := validConfigJSON(t, nil)
	duplicate := strings.Replace(valid, `"Endpoint":"relay.example.com:51820"`, `"Endpoint":"relay.example.com:51820","Endpoint":"other.example.com:51820"`, 1)
	misCased := strings.Replace(valid, `"PrivateKey":`, `"privatekey":`, 1)
	for _, input := range []string{duplicate, misCased} {
		if _, err := ParseConfig(strings.NewReader(input)); err == nil {
			t.Fatal("ParseConfig() accepted an ambiguous field set")
		}
	}
}

func TestParseConfigRejectsTrailingData(t *testing.T) {
	for _, suffix := range []string{"{}", " trailing"} {
		t.Run(suffix, func(t *testing.T) {
			_, err := ParseConfig(strings.NewReader(validConfigJSON(t, nil) + suffix))
			if err == nil {
				t.Fatal("ParseConfig() accepted trailing data")
			}
		})
	}
}

func TestParseConfigRejectsInvalidWireGuardKeys(t *testing.T) {
	unclampedPrivate := bytes.Repeat([]byte{3}, 32)
	zeroKey := make([]byte, 32)
	tests := []struct {
		name  string
		field string
		value string
	}{
		{name: "private malformed base64", field: "PrivateKey", value: "not-a-key"},
		{name: "private wrong size", field: "PrivateKey", value: base64.StdEncoding.EncodeToString([]byte("short"))},
		{name: "private noncanonical base64", field: "PrivateKey", value: strings.TrimRight(testPrivateKey(), "=")},
		{name: "private zero", field: "PrivateKey", value: base64.StdEncoding.EncodeToString(zeroKey)},
		{name: "private not clamped", field: "PrivateKey", value: base64.StdEncoding.EncodeToString(unclampedPrivate)},
		{name: "public malformed base64", field: "ServerPublicKey", value: "not-a-key"},
		{name: "public wrong size", field: "ServerPublicKey", value: base64.StdEncoding.EncodeToString([]byte("short"))},
		{name: "public zero", field: "ServerPublicKey", value: base64.StdEncoding.EncodeToString(zeroKey)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := validConfigJSON(t, func(value map[string]any) {
				value[test.field] = test.value
			})
			_, err := ParseConfig(strings.NewReader(input))
			if err == nil {
				t.Fatal("ParseConfig() accepted an invalid key")
			}
			if strings.Contains(err.Error(), test.value) {
				t.Fatal("ParseConfig() exposed a key")
			}
		})
	}
}

func TestParseConfigRejectsInvalidAllowedIP(t *testing.T) {
	tests := []string{
		"",
		"0.0.0.0/0",
		"8.8.8.0/24",
		"fd00::/64",
		"10.8.0.1/24",
		"10.0.0.0/7",
		"172.0.0.0/8",
		"192.0.0.0/8",
	}
	for _, allowedIP := range tests {
		t.Run(allowedIP, func(t *testing.T) {
			input := validConfigJSON(t, func(value map[string]any) {
				value["AllowedIP"] = allowedIP
			})
			if _, err := ParseConfig(strings.NewReader(input)); err == nil {
				t.Fatal("ParseConfig() accepted an invalid AllowedIP")
			}
		})
	}
}

func TestParseConfigRejectsInvalidAddress(t *testing.T) {
	tests := []struct {
		name    string
		address string
		allowed string
	}{
		{name: "missing CIDR", address: "10.8.0.2", allowed: "10.8.0.0/24"},
		{name: "not host CIDR", address: "10.8.0.2/24", allowed: "10.8.0.0/24"},
		{name: "IPv6", address: "fd00::2/128", allowed: "10.8.0.0/24"},
		{name: "public", address: "8.8.8.8/32", allowed: "10.8.0.0/24"},
		{name: "outside AllowedIP", address: "10.9.0.2/32", allowed: "10.8.0.0/24"},
		{name: "network address", address: "10.8.0.0/32", allowed: "10.8.0.0/24"},
		{name: "broadcast address", address: "10.8.0.255/32", allowed: "10.8.0.0/24"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := validConfigJSON(t, func(value map[string]any) {
				value["Address"] = test.address
				value["AllowedIP"] = test.allowed
			})
			if _, err := ParseConfig(strings.NewReader(input)); err == nil {
				t.Fatal("ParseConfig() accepted an invalid Address")
			}
		})
	}
}

func TestParseConfigAcceptsUDPEndpointForms(t *testing.T) {
	for _, endpoint := range []string{
		"relay.example.com:51820",
		"203.0.113.10:51820",
		"[2001:db8::10]:51820",
	} {
		t.Run(endpoint, func(t *testing.T) {
			input := validConfigJSON(t, func(value map[string]any) {
				value["Endpoint"] = endpoint
			})
			if _, err := ParseConfig(strings.NewReader(input)); err != nil {
				t.Fatalf("ParseConfig() error = %v", err)
			}
		})
	}
}

func TestParseConfigRejectsInvalidEndpoint(t *testing.T) {
	tests := []string{
		"",
		"relay.example.com",
		"http://relay.example.com:51820",
		"relay_example.com:51820",
		"-relay.example.com:51820",
		"relay..example.com:51820",
		"999.1.1.1:51820",
		"relay.example.com:0",
		"relay.example.com:65536",
		"relay.example.com:+1",
		"2001:db8::10:51820",
		"[not-ipv6]:51820",
	}
	for _, endpoint := range tests {
		t.Run(endpoint, func(t *testing.T) {
			input := validConfigJSON(t, func(value map[string]any) {
				value["Endpoint"] = endpoint
			})
			if _, err := ParseConfig(strings.NewReader(input)); err == nil {
				t.Fatal("ParseConfig() accepted an invalid Endpoint")
			}
		})
	}
}

func TestParseConfigRejectsInvalidForwardAddress(t *testing.T) {
	tests := []string{
		"relay.example.com:7891",
		"[fd00::1]:7891",
		"10.8.0.1:0",
		"10.9.0.1:7891",
		"10.8.0.0:7891",
		"10.8.0.255:7891",
		"8.8.8.8:7891",
	}
	for _, forwardAddress := range tests {
		t.Run(forwardAddress, func(t *testing.T) {
			input := validConfigJSON(t, func(value map[string]any) {
				value["ForwardAddress"] = forwardAddress
			})
			if _, err := ParseConfig(strings.NewReader(input)); err == nil {
				t.Fatal("ParseConfig() accepted an invalid ForwardAddress")
			}
		})
	}
}

func TestParseConfigRejectsInvalidKeepalive(t *testing.T) {
	for _, keepalive := range []int{-1, 0, 121} {
		t.Run(strconv.Itoa(keepalive), func(t *testing.T) {
			input := validConfigJSON(t, func(value map[string]any) {
				value["KeepaliveSeconds"] = keepalive
			})
			if _, err := ParseConfig(strings.NewReader(input)); err == nil {
				t.Fatal("ParseConfig() accepted an invalid KeepaliveSeconds")
			}
		})
	}
}
