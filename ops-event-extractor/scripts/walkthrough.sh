#!/usr/bin/env bash
# End to end on a clean checkout: no network, no credentials, no API account.
# Every command here is one a reviewer can run themselves and get this output.
set -euo pipefail

DB="${OPS_DB:-var/walkthrough.sqlite}"
OPS="node src/cli.js --db=$DB"
NOW="${OPS_NOW:-2026-05-01T14:00:00Z}"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

rm -f "$DB" "$DB-wal" "$DB-shm"
mkdir -p var out

step "1. Prove there is no way to send mail from this source tree"
node src/cli.js scan-nosend

step "2. Prove no real client names or secrets are committed"
node src/cli.js check-leakage

step "3. Create the database"
$OPS init

step "4. Load the synthetic corpus (no live mail is touched)"
$OPS seed-synthetic --now=2026-03-01T00:00:00Z

step "5. Extract, ground, resolve accounts, schedule"
$OPS process --now="$NOW"

step "6. Match obligations against what the agency system actually shows"
$OPS fulfillment --now="$NOW"

step "7. Fire timers and silence escalations"
$OPS sweep --now="$NOW"

step "8. Run it again: a second sweep must repeat nothing"
$OPS sweep --now="$NOW"

step "9. Current state"
$OPS status

step "10. Build agency-system notes and show what would be sent (nothing is sent)"
$OPS qq-dryrun --now="$NOW"

step "11. Export the task list"
$OPS export-csv --out=out/tasks.csv

step "12. Replay from scratch in arrival order and score against the labels"
rm -f var/eval.sqlite var/eval.sqlite-wal var/eval.sqlite-shm
node src/cli.js --db=var/eval.sqlite eval --now=2026-03-01T00:00:00Z --json=out/metrics.json

step "13. Emails sorted into the agency's 18 categories, suspicious ones listed"
node src/cli.js --db=var/eval.sqlite categories

step "14. Patterns learned from model answers during the replay (shadow only; none approved)"
node src/cli.js --db=var/eval.sqlite patterns

step "15. Full test suite"
npm test --silent

printf '\n\033[1mDone.\033[0m Review console: npm run ops -- review --db=%s\n' "$DB"
