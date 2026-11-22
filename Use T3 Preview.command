#!/bin/zsh
set -e
cd -- "${0:A:h}"
exec /opt/homebrew/bin/node backend.mjs preview
