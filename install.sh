#!/bin/sh
# Copy the plug-in into OmniFocus's iCloud Plug-Ins folder so it shows up on
# the Mac and syncs to iPhone/iPad. (iCloud doesn't sync symlinks, so this is
# a copy; re-run after editing.)
set -eu
dest="$HOME/Library/Mobile Documents/iCloud~com~omnigroup~OmniFocus/Documents/Plug-Ins"
mkdir -p "$dest"
cp "$(dirname "$0")/omnihub.omnijs" "$dest/omnihub.omnijs"
echo "Installed to $dest/omnihub.omnijs"
