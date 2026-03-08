# Fork Releases

This repo now supports a fork-specific release channel modeled after the Veranote release flow.

## What It Does

- Builds a fork-branded app identity for release builds only
- Publishes updater artifacts to GitHub Releases in the fork repo
- Keeps upstream RunMaestro releases visible as awareness only inside the app

## Fork Release Identity

Fork release builds use:

- Product name: `Maestro`
- App ID: `com.vervetechgroup.maestro.fork`
- GitHub release repo: `hannahmwright/Maestro`

Default local development and normal upstream packaging stay unchanged.

## Local Release Command

Build signed/notarized fork artifacts and upload them to the fork's GitHub Releases page:

```bash
npm run publish:fork:mac
```

This expects:

- Apple signing identity already available in the local keychain
- `gh` authenticated for `hannahmwright/Maestro`
- The release tag to match the package version, or pass an explicit tag:

```bash
node scripts/publish-fork-release.mjs v0.15.1
```

## GitHub Actions Workflow

The workflow is at [`.github/workflows/fork-release.yml`](/Users/hannahwright/Documents/Code/Maestro/.github/workflows/fork-release.yml).

It triggers on:

- pushed tags matching `v*`
- manual workflow dispatch

Required GitHub Actions secrets:

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`

## Important CI Constraint

The Apple ID and app-specific password are not enough by themselves for GitHub-hosted mac signing. The workflow also needs a Developer ID Application certificate exported as base64 `.p12` in `APPLE_CERTIFICATE`, plus its import password in `APPLE_CERTIFICATE_PASSWORD`.

## Update Behavior

- The installable update channel follows the fork release repo
- Upstream `RunMaestro/Maestro` releases stay visible in the update UI as a separate informational source
