# macOS Distribution

Use this path for macOS DMGs that people can download and open under Gatekeeper without the unsigned-developer approval flow. Release builds also produce a signed ZIP and `latest-mac.yml` for in-app updates.

## Requirements

- macOS build host with the current Xcode command line tools.
- Apple Developer Program membership.
- A `Developer ID Application` certificate for the Apple team, available either in the local keychain or through electron-builder's `CSC_LINK` / `CSC_KEY_PASSWORD` variables.
- Apple notarization credentials. Prefer an App Store Connect API key for CI, or a notarytool keychain profile for local builds.

## Local Setup

Check that the Developer ID identity is visible:

```bash
security find-identity -v -p codesigning
```

For a local keychain profile:

```bash
xcrun notarytool store-credentials "tessera-notary" \
  --apple-id "you@example.com" \
  --team-id "TEAMID1234" \
  --password "app-specific-password"

export APPLE_KEYCHAIN_PROFILE=tessera-notary
```

If more than one Developer ID identity is installed, pin the certificate:

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID1234)"
```

Build signed and notarized DMGs plus signed ZIP update artifacts:

```bash
npm run electron:build:mac-arm64:signed
npm run electron:build:mac-x64:signed
```

Or build the universal release artifacts used by the desktop release workflow:

```bash
npm run electron:build:mac:signed
```

The notarization helper streams `notarytool` output so CI logs show the upload progress, submission ID, and `In Progress` polling status. It defaults to a `45m` notary wait timeout; override with `TESSERA_NOTARY_TIMEOUT=90m` if Apple notarization is slow. It also disables S3 transfer acceleration by default for more predictable CI uploads; set `TESSERA_NOTARY_DISABLE_S3_ACCELERATION=0` to use Apple's default upload path.

The final DMG is signed with the Developer ID Application identity before notarization. The helper fails early if the DMG has no usable code signature, then validates the stapled ticket and Gatekeeper assessment after notarization. The ZIP update artifact is generated from the same signed app bundle and is referenced by `latest-mac.yml` for Electron auto-update.

## GitHub Actions Secrets

The desktop release workflow signs and notarizes macOS builds when these secrets are configured:

| Secret | Purpose |
|--------|---------|
| `MACOS_CSC_LINK` | Base64-encoded `.p12` Developer ID Application certificate, or a secure URL supported by electron-builder |
| `MACOS_CSC_KEY_PASSWORD` | Password for the `.p12` certificate |
| `APPLE_API_KEY_BASE64` | Base64-encoded App Store Connect API key `.p8` file |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |

Apple ID notarization also works if the API key secrets are not set:

| Secret | Purpose |
|--------|---------|
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for the Apple ID |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

## Verification

After a signed build, verify release artifacts:

```bash
xcrun stapler validate release/Tessera-*-macos-universal.dmg
spctl --assess --type open --context context:primary-signature --verbose release/Tessera-*-macos-universal.dmg
test -f release/Tessera-*-macos-universal.zip
test -f release/latest-mac.yml
```

The unsigned scripts remain available for local packaging tests only:

```bash
npm run electron:build:mac-arm64
npm run electron:build:mac-x64
```
