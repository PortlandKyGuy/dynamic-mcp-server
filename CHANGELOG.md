# Changelog

All notable changes to this project will be documented in this file.

## 1.5.3 - 2026-02-19
- PR #9: Fix npm audit vulnerabilities

## 1.5.1 - 2026-01-15
- PR #8: Automate version bumps on merge

## 1.5.2 - 2026-01-15
- Patch release to roll up dependency security updates without overrides.

## 1.5.1 - 2026-01-15
- Update MCP SDK to resolve security advisories (no overrides required).

## 1.5.0 - 2026-01-15
- Add `serverName` to all log entries for easier multi-server tracing.
- Warn when `payloadMaxChars` is set but payload logging is disabled.
- Add logging/config tests for CLI errors, payload truncation, and timeout handling.
- Use V8 coverage provider and document logging updates.
- Exit gracefully when stdin closes to stop background MCP servers.
