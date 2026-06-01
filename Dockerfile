FROM node:22-slim

WORKDIR /app

# canvas (Cairo/Pango) 需要的 runtime 與字型設定檔，
# 缺 fontconfig 會在繪字時噴 "Fontconfig error: Cannot load default config file"
RUN apt-get update && apt-get install -y --no-install-recommends \
      fontconfig \
      fonts-noto-cjk \
      libcairo2 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 \
      libjpeg62-turbo \
      libgif7 \
      librsvg2-2 \
    && rm -rf /var/lib/apt/lists/*

# 先複製 package.json 以利 docker layer cache
COPY package.json ./

RUN npm install --omit=dev

COPY . .

CMD ["node", "src/index.js"]
