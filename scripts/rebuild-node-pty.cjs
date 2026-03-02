#!/usr/bin/env node

const { rebuild } = require("@electron/rebuild");

async function main() {
  const { version: electronVersion } = require("electron/package.json");

  await rebuild({
    buildPath: process.cwd(),
    electronVersion,
    force: true,
    onlyModules: ["node-pty"],
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
