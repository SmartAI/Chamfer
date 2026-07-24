#!/bin/bash
# Four-arm private-test showdown. Sequential. Test set is read here for the
# FIRST and ONLY time per the pre-registered plan.
cd "$(git rev-parse --show-toplevel)" || exit 1
CF=benchmarks/private/testset-v1/cases.json
echo "=== v0 $(date +%H:%M:%S) ==="
node benchmarks/runners/runBatch.mjs --arm=pi --arm-dir=benchmarks/arms/v0 --cases-file=$CF --reps=3 --model=claude-opus-4-8; echo "v0 exit $?"
echo "=== v1 $(date +%H:%M:%S) ==="
node benchmarks/runners/runBatch.mjs --arm=pi --arm-dir=benchmarks/arms/v1 --cases-file=$CF --reps=3 --model=claude-opus-4-8; echo "v1 exit $?"
echo "=== claude $(date +%H:%M:%S) ==="
node benchmarks/runners/runBatch.mjs --arm=claude --arm-dir=benchmarks/arms/v0 --cases-file=$CF --reps=3 --model=claude-opus-4-8; echo "claude exit $?"
echo "=== codex $(date +%H:%M:%S) ==="
node benchmarks/runners/runBatch.mjs --arm=codex --arm-dir=benchmarks/arms/v0 --cases-file=$CF --reps=3 --model=gpt-5.6-luna; echo "codex exit $?"
echo "=== SHOWDOWN DONE $(date +%H:%M:%S) ==="
