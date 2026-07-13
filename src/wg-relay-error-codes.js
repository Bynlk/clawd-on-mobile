"use strict";

const GO_SIDECAR_ERROR_CODES = Object.freeze([
  "invalid_config",
  "invalid_json",
  "trailing_data",
  "stdin_failed",
  "invalid_private_key",
  "invalid_server_public_key",
  "invalid_allowed_ip",
  "invalid_address",
  "invalid_endpoint",
  "invalid_forward_address",
  "invalid_keepalive",
  "device_create_failed",
  "device_config_failed",
  "device_start_failed",
  "endpoint_resolution_failed",
  "endpoint_resolution_canceled",
  "endpoint_resolution_timeout",
  "listen_failed",
  "listener_failed",
  "device_stopped",
  "listener_stopped",
]);

const SIDECAR_ERROR_CODES = Object.freeze([
  "sidecar_failed",
  "sidecar_protocol_error",
  "sidecar_output_limit",
  "sidecar_disposed",
  "sidecar_invalid_config",
  "sidecar_spawn_failed",
  "sidecar_startup_timeout",
  "sidecar_unexpected_exit",
  "sidecar_start_cancelled",
  "duplicate_ready",
  ...GO_SIDECAR_ERROR_CODES,
]);

const CONNECTION_ERROR_CODES = Object.freeze([
  ...SIDECAR_ERROR_CODES,
  "secret_invalid",
  "health_non_loopback",
  "health_timeout",
  "health_redirect_rejected",
  "health_http_status",
  "health_response_too_large",
  "health_invalid_response",
  "health_request_failed",
  "connection_cancelled",
  "connection_disposed",
  "connection_failed",
  "relay_auth_failed",
  "relay_connect_failed",
  "relay_connect_timeout",
  "relay_not_running",
  "local_connect_failed",
]);

const SIDECAR_ERROR_CODE_SET = new Set(SIDECAR_ERROR_CODES);
const CONNECTION_ERROR_CODE_SET = new Set(CONNECTION_ERROR_CODES);

function normalizeSidecarErrorCode(value) {
  return SIDECAR_ERROR_CODE_SET.has(value) ? value : "sidecar_failed";
}

function normalizeConnectionErrorCode(value) {
  return CONNECTION_ERROR_CODE_SET.has(value) ? value : "connection_failed";
}

module.exports = {
  CONNECTION_ERROR_CODES,
  GO_SIDECAR_ERROR_CODES,
  SIDECAR_ERROR_CODES,
  normalizeConnectionErrorCode,
  normalizeSidecarErrorCode,
};
