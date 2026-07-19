FROM node:24.4.0-bookworm

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        git \
        python3 \
        python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global --no-audit --no-fund \
        "@github/copilot@1.0.71" \
        "opencode-ai@1.18.3" \
        "@earendil-works/pi-coding-agent@0.80.10" \
    && copilot --version \
    && opencode --version \
    && pi --version

WORKDIR /app

COPY package.json ./package.json
COPY plugins ./plugins
COPY runtime ./runtime
COPY scripts ./scripts
COPY tests ./tests
