# Security Policy

## Reporting a Vulnerability

Please do not open public issues for security problems.

Report privately via GitHub Security Advisories at
https://github.com/TheForgivenOne/opendungen/security/advisories/new
or by email to security@example.com.

<!-- TODO: replace placeholder security@example.com email with a real one. -->

We aim to acknowledge reports within 72 hours and provide a fix
or mitigation within 30 days.

## Scope

In scope:
  - Authentication and session handling
  - Authorization and ownership checks
  - SSRF in provider URL handling
  - CSRF
  - SQL injection
  - Stored or reflected XSS
  - Secrets exposure (API keys, session tokens, SESSION_SECRET)

Out of scope:
  - Denial of service via legitimate provider requests
  - Issues in third-party LLM providers
  - Social engineering

## Supported Versions

Only the latest release receives security fixes.