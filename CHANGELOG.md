# Changelog

All notable changes to OpenDungen will be documented here.
Format follows Keep a Changelog (https://keepachangelog.com/).
Versioning follows Semantic Versioning.

## [Unreleased]

## [0.1.0] - 2026-10-13

### Added
- Self-hostable AI text adventure engine with bring-your-own-LLM
- Provider abstraction: OpenAI, Anthropic, Ollama (local and
  cloud), and any OpenAI-compatible endpoint
- Real-time streaming generation with abort
- Retry, undo, and in-place edit of story actions
- Input modes: Do, Say, Story, Continue
- Story cards (keyword-triggered memory)
- Plot essentials, author's note, and auto-summary context layers
- DCP-style compressed ranges with per-turn restore
- Scripts engine (QuickJS, sandboxed, per-scenario and per-story)
- Scenario authoring and duplication
- Import and export of full stories and accounts
- Dual-driver database: Cloudflare D1, libSQL, and local SQLite
- Two deployment paths: Cloudflare Workers and Node
- Single-user and multi-user auth modes
- Rate limiting, SSRF protection, CSRF, security headers
- Structured logging with request IDs
- Light and dark themes
- Continuous-column story view
- Command palette (Cmd+K)
- Layered prompt architecture with eval harness

### Known limitations
- QuickJS WASM on real Cloudflare Workers is unverified
- Story sharing and publishing are not implemented

[Unreleased]: https://github.com/TheForgivenOne/opendungen/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TheForgivenOne/opendungen/releases/tag/v0.1.0