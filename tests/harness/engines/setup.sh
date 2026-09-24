#!/bin/sh
# The engine comparison's engines, pinned: Pi from npm into this folder,
# ripgrep and fd (both engines search with them, and download them on first
# use, which a box with no network cannot) into bin/. OpenCode is its own
# installer's, at ~/.opencode/bin; the harness records the version it ran.
set -eu
cd "$(dirname "$0")"
npm install --no-audit --no-fund
mkdir -p bin dl
fetch() { [ -f "dl/$1" ] || curl -sSL -o "dl/$1" "$2"; echo "$3  dl/$1" | sha256sum -c -; }
fetch rg.tar.gz https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep-15.1.0-x86_64-unknown-linux-musl.tar.gz \
  1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599
fetch fd.tar.gz https://github.com/sharkdp/fd/releases/download/v10.5.0/fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz \
  761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7
tar -xzf dl/rg.tar.gz -C dl && cp dl/ripgrep-15.1.0-x86_64-unknown-linux-musl/rg bin/
tar -xzf dl/fd.tar.gz -C dl && cp dl/fd-v10.5.0-x86_64-unknown-linux-musl/fd bin/
bin/rg --version | head -1
bin/fd --version
