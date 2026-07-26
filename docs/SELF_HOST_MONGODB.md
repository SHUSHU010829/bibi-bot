# 在 Vultr 自架 MongoDB + 從 Atlas 搬遷資料

把資料庫從 MongoDB Atlas 改成「跟 bot 跑在同一台 Vultr 的 docker-compose 自架 mongo」。
DB 名稱在程式內固定為 `MorningBot`（見 `src/events/ready/connectDb.js`），搬遷時保持不變即可。

---

## 架構

`docker-compose.yml` 現在有兩個 service：

- **mongo**：`mongo:7`，資料存在 named volume `mongo-data`，**不對公網開 port**（只用 `expose`，同一 docker network 的 bot 才連得到）。限制 WiredTiger cache 0.75GB + 容器記憶體 1200M，適合小記憶體機器。
- **bot**：`depends_on` mongo 的 healthcheck，等 DB ready 再啟動。

bot 透過 docker 內網主機名 `mongo:27017` 連線，連線字串放在 `.env` 的 `MONGO_URI`。

---

## 一、設定（首次部署）

### 1. 準備 `.env`

參考 `.env.example`，在 `.env` 內設定三個值：

```dotenv
MONGO_ROOT_USER=bibi
MONGO_ROOT_PASSWORD=<openssl rand -base64 24 產生的長密碼>
MONGO_URI=mongodb://bibi:<同上密碼>@mongo:27017/MorningBot?authSource=admin
```

- 密碼建議 `openssl rand -base64 24`，但**避免 `@ : / ?` 這類字元**（會破壞 URI）；若真的出現，需在 URI 內做 percent-encoding。
- `authSource=admin` 不可省略——root 帳號建在 admin 庫。
- `MONGO_ROOT_USER/PASSWORD` 只在 mongo **volume 第一次初始化**時生效；之後改密碼要進 mongo 內用 `db.changeUserPassword` 改，或砍掉 volume 重來。

### 2. 啟動

```bash
docker compose up -d mongo    # 先起 DB，等它 healthy
docker compose up -d --build  # 再起 bot
docker compose ps             # mongo 應為 healthy
docker compose logs -f bot    # 應看到 [DATA] Successfully connected to MongoDB!
```

### 3. 防火牆（重要）

compose 沒有 publish 27017，DB 只在 docker 內網，不會暴露到公網。仍建議在 Vultr 主控台 / `ufw` 只開放你要的 port（例：22、bot 對外服務），**不要開 27017**。

---

## 二、從 Atlas 搬資料

用 `mongo:7` 容器內建的 `mongodump` / `mongorestore`，宿主機不用另外裝工具。

### 方式 A：一鍵腳本（建議）

先確定 mongo 已 `up`，然後在專案根目錄：

```bash
ATLAS_URI='mongodb+srv://USER:PASS@host/MorningBot?retryWrites=true&w=majority' \
MONGO_ROOT_USER=bibi \
MONGO_ROOT_PASSWORD='你的本機root密碼' \
./scripts/migrateAtlasToLocal.sh
```

腳本會：Atlas `mongodump` → 接上 compose network → `mongorestore --drop` 進本機 mongo。
> 若專案資料夾不是 `bibi-bot`，compose network 名稱會不同，用 `docker network ls` 查到後加 `COMPOSE_NETWORK=<名稱>` 覆寫。

### 方式 B：手動兩步

```bash
# 1) 從 Atlas dump（會產生 ./atlas-dump/MorningBot/）
docker run --rm -v "$(pwd)/atlas-dump:/dump" mongo:7 \
  mongodump --uri="mongodb+srv://USER:PASS@host/MorningBot?retryWrites=true&w=majority" --out=/dump

# 2) restore 進本機 mongo（--network 用 docker network ls 查到的 compose 網路）
docker run --rm --network bibi-bot_default -v "$(pwd)/atlas-dump:/dump" mongo:7 \
  mongorestore --uri="mongodb://bibi:密碼@mongo:27017/?authSource=admin" --drop /dump
```

`mongorestore` 會連索引一起還原；`connectDb.js` 啟動時也會 idempotent 地補建索引，兩邊不衝突。

### 驗證

```bash
docker compose exec mongo mongosh -u bibi -p '密碼' --authenticationDatabase admin \
  --quiet --eval 'db.getSiblingDB("MorningBot").getCollectionNames().length'
```

跟 Atlas 上的 collection 數量對得起來即可。也可抽查幾個關鍵 collection 的 `countDocuments()`。

---

## 三、切換與收尾

1. 資料驗證無誤後，確定 `.env` 的 `MONGO_URI` 已指向 `mongo:27017`。
2. `docker compose up -d --build bot` 重啟 bot，確認日誌連上本機 mongo、指令正常。
3. 觀察 1～2 天無誤後，再停用 / 降級 Atlas cluster。
4. 刪掉本機 dump：`rm -rf ./atlas-dump`（內含帳密可還原的資料，別留著）。

## 備份（自架後很重要）

Atlas 有自動備份，自架要自己來。最簡單：cron 定期 `mongodump` 到另一顆 volume / 物件儲存。

```bash
docker compose exec -T mongo mongodump \
  --uri="mongodb://bibi:密碼@localhost:27017/MorningBot?authSource=admin" \
  --archive --gzip > "backup-$(date +%F).archive.gz"
```

還原：`... mongorestore --archive --gzip --drop < backup-YYYY-MM-DD.archive.gz`。
