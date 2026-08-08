#!/usr/bin/env bash
# Publish a new build so installed devices can update themselves.
#
# Usage:  scripts/release.sh 2.1.0 "What changed in this build"
#
# Bumps versionCode, builds a signed release APK, uploads it beside a manifest
# on the VPS, and points latest.json at it. Devices pick it up on next launch.
#
# versionCode is what Android compares, so it must increase every release. The
# manifest is written LAST: until it changes, no device sees a half-uploaded
# APK, and a failed upload leaves everyone on the previous version rather than
# chasing a file that does not exist.
set -euo pipefail

VERSION_NAME="${1:-}"
NOTES="${2:-}"
if [[ -z "$VERSION_NAME" ]]; then
  echo "usage: scripts/release.sh <versionName> [notes]" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRADLE_FILE="$ROOT/android/app/build.gradle"
REMOTE="${SPEND_DEPLOY_HOST:-droplet}"
REMOTE_DIR="/var/www/spend/downloads"
BASE_URL="https://spend.kartikey.xyz/downloads"

CURRENT_CODE="$(grep -E '^\s*versionCode ' "$GRADLE_FILE" | grep -oE '[0-9]+')"
NEXT_CODE=$((CURRENT_CODE + 1))
echo "==> versionCode $CURRENT_CODE -> $NEXT_CODE, versionName $VERSION_NAME"

# Keep the working tree honest: the build must match what is committed.
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "!!  Working tree has uncommitted changes. Commit them so the published"
  echo "    APK corresponds to a known revision, then re-run." >&2
  exit 1
fi

sed -i '' -E "s/^(\s*versionCode )[0-9]+/\1$NEXT_CODE/" "$GRADLE_FILE"
sed -i '' -E "s/^(\s*versionName )\".*\"/\1\"$VERSION_NAME\"/" "$GRADLE_FILE"

echo "==> building"
( cd "$ROOT/android" && ./gradlew assembleRelease --no-daemon -q )

APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
[[ -f "$APK" ]] || { echo "build produced no APK" >&2; exit 1; }

SHA="$(shasum -a 256 "$APK" | awk '{print $1}')"
FILENAME="spend-$VERSION_NAME-$NEXT_CODE.apk"
echo "==> sha256 $SHA"

echo "==> uploading $FILENAME"
ssh "$REMOTE" "mkdir -p $REMOTE_DIR"
scp -q "$APK" "$REMOTE:$REMOTE_DIR/$FILENAME"

MANIFEST="$(cat <<JSON
{
  "versionCode": $NEXT_CODE,
  "versionName": "$VERSION_NAME",
  "url": "$BASE_URL/$FILENAME",
  "sha256": "$SHA",
  "notes": $(printf '%s' "$NOTES" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
}
JSON
)"
# Written last, and atomically, so a device never reads a manifest that points
# at an APK still uploading.
printf '%s' "$MANIFEST" | ssh "$REMOTE" "cat > $REMOTE_DIR/.latest.json.tmp && mv $REMOTE_DIR/.latest.json.tmp $REMOTE_DIR/latest.json"

git -C "$ROOT" add "$GRADLE_FILE"
git -C "$ROOT" commit -q -m "Release $VERSION_NAME (versionCode $NEXT_CODE)"
git -C "$ROOT" tag -a "v$VERSION_NAME" -m "Release $VERSION_NAME"

echo "==> published $VERSION_NAME"
echo "    $BASE_URL/$FILENAME"
echo "    devices update on next launch; commit tagged v$VERSION_NAME"
