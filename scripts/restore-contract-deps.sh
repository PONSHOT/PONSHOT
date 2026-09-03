#!/usr/bin/env bash
# Restore packages/contracts/lib at the revisions pinned in foundry.lock.
#
# lib/ is not committed. It used to be carried as git submodules, but the checked-in
# gitlinks pointed at .git directories that no longer exist, so a fresh clone got empty
# directories and a build that failed with a confusing missing-import error.
#
# This clones each dependency at the exact revision foundry.lock names and refuses to
# continue if the revision it got is not the revision that was pinned. Tags move; commit
# hashes do not, so the hash is what is verified.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
lib="$root/packages/contracts/lib"
lock="$root/packages/contracts/foundry.lock"

declare -A REPOS=(
  [lib/forge-std]=https://github.com/foundry-rs/forge-std
  [lib/openzeppelin-contracts]=https://github.com/OpenZeppelin/openzeppelin-contracts
)

pinned() { python3 -c "
import json,sys
print(json.load(open('$lock'))['$1']['tag'][sys.argv[1]])" "$2"; }

mkdir -p "$lib"

for path in "${!REPOS[@]}"; do
  dest="$root/packages/contracts/$path"
  name="$(basename "$path")"
  tag="$(pinned "$path" name)"
  rev="$(pinned "$path" rev)"

  if [ -d "$dest/src" ] || [ -d "$dest/contracts" ]; then
    echo "  $name  present, skipping"
    continue
  fi

  echo "  $name  $tag ($rev)"
  rm -rf "$dest"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "${REPOS[$path]}" "$dest"

  got="$(git -C "$dest" rev-parse HEAD)"
  if [ "$got" != "$rev" ]; then
    echo "FATAL: $name@$tag resolved to $got, but foundry.lock pins $rev." >&2
    echo "The tag has been moved or the repository is not the expected one." >&2
    exit 1
  fi
  rm -rf "$dest/.git"
done

echo "contract dependencies restored"
