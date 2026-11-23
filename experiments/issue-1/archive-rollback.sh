#!/usr/bin/env bash
# Exercise a reviewed publication and rollback with a local Git remote.
set -euo pipefail

manager=$(command -v "${1:-hive-manager}")
manager=$(realpath "$manager")
[[ $("$manager" --version) == 2.48.0 ]]

umask 077
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_CONFIG_PARAMETERS
export GIT_CONFIG_GLOBAL="$work/gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_COUNT=0 GIT_ALLOW_PROTOCOL=file
git config --global user.name 'Archive fixture'
git config --global user.email 'archive-fixture@example.invalid'
git config --global "url.file://$work/archive.git.insteadOf" 'https://github.com/example/archive.git'
git init --quiet --bare --initial-branch=main archive.git
git -C archive.git config uploadpack.allowFilter true
git clone --quiet "$work/archive.git" seed

legacy=example/project/codex/legacy.meta.json
mkdir -p "seed/${legacy%/*}" bin codex
session_meta='{"type":"session_meta","payload":{"git":{"repository_url":"https://github.com/example/project.git"}}}'
printf '%s\n' "$session_meta" > codex/legacy.jsonl
cp codex/legacy.jsonl "seed/${legacy%.meta.json}.jsonl"
sha=$(sha256sum codex/legacy.jsonl)
sha=${sha%% *}
size=$(wc -c < codex/legacy.jsonl)
printf '{"tool":"codex","kind":"jsonl","repository":"example/project","source":{"sha256":"%s"},"files":[{"path":"%s","bytes":%s,"sha256":"%s"}]}\n' \
  "$sha" "${legacy%.meta.json}.jsonl" "$size" "$sha" > "seed/$legacy"
git -C seed add -- example/project
git -C seed commit --quiet -m 'Seed legacy history'
git -C seed push --quiet origin main
base=$(git -C archive.git rev-parse main)

cat > bin/gh <<'GH'
#!/usr/bin/env bash
set -eu
[[ $1 == api && $2 == --hostname && $3 == github.com ]] || exit 1
case "$4" in
  repos/example/project)
    if [[ $6 == .visibility ]]; then
      printf '%s\n' public
    else
      printf '%s\n' '{"full_name":"example/project","visibility":"public","default_branch":"main"}'
    fi
    ;;
  repos/example/archive)
    printf '%s\n' '{"full_name":"example/archive","visibility":"private","default_branch":"main"}'
    ;;
  *) exit 1 ;;
esac
GH
chmod +x bin/gh
export PATH="$work/bin:$PATH"

printf '%s\n' 'fixture-private-literal[example]' > known-secrets
printf '%s\n' "$session_meta" '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"A synthetic fixture-private-literal[example] entry."}]}}' > codex/session.jsonl
touch -t 202001010000 codex/legacy.jsonl codex/session.jsonl
archive=("$manager" archive-sessions --repo example/project --claude-dir empty --codex-dir codex \
  --known-secrets-file known-secrets --limit 1)
import=("${archive[@]}" --import-legacy example/archive)
"${import[@]}" > import.json
digest=$(node -p 'const plan = require("./import.json"); if (plan.matches.length !== 1 || !plan.matches[0].metadata.endsWith("/legacy.meta.json")) process.exit(1); plan.digest')
"${import[@]}" --apply "$digest"
import_head=$(git -C archive.git rev-parse main)
[[ $(git -C archive.git rev-parse 'main^') == "$base" ]]
[[ $(git -C archive.git diff --name-only "$base" "$import_head") == example/project/.published/* ]]

stage=("${archive[@]}" --published-in example/archive --output)
"${stage[@]}" review
[[ $(node -p 'require("./review/manifest.json").sessions.length') == 1 ]]
if grep -qRFf known-secrets review; then exit 1; fi
publish=("$manager" archive-publish review --destination example/archive --private --known-secrets-file known-secrets)
"${publish[@]}" > plan.json
digest=$(node -p 'const plan = require("./plan.json"); if (plan.visibility !== "private") process.exit(1); plan.digest')
"${publish[@]}" --apply "$digest"
head=$(git -C archive.git rev-parse main)
[[ $(git -C archive.git rev-parse 'main^') == "$import_head" ]]
git -C archive.git diff --name-only "$import_head" "$head" -- example/project/.published > index-changes
[[ -s index-changes ]]
"${stage[@]}" repeated
[[ $(node -p 'require("./repeated/manifest.json").sessions.length') == 0 ]]

git -C seed pull --quiet --ff-only
printf '%s\n' 'Unrelated concurrent addition' > seed/other.txt
git -C seed add other.txt
git -C seed commit --quiet -m 'Keep concurrent change'
git -C seed push --quiet origin main
git clone --quiet "$work/archive.git" rollback
git -C rollback revert --no-edit "$head"
git -C rollback push --quiet origin main

[[ $(git -C archive.git diff --name-only "$import_head" main) == other.txt ]]
git -C archive.git merge-base --is-ancestor "$head" main
"${stage[@]}" reverted
[[ $(node -p 'require("./reverted/manifest.json").sessions.length') == 1 ]]
printf '%s\n' 'Archive import and rollback preserved legacy history, its index and a concurrent change.'
