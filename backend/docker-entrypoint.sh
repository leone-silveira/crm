#!/bin/sh
set -e

# Run migrations only on first start (not on restarts)
MIGRATION_LOCK="/tmp/.migrations_done"

if [ ! -f "$MIGRATION_LOCK" ]; then
  echo "Running database migrations and seed..."
  npx prisma db execute --file prisma/pre-migrate.sql --schema prisma/schema.prisma
  npx prisma db execute --file prisma/pre-migrate-2.sql --schema prisma/schema.prisma
  npx prisma db push --skip-generate --accept-data-loss
  npx tsx prisma/seed.ts
  touch "$MIGRATION_LOCK"
  echo "Migrations and seed complete."
else
  echo "Skipping migrations (already done)."
fi

exec node dist/app.js
