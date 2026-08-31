# Packaging

`nativetron.config.json` is the app-bundle template. Binary and resource paths are relative to the configuration file.

```sh
node packaging/package.mjs --check
node packaging/package.mjs --output dist
node packaging/release.mjs --output dist
node packaging/install.mjs 'dist/Nativetron.app'
```

`package.mjs` creates a macOS `.app` and zip archive. `release.mjs` also writes `SHA256SUMS.json`. `install.mjs` stages a complete copy before replacing an existing bundle; the same command performs upgrades.

## Configuration

Required fields:

- `name`
- `executable`
- `bundleIdentifier`
- SemVer `version`
- `minimumSystemVersion`
- `mainBinary`
- `rendererBinary`

Optional fields:

- `buildVersion`
- `category`
- `icon`: `.icns` path
- `resources`: paths copied under `Contents/Resources`
- `documentTypes`: `name`, `extensions`, and `role`
- `urlSchemes`: `name` and `schemes`
- `entitlements`: plist passed to `codesign`

File and URL associations are registered in `Info.plist`. Runtime delivery of open-file and open-URL events is not implemented.

## Signing and notarization

```sh
node packaging/package.mjs \
  --sign 'Developer ID Application: Example (TEAMID)' \
  --notary-profile nativetron-notary \
  --dmg
```

The notary profile must already exist in the login keychain for `xcrun notarytool`. Notarization requires a non-ad-hoc signing identity. Credentials are never accepted as command arguments or written by these tools.

Ad-hoc local signing:

```sh
node packaging/package.mjs --sign -
```

Signing and notarization require local Apple credentials and are not exercised by the self-test. Bundle creation, launch, installation, archive generation, and checksums are covered by:

```sh
node packaging/package.test.mjs
```
