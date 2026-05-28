#!/usr/bin/env bash
# Set the DOCKERHUB_TOKEN GitHub Actions secret on cativo23/wizdaa-takehome.
# Prompts for the token interactively (no echo) so it is never recorded in shell history.
#
# Usage:
#   ./scripts/set-dockerhub-token.sh
set -euo pipefail

REPO="cativo23/wizdaa-takehome"
SECRET_NAME="DOCKERHUB_TOKEN"

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: gh CLI not found. Install it from https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Error: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

active_account=$(gh auth status 2>&1 | awk '/Active account: true/{found=1} /Logged in to github.com account/{acct=$NF} END{if(found)print acct}')
echo "Setting ${SECRET_NAME} on ${REPO} (gh account: ${active_account:-unknown})"

read -r -s -p "Paste Docker Hub access token (input hidden): " token
echo
if [ -z "${token}" ]; then
  echo "Error: empty token. Aborting." >&2
  exit 1
fi

printf '%s' "${token}" | gh secret set "${SECRET_NAME}" --repo "${REPO}"
unset token

echo "Secret ${SECRET_NAME} set on ${REPO}."
echo
echo "Verifying..."
gh secret list --repo "${REPO}" | grep -E "^${SECRET_NAME}\b" || {
  echo "Warning: secret not visible in list. Check repo permissions." >&2
  exit 1
}
echo
echo "Done. Next: gh workflow run deploy.yml -R ${REPO}"
