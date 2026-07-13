package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"

	"golang.zx2c4.com/wireguard/device"
)

type Config struct {
	PrivateKey       string
	Address          string
	ServerPublicKey  string
	Endpoint         string
	AllowedIP        string
	ForwardAddress   string
	KeepaliveSeconds int
}

type configError struct {
	code string
}

func (err *configError) Error() string {
	return err.code
}

func (err *configError) ErrorCode() string {
	return err.code
}

func ParseConfig(input io.Reader) (Config, error) {
	decoder := json.NewDecoder(input)
	config, err := decodeConfig(decoder)
	if err != nil {
		return Config{}, err
	}

	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Config{}, &configError{code: "trailing_data"}
	}
	return config, nil
}

var configFieldNames = map[string]struct{}{
	"PrivateKey":       {},
	"Address":          {},
	"ServerPublicKey":  {},
	"Endpoint":         {},
	"AllowedIP":        {},
	"ForwardAddress":   {},
	"KeepaliveSeconds": {},
}

func decodeConfig(decoder *json.Decoder) (Config, error) {
	decoder.DisallowUnknownFields()
	var raw json.RawMessage
	if err := decoder.Decode(&raw); err != nil || !hasExactConfigFields(raw) {
		return Config{}, &configError{code: "invalid_json"}
	}
	valueDecoder := json.NewDecoder(bytes.NewReader(raw))
	valueDecoder.DisallowUnknownFields()
	var config Config
	if err := valueDecoder.Decode(&config); err != nil {
		return Config{}, &configError{code: "invalid_json"}
	}
	return validateConfig(config)
}

func hasExactConfigFields(raw []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return false
	}
	seen := make(map[string]struct{}, len(configFieldNames))
	for decoder.More() {
		token, err := decoder.Token()
		name, ok := token.(string)
		if err != nil || !ok {
			return false
		}
		if _, allowed := configFieldNames[name]; !allowed {
			return false
		}
		if _, duplicate := seen[name]; duplicate {
			return false
		}
		seen[name] = struct{}{}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return false
		}
	}
	closing, err := decoder.Token()
	return err == nil && closing == json.Delim('}') && len(seen) == len(configFieldNames)
}

func validateConfig(config Config) (Config, error) {
	if !validPrivateKey(config.PrivateKey) {
		return Config{}, &configError{code: "invalid_private_key"}
	}
	if !validPublicKey(config.ServerPublicKey) {
		return Config{}, &configError{code: "invalid_server_public_key"}
	}
	allowedIP, err := parsePrivateIPv4Prefix(config.AllowedIP)
	if err != nil {
		return Config{}, err
	}
	if err := validateAddress(config.Address, allowedIP); err != nil {
		return Config{}, err
	}
	if err := validateEndpoint(config.Endpoint); err != nil {
		return Config{}, err
	}
	if err := validateForwardAddress(config.ForwardAddress, allowedIP); err != nil {
		return Config{}, err
	}
	if config.KeepaliveSeconds < 1 || config.KeepaliveSeconds > 120 {
		return Config{}, &configError{code: "invalid_keepalive"}
	}
	return config, nil
}

func decodeKey(value string) ([]byte, bool) {
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(decoded) != device.NoisePrivateKeySize || base64.StdEncoding.EncodeToString(decoded) != value {
		return nil, false
	}
	return decoded, true
}

func validPrivateKey(value string) bool {
	decoded, ok := decodeKey(value)
	if !ok || decoded[0]&7 != 0 || decoded[31]&128 != 0 || decoded[31]&64 == 0 {
		return false
	}
	var key device.NoisePrivateKey
	return key.FromHex(hex.EncodeToString(decoded)) == nil && !key.IsZero()
}

func validPublicKey(value string) bool {
	decoded, ok := decodeKey(value)
	if !ok {
		return false
	}
	var key device.NoisePublicKey
	return key.FromHex(hex.EncodeToString(decoded)) == nil && !key.IsZero()
}

var privateIPv4Blocks = [...]netip.Prefix{
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
}

func parsePrivateIPv4Prefix(value string) (netip.Prefix, error) {
	prefix, err := netip.ParsePrefix(value)
	if err != nil || !prefix.Addr().Is4() || prefix != prefix.Masked() || prefix.String() != value {
		return netip.Prefix{}, &configError{code: "invalid_allowed_ip"}
	}
	for _, privateBlock := range privateIPv4Blocks {
		if prefix.Bits() >= privateBlock.Bits() && privateBlock.Contains(prefix.Addr()) {
			return prefix, nil
		}
	}
	return netip.Prefix{}, &configError{code: "invalid_allowed_ip"}
}

func validateAddress(value string, allowedIP netip.Prefix) error {
	prefix, err := netip.ParsePrefix(value)
	if err != nil || !prefix.Addr().Is4() || prefix.Bits() != 32 || prefix.String() != value ||
		!prefix.Addr().IsPrivate() || !isUsableIPv4Host(allowedIP, prefix.Addr()) {
		return &configError{code: "invalid_address"}
	}
	return nil
}

func isUsableIPv4Host(prefix netip.Prefix, address netip.Addr) bool {
	if !prefix.Addr().Is4() || !address.Is4() || !prefix.Contains(address) {
		return false
	}
	if prefix.Bits() >= 31 {
		return true
	}
	base := binary.BigEndian.Uint32(prefix.Addr().AsSlice())
	host := binary.BigEndian.Uint32(address.AsSlice())
	hostMask := ^uint32(0) >> prefix.Bits()
	return host != base && host != base|hostMask
}

func validateEndpoint(value string) error {
	host, portText, err := net.SplitHostPort(value)
	if err != nil || host == "" || !validPort(portText) {
		return &configError{code: "invalid_endpoint"}
	}
	bracketed := strings.HasPrefix(value, "[")
	if address, parseErr := netip.ParseAddr(host); parseErr == nil {
		if address.Zone() != "" || address.Is4() && bracketed {
			return &configError{code: "invalid_endpoint"}
		}
		return nil
	}
	if bracketed || strings.Contains(host, ":") || !validDNSName(host) {
		return &configError{code: "invalid_endpoint"}
	}
	return nil
}

func validPort(value string) bool {
	if value == "" {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	port, err := strconv.ParseUint(value, 10, 16)
	return err == nil && port > 0
}

func validDNSName(value string) bool {
	if len(value) == 0 || len(value) > 254 {
		return false
	}
	name := strings.TrimSuffix(value, ".")
	if len(name) == 0 || len(name) > 253 {
		return false
	}
	hasLetter := false
	for _, label := range strings.Split(name, ".") {
		if len(label) == 0 || len(label) > 63 || !isASCIIAlphaNumeric(label[0]) || !isASCIIAlphaNumeric(label[len(label)-1]) {
			return false
		}
		for index := range len(label) {
			character := label[index]
			if character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' {
				hasLetter = true
			}
			if !isASCIIAlphaNumeric(character) && character != '-' {
				return false
			}
		}
	}
	return hasLetter
}

func isASCIIAlphaNumeric(character byte) bool {
	return character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' || character >= '0' && character <= '9'
}

func validateForwardAddress(value string, allowedIP netip.Prefix) error {
	address, err := netip.ParseAddrPort(value)
	if err != nil || address.String() != value || !address.Addr().Is4() || address.Port() == 0 ||
		!isUsableIPv4Host(allowedIP, address.Addr()) {
		return &configError{code: "invalid_forward_address"}
	}
	return nil
}
