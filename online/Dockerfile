# PhotoPicker 网页版 + 远程相册服务：一个镜像装下网页和服务端。
# 在仓库根目录构建（网页就是 App 本身的前端）：
#   docker build -f online/Dockerfile -t photo-picker-online .
#   docker run -d -p 8080:8080 -v pp-data:/data -e PP_CREATE_PASSWORD=你的密码 photo-picker-online

FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM rust:1-bookworm AS server
WORKDIR /server
COPY online/server/Cargo.toml online/server/Cargo.lock ./
COPY online/server/src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=server /server/target/release/photo-picker-online /app/photo-picker-online
COPY --from=web /web/dist /app/web
ENV PP_ADDR=0.0.0.0:8080 PP_DATA_DIR=/data PP_WEB_DIR=/app/web
VOLUME /data
EXPOSE 8080
CMD ["/app/photo-picker-online"]
