cask "minty" do
  version "0.2.0"
  sha256 "bb4942c59499e7b3e55d8fa59259c4a798df47984993bac23362dea2b653888c"

  url "https://github.com/delu999/minty/releases/download/v#{version}/Minty-#{version}-arm64-mac.zip"
  name "Minty"
  desc "A minimal terminal manager"
  homepage "https://github.com/delu999/minty"
  depends_on arch: :arm64

  app "Minty.app"
end
