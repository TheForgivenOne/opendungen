# Release

This file tracks the OpenDungen v1 release checklist.

## v0.1.0 release checklist

### Repo readiness
- [ ] LICENSE present (Apache-2.0)
- [ ] SECURITY.md present (vulnerability reporting, scope, supported versions)
- [ ] CHANGELOG.md present with [0.1.0] section
- [ ] README has License, Security, Changelog, Screenshots sections
- [ ] docs/screenshot.png replaced with a real screenshot before announcement
- [ ] Version is `0.1.0` in `package.json`, `apps/api/package.json`, `apps/web/package.json`
- [ ] `GET /api/settings/instance` returns `"0.1.0"`

### Tests
- [ ] `pnpm -r typecheck` passes
- [ ] `pnpm -r lint` passes
- [ ] `pnpm -r format` passes
- [ ] `pnpm -r test` passes
- [ ] `pnpm -r build` passes

### CI
- [ ] `.github/workflows/ci.yml` runs on push and PR
- [ ] install, typecheck, lint, format, test, build steps present
- [ ] dependency audit step (`pnpm audit --prod --audit-level=high`, continue-on-error)
- [ ] e2e job present when e2e/ exists

### Release artifacts
- [ ] Git tag v0.1.0 (user action)
- [ ] GitHub release published (user action)