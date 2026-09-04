#!/usr/bin/env bash
#
# Render start step. Runs from the repository root, on the instance that will serve.
#
# Migrations and the seed run here rather than in the build so that they happen once
# the new release is the one about to take traffic. Both are idempotent: `migrate
# deploy` applies only what is missing, and the seed upserts.
set -euo pipefail

echo "--> applying migrations"
npm run -w @gct/api db:migrate:deploy

# Seeded gas types, suppliers and demo logins. Skip it once you have real data by
# setting SKIP_SEED=1 in the Render dashboard — it is an upsert, so it will not
# destroy anything, but it will keep resurrecting the demo accounts.
if [ "${SKIP_SEED:-0}" != "1" ]; then
  echo "--> seeding reference data"
  npm run -w @gct/api db:seed
fi

echo "--> starting the API"
exec npm run -w @gct/api start
