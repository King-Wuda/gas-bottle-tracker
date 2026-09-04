#!/usr/bin/env bash
#
# Render build step. Runs from the repository root.
#
# Two things happen here that do not happen locally, and both are the reason this is a
# script rather than a one-liner in render.yaml:
#
#   1. The Expo web export is built. Render's filesystem is rebuilt on every deploy,
#      so `dist-web` has to be produced here or `/app` serves nothing.
#   2. Migrations are NOT run here. A build runs before the old instance is retired,
#      so migrating at build time would change the schema underneath a server that is
#      still serving the previous release. They run at start instead — see
#      `scripts/render-start.sh`.
set -euo pipefail

echo "--> installing dependencies"
npm ci --include=dev

echo "--> generating the Prisma client"
npm run -w @gct/api prisma:generate

echo "--> building the Expo web export"
# EXPO_PUBLIC_API_URL is deliberately NOT set. The bundle asks the origin it was
# served from (see apps/mobile/src/config.ts), so one build works on any hostname --
# there is no URL to know at build time and no rebuild when it changes.
#
# The QR verification key IS needed at build time: EXPO_PUBLIC_* values are inlined
# into the bundle, and without it the scan step disables itself. It is derived from
# the server's own public key rather than configured separately, because the two
# drifting apart means every scan in the field fails verification -- and they can only
# drift if there are two places to set them.
if [ -z "${QR_SIGN_PUBLIC_KEY_HEX:-}" ]; then
  echo "QR_SIGN_PUBLIC_KEY_HEX is not set. The web build would ship without a" >&2
  echo "verification key and refuse every scan. Set the QR keypair in the Render" >&2
  echo "dashboard (see render.yaml) and redeploy." >&2
  exit 1
fi
export EXPO_PUBLIC_QR_VERIFY_PUBLIC_KEY="$QR_SIGN_PUBLIC_KEY_HEX"
npm run -w @gct/mobile export:web

echo "--> build complete"
