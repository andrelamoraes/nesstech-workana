#!/usr/bin/env bash
# Instala ou atualiza o painel num Ubuntu (22.04/24.04) como serviço systemd.
# Rode a partir de um checkout do repositório no servidor:
#
#   sudo bash deploy/install.sh
#
# É idempotente: rodar de novo depois de um "git pull" atualiza o código e
# reinicia o serviço, sem tocar em /etc/nesstech-workana nem nos dados.
set -euo pipefail

APP_USER=workana
APP_DIR=/opt/nesstech-workana
STATE_DIR=/var/lib/nesstech-workana
ETC_DIR=/etc/nesstech-workana
SERVICE=nesstech-workana
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Rode como root: sudo bash deploy/install.sh" >&2
  exit 1
fi

echo "==> Pacotes do sistema (Xvfb para o navegador, rsync)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq xvfb xauth rsync ca-certificates curl >/dev/null

echo "==> Node.js (>= 20)"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
fi
if (( NODE_MAJOR < 20 )); then
  echo "    Node ausente ou antigo (major=$NODE_MAJOR) — instalando Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
NPM_BIN="$(command -v npm)"
echo "    usando $NODE_BIN ($(node -v))"

echo "==> Usuário de serviço '$APP_USER'"
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
mkdir -p "$STATE_DIR/data"
chown -R "$APP_USER:$APP_USER" "$STATE_DIR"
chmod 750 "$STATE_DIR"

echo "==> Código em $APP_DIR"
mkdir -p "$APP_DIR"
rsync -a --delete \
  --exclude '/.git' --exclude '/node_modules' --exclude '/data' --exclude '/.claude' --exclude '/.env' \
  "$SRC_DIR/" "$APP_DIR/"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Dependências npm + Chromium do Playwright (como $APP_USER)"
# O Chromium vai para o cache do usuário de serviço ($STATE_DIR/.cache).
runuser -u "$APP_USER" -- env HOME="$STATE_DIR" bash -c "cd '$APP_DIR' && '$NPM_BIN' ci --omit=dev --no-audit --no-fund"
echo "==> Bibliotecas de sistema do Chromium"
(cd "$APP_DIR" && "$NODE_BIN" node_modules/.bin/playwright install-deps chromium >/dev/null)

echo "==> Configuração em $ETC_DIR"
mkdir -p "$ETC_DIR"
if [[ ! -f "$ETC_DIR/env" ]]; then
  cp "$APP_DIR/deploy/env.example" "$ETC_DIR/env"
  echo "    criado $ETC_DIR/env — EDITE (WAHA_API_KEY etc.)"
fi
chown root:root "$ETC_DIR/env"
chmod 600 "$ETC_DIR/env"
if [[ -f "$ETC_DIR/master-password" ]]; then
  chown "root:$APP_USER" "$ETC_DIR/master-password"
  chmod 640 "$ETC_DIR/master-password"
fi

echo "==> Serviço systemd"
sed "s#__NODE_BIN__#$NODE_BIN#" "$APP_DIR/deploy/$SERVICE.service" > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

sleep 2
systemctl --no-pager --lines=15 status "$SERVICE" || true

cat <<EOF

Pronto. Próximos passos:
  1. Edite $ETC_DIR/env (WAHA_URL / WAHA_API_KEY / WAHA_SESSION) e rode:
       sudo systemctl restart $SERVICE
  2. Do seu computador, abra um túnel e acesse o painel:
       ssh -L 4173:127.0.0.1:4173 <usuario>@<servidor>
       http://127.0.0.1:4173
  3. (Opcional) desbloqueio automático após reinícios:
       sudo install -m 640 -o root -g $APP_USER /dev/stdin $ETC_DIR/master-password <<< 'SUA_SENHA_MESTRA'
       sudo systemctl restart $SERVICE
  Logs: journalctl -u $SERVICE -f
EOF
