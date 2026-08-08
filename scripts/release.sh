#!/usr/bin/env bash
# Publish a new build so installed devices can update themselves.
#
# Usage:  scripts/release.sh 2.1.0 "What changed in this build"
#
# Bumps versionCode, builds a signed release APK, uploads it, and points
# latest.json at it. Devices pick it up on next launch.
#
# The versionCode is read back out of the BUILT APK before anything is
# published. An earlier version of this script edited build.gradle with a GNU
# sed pattern (\s) that BSD sed silently ignores, so the bump never applied: it
# uploaded a versionCode 2 APK behind a manifest advertising versionCode 3.
# Devices would have installed it, remained on 2, and been offered the same
# update forever. Trusting a text edit is not the same as checking the artifact.
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
ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
AAPT="$(ls "$ANDROID_HOME"/build-tools/*/aapt 2>/dev/null | sort | tail -1 || true)"

if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
  echo "!!  Working tree has uncommitted changes. Commit them so the published" >&2
  echo "    APK corresponds to a known revision, then re-run." >&2
  exit 1
fi

if git -C "$ROOT" rev-parse "v$VERSION_NAME" >/dev/null 2>&1; then
  echo "!!  Tag v$VERSION_NAME already exists. Pick a new version name." >&2
  exit 1
fi

CURRENT_CODE="$(grep -E '^[[:space:]]*versionCode ' "$GRADLE_FILE" | grep -oE '[0-9]+')"
NEXT_CODE=$((CURRENT_CODE + 1))
echo "==> versionCode $CURRENT_CODE -> $NEXT_CODE, versionName $VERSION_NAME"

# [[:space:]] rather than \s: BSD sed does not understand \s and fails silently.
sed -i '' -E "s/^([[:space:]]*versionCode )[0-9]+/\1$NEXT_CODE/" "$GRADLE_FILE"
sed -i '' -E "s/^([[:space:]]*versionName )\".*\"/\1\"$VERSION_NAME\"/" "$GRADLE_FILE"

APPLIED_CODE="$(grep -E '^[[:space:]]*versionCode ' "$GRADLE_FILE" | grep -oE '[0-9]+')"
APPLIED_NAME="$(grep -E '^[[:space:]]*versionName ' "$GRADLE_FILE" | sed -E 's/.*"(.*)".*/\1/')"
if [[ "$APPLIED_CODE" != "$NEXT_CODE" || "$APPLIED_NAME" != "$VERSION_NAME" ]]; then
  echo "!!  Version bump did not apply (build.gradle still says $APPLIED_CODE/$APPLIED_NAME)." >&2
  git -C "$ROOT" checkout -- "$GRADLE_FILE"
  exit 1
fi

echo "==> building"
( cd "$ROOT/android" && ./gradlew assembleRelease --no-daemon -q )

APK="$ROOT/android/app/build/outputs/apk/release/app-release.apk"
[[ -f "$APK" ]] || { echo "build produced no APK" >&2; exit 1; }

# Verify what was actually built, not what we asked for.
if [[ -n "$AAPT" ]]; then
  BADGING="$("$AAPT" dump badging "$APK")"
  APK_CODE="$(sed -nE "s/.*versionCode='([0-9]+)'.*/\1/p" <<<"$BADGING" | head -1)"
  APK_NAME="$(sed -nE "s/.*versionName='([^']*)'.*/\1/p" <<<"$BADGING" | head -1)"
  echo "==> APK reports versionCode $APK_CODE, versionName $APK_NAME"
  if [[ "$APK_CODE" != "$NEXT_CODE" || "$APK_NAME" != "$VERSION_NAME" ]]; then
    echo "!!  Built APK does not match the intended version. Refusing to publish:" >&2
    echo "    a manifest ahead of its APK puts every device in an update loop." >&2
    exit 1
  fi
else
  echo "!!  aapt not found; cannot verify the built APK's version. Refusing to" >&2
  echo "    publish unverified — set ANDROID_HOME or install build-tools." >&2
  exit 1
fi

SHA="$(shasum -a 256 "$APK" | awk '{print $1}')"
FILENAME="spend-$VERSION_NAME-$NEXT_CODE.apk"
echo "==> sha256 $SHA"

# Commit before publishing, so anything reachable by a device corresponds to a
# revision that exists.
git -C "$ROOT" add "$GRADLE_FILE"
git -C "$ROOT" commit -q -m "Release $VERSION_NAME (versionCode $NEXT_CODE)"
git -C "$ROOT" tag -a "v$VERSION_NAME" -m "Release $VERSION_NAME"

echo "==> uploading $FILENAME"
ssh "$REMOTE" "mkdir -p $REMOTE_DIR"
scp -q "$APK" "$REMOTE:$REMOTE_DIR/$FILENAME"

# Confirm the uploaded bytes are the bytes we checksummed.
REMOTE_SHA="$(ssh "$REMOTE" "sha256sum $REMOTE_DIR/$FILENAME | awk '{print \$1}'")"
if [[ "$REMOTE_SHA" != "$SHA" ]]; then
  echo "!!  Uploaded APK checksum does not match the local build. Not publishing." >&2
  exit 1
fi

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

echo "==> published $VERSION_NAME"
echo "    $BASE_URL/$FILENAME"
echo "    devices update on next launch; commit tagged v$VERSION_NAME"
