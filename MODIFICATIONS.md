# Modifications

This document describes the modifications made to the original project.

## Original Project

- **Name**: Clawd on Desk
- **Author**: rullerzhou-afk
- **Repository**: https://github.com/rullerzhou-afk/clawd-on-desk
- **License**: AGPL-3.0-only

## Fork Information

- **Fork Name**: Clawd on Mobile
- **Fork Author**: Bynlk
- **Repository**: https://github.com/Bynlk/clawd-on-mobile
- **Fork Date**: 2025-06-07

## Changes Made

### 1. Android Companion App
- Added a native Android client (`android/`) that connects to the desktop server via LAN SSE
- Supports QR code pairing, notification-based permission approval, and SVG/APNG animation rendering
- Full support for three themes: Clawd, Calico, Cloudling

### 2. Desktop Server Enhancements
- Added WebSocket-based LAN communication server for mobile client connectivity
- Added QR code generation endpoint for mobile pairing
- Enhanced HTTP server with SSE streaming support for real-time state synchronization

### 3. Project Configuration
- Updated package name from `clawd-on-desk` to `clawd-on-mobile`
- Updated product name from "Clawd on Desk" to "Clawd on Mobile"
- Updated author information
- Updated build artifact names
- Updated publish configuration to point to the fork repository

## License Compliance

This fork maintains the original AGPL-3.0-only license for all source code modifications. The original copyright notices and license terms are preserved as required by the AGPL-3.0 license.

## Attribution

All original work remains credited to the original authors. This fork is a community contribution and is not officially affiliated with the original Clawd on Desk project.
