#!/usr/bin/env bash
# Publish the committed code to a Hugging Face Docker Space (free hosting).
# Usage: scripts/publish-hf-space.sh <hf-user>/<space-name>     e.g. alirizzv/tripare-ai
# Git asks for your HF username and an HF access token (write) as the password.
set -euo pipefail

SPACE="${1:?usage: scripts/publish-hf-space.sh <hf-user>/<space-name>}"
cd "$(dirname "$0")/.."
[[ -z "$(git status --porcelain)" ]] || { echo "commit your changes first" >&2; exit 1; }
sha="$(git rev-parse --short HEAD)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --depth 1 "https://huggingface.co/spaces/$SPACE" "$work/space"
# Replace the Space contents with exactly what is committed here (no untracked files, no .env).
find "$work/space" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git archive HEAD package.json package-lock.json tsconfig.json tsconfig.build.json src \
  | tar -x -C "$work/space"
cp deploy/huggingface/Dockerfile "$work/space/Dockerfile"
mkdir -p "$work/space/deploy/huggingface" && cp deploy/huggingface/start.sh "$work/space/deploy/huggingface/start.sh"
cp deploy/huggingface/README.md "$work/space/README.md"

cd "$work/space"
git add -A
git -c user.name="$(git -C "$OLDPWD" config user.name)" \
    -c user.email="$(git -C "$OLDPWD" config user.email)" \
    commit -m "deploy $sha from github.com/alirizzzv/Tripare-AI" || echo "nothing changed"
git push origin HEAD:main
echo "Pushed $sha. Build logs: https://huggingface.co/spaces/$SPACE (Logs tab)"
