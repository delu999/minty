# Homebrew (Cask) setup for Minty

This project is configured to publish a macOS zip artifact that can be installed with Homebrew Cask.

## 1) Build release artifact

Install dependencies (once):

```bash
bun install
```

Build and package:

```bash
bun run package:mac
```

Expected artifact location:

```text
release/
```

## 2) Publish GitHub release

Create a GitHub release tagged as `v<version>` and upload the generated `Minty-<version>-mac.zip`.

Example for current version:

```text
v0.1.0
Minty-0.1.0-arm64-mac.zip
```

Compute SHA256 for each uploaded archive:

```bash
shasum -a 256 release/Minty-0.1.0-arm64-mac.zip
# optional if you also publish Intel:
# shasum -a 256 release/Minty-0.1.0-x64-mac.zip
```

## 3) Create/update your Homebrew tap

Create a tap repo named:

```text
homebrew-minty
```

Copy `packaging/homebrew/Casks/minty.rb` into the tap repo at:

```text
Casks/minty.rb
```

Then replace:
- `REPO_OWNER` with your GitHub username/org
- `version` with the release version
- `sha256 arm` with the arm64 checksum
- `sha256 intel` with the x64 checksum (if publishing Intel build)

## 4) Install

```bash
brew tap REPO_OWNER/minty
brew install --cask minty
```

Or one command:

```bash
brew install --cask REPO_OWNER/minty/minty
```

## Public vs private repository

- Public is strongly recommended and simplest. It works out-of-the-box for all users.
- Private can work, but users must authenticate to access release assets and tap contents. That adds setup friction and is not ideal for general distribution.
