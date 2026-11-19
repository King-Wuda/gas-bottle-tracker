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

# Projects numbered in the old 6-3-1-2 shape (all test data) are deleted, with
# everything on them, and the database then enforces 5-3-1-2 for every project. Does
# nothing once they are gone. Not fatal: if it fails, the API still starts, the old rows
# simply stay until the next start retries — the new format is enforced for every new
# or changed number by the migration either way.
echo "--> removing old-format projects"
npm run -w @gct/api cleanup:legacy-projects || echo "--> old-format project clean-up failed; will retry next start"

# Seeded gas types, suppliers and demo logins. Skip it once you have real data by
# setting SKIP_SEED=1 in the Render dashboard — it is an upsert, so it will not
# destroy anything, but it will keep resurrecting the demo accounts.
if [ "${SKIP_SEED:-0}" != "1" ]; then
  echo "--> seeding reference data"
  npm run -w @gct/api db:seed
fi

echo "--> starting the API"
exec npm run -w @gct/api start
