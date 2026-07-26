#!/usr/bin/env bash
#
# 把 MongoDB Atlas 的 MorningBot 資料庫搬到自架（docker-compose 的 mongo 服務）。
#
# 用法（在 Vultr 上、專案根目錄執行；此時 compose 的 mongo 已經 up）：
#   ATLAS_URI='mongodb+srv://USER:PASS@host/MorningBot?retryWrites=true&w=majority' \
#   MONGO_ROOT_USER=bibi MONGO_ROOT_PASSWORD='本機root密碼' \
#   ./scripts/migrateAtlasToLocal.sh
#
# 原理：用 mongo:7 容器內建的 mongodump / mongorestore，先 dump 出 Atlas，
# 再接到 compose 的 docker network 把資料灌進本機 mongo。過程完全不需在宿主機裝 mongo tools。
#
set -euo pipefail

: "${ATLAS_URI:?請設定 ATLAS_URI（Atlas 的 mongodb+srv 連線字串）}"
: "${MONGO_ROOT_USER:?請設定 MONGO_ROOT_USER（本機 mongo root 帳號）}"
: "${MONGO_ROOT_PASSWORD:?請設定 MONGO_ROOT_PASSWORD（本機 mongo root 密碼）}"

DB_NAME="${DB_NAME:-MorningBot}"
DUMP_DIR="${DUMP_DIR:-$(pwd)/atlas-dump}"

# compose 預設 network 名稱 = <專案資料夾>_default（全小寫、去掉非法字元）。
# 若你的資料夾不是 bibi-bot，用 `docker network ls` 找出正確名稱後用 COMPOSE_NETWORK 覆寫。
COMPOSE_NETWORK="${COMPOSE_NETWORK:-bibi-bot_default}"

# 用宿主機使用者身分跑容器，否則 mongo image 內的 mongodb(UID 999) 無法寫入
# 由宿主使用者建立的掛載目錄 → mkdir /dump/<db>: permission denied。
DOCKER_USER="$(id -u):$(id -g)"

echo "==> [1/3] 從 Atlas dump 出 ${DB_NAME} 到 ${DUMP_DIR}"
mkdir -p "${DUMP_DIR}"
docker run --rm \
  -u "${DOCKER_USER}" \
  -v "${DUMP_DIR}:/dump" \
  mongo:7 \
  mongodump --uri="${ATLAS_URI}" --out=/dump

echo "==> [2/3] 確認本機 mongo 容器在 network ${COMPOSE_NETWORK}"
docker network inspect "${COMPOSE_NETWORK}" >/dev/null 2>&1 || {
  echo "找不到 network ${COMPOSE_NETWORK}；請先 docker compose up -d mongo，或用 COMPOSE_NETWORK 指定正確名稱（docker network ls 可查）" >&2
  exit 1
}

echo "==> [3/3] restore 進本機 mongo（host=mongo，走 docker 內網）"
docker run --rm \
  -u "${DOCKER_USER}" \
  --network "${COMPOSE_NETWORK}" \
  -v "${DUMP_DIR}:/dump" \
  mongo:7 \
  mongorestore \
    --uri="mongodb://${MONGO_ROOT_USER}:${MONGO_ROOT_PASSWORD}@mongo:27017/?authSource=admin" \
    --drop \
    "/dump"

echo "==> 完成。可用以下指令抽驗筆數："
echo "docker compose exec mongo mongosh -u ${MONGO_ROOT_USER} -p '****' --authenticationDatabase admin \\"
echo "  --quiet --eval 'db.getSiblingDB(\"${DB_NAME}\").getCollectionNames().length'"
