#!/usr/bin/env bash
set -euo pipefail

mkdir -p /logs/verifier
log_file=/logs/verifier/conformance.log
reward_file=/logs/verifier/reward.txt

export AGENT_HARBOR_REQUIRE_CLIS=1
export PYTHONDONTWRITEBYTECODE=1

cd /app
set +e
npm test 2>&1 | tee "$log_file"
status=${PIPESTATUS[0]}
set -e

if [[ "$status" -eq 0 ]]; then
    printf '1\n' > "$reward_file"
else
    printf '0\n' > "$reward_file"
fi

exit "$status"
