#!/bin/sh
set -e

# One-shot hard reset — set RESET_DB=true in Railway env vars, deploy once, then remove it
if [ "$RESET_DB" = "true" ]; then
  echo "RESET_DB=true detected — wiping database and running fresh migrations..."
  npx prisma migrate reset --force
  echo "Reset complete."
  exec node dist/app.js
fi

echo "Syncing database schema..."

# db push safely adds missing columns/tables/indexes without dropping data.
# It handles the case where the DB was created via db push (no migration history)
# and avoids failures from CREATE INDEX on already-existing indexes.
npx prisma db push --accept-data-loss

# Seed is idempotent (uses upserts) — safe to run every time
npx tsx prisma/seed.ts
echo "Schema sync and seed complete."

exec node dist/app.js
