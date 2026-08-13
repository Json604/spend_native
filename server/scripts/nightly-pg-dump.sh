#!/usr/bin/env bash
set -euo pipefail

backup_dir="${BACKUP_DIR:-/var/backups/spend}"
mkdir -p "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$backup_dir/spend-$stamp.dump"
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "$file"
find "$backup_dir" -type f -name 'spend-*.dump' -mtime +14 -delete
echo "created $file"
