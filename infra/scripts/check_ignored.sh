#!/bin/sh
# Fails if .gitignore rules hide source files (see fix/ci-opentofu: a generic `data/`
# rule silently dropped infra/terraform/modules/data/ from a PR).
#
#   sh infra/scripts/check_ignored.sh     # from the repo root; also run in CI
#
# Checks, all limited to infra/, apps/*/src/ and packages/*/src/:
#   1. untracked files that are ignored (catches the incident locally, before commit;
#      on a clean CI checkout this list is always empty)
#   2. tracked files that match an ignore rule (force-added or rule added later)
#   3. a probe file inside every tracked directory would be ignored (a rule that
#      would hide the next file added to an existing source directory)
set -eu
cd "$(git rev-parse --show-toplevel)"

paths=$(ls -d infra apps/*/src packages/*/src 2>/dev/null || true)
[ -n "$paths" ] || { echo "nothing to check"; exit 0; }

fail=0
report() { echo "::error::$1" >&2 2>/dev/null || echo "ERROR: $1" >&2; fail=1; }

# Build artefacts that are meant to be ignored even under these paths.
allowed='/\.terraform/|/node_modules/|/__pycache__/|\.tfstate|\.tfplan$|/terraform\.tfvars$|/backend\.hcl$|\.py[cod]$|\.tsbuildinfo$'

# shellcheck disable=SC2086
untracked=$(git ls-files --others --ignored --exclude-standard -- $paths | grep -Ev "$allowed" || true)
if [ -n "$untracked" ]; then
  report "ignored files in source directories (would never be committed):"
  echo "$untracked" | sed 's/^/  /' >&2
fi

# shellcheck disable=SC2086
tracked_ignored=$(git ls-files --cached --ignored --exclude-standard -- $paths || true)
if [ -n "$tracked_ignored" ]; then
  report "tracked files that match an ignore rule:"
  echo "$tracked_ignored" | sed 's/^/  /' >&2
fi

# shellcheck disable=SC2086
dirs=$(git ls-files -- $paths | sed -n 's|/[^/]*$||p' | sort -u)
for d in $dirs; do
  if git check-ignore -q --no-index "$d/ignore-probe.txt"; then
    rule=$(git check-ignore -v --no-index "$d/ignore-probe.txt" || true)
    report "new files in $d/ would be ignored ($rule)"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "Fix .gitignore (root-anchor generic rules) before committing." >&2
  exit 1
fi
echo "ok: no source files hidden by .gitignore under: $(echo $paths | tr '\n' ' ')"
