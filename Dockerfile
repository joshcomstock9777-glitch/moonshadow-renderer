FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json server.mjs ./
RUN mkdir -p /data/out
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.mjs"]
