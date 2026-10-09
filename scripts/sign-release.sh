#!/usr/bin/env bash
# Import GPG_PRIVATE_KEY into a fresh keyring and sign the checksums in the
# directory given as the only argument.
#
# The tag job and the signing rehearsal both call this. The import line is
# the release path: an armoured secret on stdin, no passphrase at import
# time. The passphrase is GPG_PASSPHRASE, and checksums.mjs reads it when it
# signs. A rehearsal sets GPG_FINGERPRINT and GPG_PUBLIC_KEY; a tag leaves
# both unset, so the signature is checked against release-signing-key.asc.
set -euo pipefail

dir=${1:-}
if [ -z "$dir" ] || [ "$#" -ne 1 ]; then
  echo "usage: sign-release.sh <dir>" >&2
  exit 2
fi
if [ -z "${GPG_PRIVATE_KEY:-}" ] || [ -z "${GPG_PASSPHRASE:-}" ]; then
  echo "GPG_PRIVATE_KEY and GPG_PASSPHRASE must be set." >&2
  exit 1
fi

umask 077
gnupg=$(mktemp -d)
chmod 700 "$gnupg"
cleanup() { rm -rf "$gnupg"; }
trap cleanup EXIT

printf '%s\n' "$GPG_PRIVATE_KEY" | gpg --batch --homedir "$gnupg" --import
GNUPGHOME="$gnupg" node scripts/checksums.mjs "$dir" --sign
