# PhotoPicker 在线选片：一个镜像装下网页和服务端。
#   docker build -t photo-picker-online online/
#   docker run -d -p 8080:8080 -v pp-data:/data -e PP_CREATE_PASSWORD=你的密码 photo-picker-online

FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

FROM rust:1-bookworm AS server
WORKDIR /server
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
RUN cargo build --release --locked

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=server /server/target/release/photo-picker-online /app/photo-picker-online
COPY --from=web /web/dist /app/web
ENV PP_ADDR=0.0.0.0:8080 PP_DATA_DIR=/data PP_WEB_DIR=/app/web
VOLUME /data
EXPOSE 8080
CMD ["/app/photo-picker-online"]
