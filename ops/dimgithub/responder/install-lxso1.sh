#!/usr/bin/env bash
# Install or update the dimgithub outage monitor + responder on lxso1 (systemd user service, linger on).
# Run from anywhere on the Mac:  ops/dimgithub/responder/install-lxso1.sh [--issue N] [--host lxso1]
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HOST=lxso1
ISSUE=""
while (($#)); do
  case "$1" in
    --issue) ISSUE=$2; shift 2 ;;
    --host) HOST=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

echo "== unit tests (local)"
python3 -m unittest discover -s "$HERE/tests" -t "$HERE/tests" >/dev/null 2>&1 \
  || { python3 -m unittest discover -s "$HERE/tests" -t "$HERE/tests"; exit 1; }

echo "== stage to $HOST:~/.local/lib/dimgithub-responder.new"
ssh -n "$HOST" 'mkdir -p ~/.local/lib/dimgithub-responder.new ~/.local/state/dimgithub-responder ~/.config/dimgithub-responder ~/.config/systemd/user ~/.local/bin && chmod 700 ~/.local/state/dimgithub-responder'
rsync -a --delete --exclude '__pycache__' --exclude 'evidence/' --exclude 'wrangler.jsonc' \
  "$HERE/" "$HOST:.local/lib/dimgithub-responder.new/"
rsync -a "$HERE/../wrangler.jsonc" "$HOST:.local/lib/dimgithub-responder.new/wrangler.jsonc"

echo "== unit tests on the staged copy ($HOST)"
ssh -n "$HOST" 'cd ~/.local/lib/dimgithub-responder.new && python3 -m unittest discover -s tests -t tests > /tmp/dimgithub-responder-tests.log 2>&1; rc=$?; tail -n 3 /tmp/dimgithub-responder-tests.log; exit $rc' \
  || { echo "remote tests failed; live installation left unchanged" >&2; exit 1; }

echo "== activate"
ssh -n "$HOST" 'rsync -a --delete ~/.local/lib/dimgithub-responder.new/ ~/.local/lib/dimgithub-responder/'

if [[ -n "$ISSUE" ]]; then
  echo "== config: incident log issue #$ISSUE"
  ssh "$HOST" "python3 - $ISSUE" <<'PY'
import json, pathlib, sys
path = pathlib.Path.home() / ".config/dimgithub-responder/config.json"
cfg = json.loads(path.read_text()) if path.exists() else {}
cfg.setdefault("notify", {})["github_issue"] = int(sys.argv[1])
path.write_text(json.dumps(cfg, indent=1) + "\n")
print(path.read_text())
PY
fi

echo "== unit + wrapper"
ssh -n "$HOST" 'install -m 0644 ~/.local/lib/dimgithub-responder/systemd/dimgithub-monitor.service ~/.config/systemd/user/dimgithub-monitor.service
cat > ~/.local/bin/dimgithub-responder <<EOF
#!/bin/sh
# status | pause --minutes N | resume | ack --incident ID | tick   (see ~/.local/lib/dimgithub-responder/README.md)
exec /usr/bin/python3 \$HOME/.local/lib/dimgithub-responder/monitor.py "\$@"
EOF
chmod 0755 ~/.local/bin/dimgithub-responder
systemctl --user daemon-reload
systemctl --user enable dimgithub-monitor.service >/dev/null
systemctl --user restart dimgithub-monitor.service'

echo "== status"
sleep 5
ssh -n "$HOST" 'systemctl --user --no-pager status dimgithub-monitor.service | head -n 6; ~/.local/bin/dimgithub-responder status | head -n 20'
