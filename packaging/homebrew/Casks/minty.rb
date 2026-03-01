cask "minty" do
  version "0.1.0"
  arch arm: "arm64", intel: "x64"

  sha256 arm: "REPLACE_WITH_ARM64_SHA256", intel: "REPLACE_WITH_X64_SHA256"

  url "https://github.com/REPO_OWNER/minty/releases/download/v#{version}/Minty-#{version}-#{arch}-mac.zip"
  name "Minty"
  desc "A minimal terminal manager"
  homepage "https://github.com/REPO_OWNER/minty"

  app "Minty.app"
end
