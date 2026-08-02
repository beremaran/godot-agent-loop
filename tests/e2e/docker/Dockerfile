# E2E test container: Ubuntu with xvfb + Godot 4.7 + Node, mirroring the
# godot-integration.yml provisioning so local E2E runs behave exactly like the
# primary CI job. Run via scripts/run-e2e-docker.sh so headed Godot windows
# never appear on the host. Architecture is detected at build time (x86_64 and
# arm64 hosts are both supported).
FROM ubuntu:24.04

ARG GODOT_VERSION=4.7-stable
ARG NODE_VERSION=22.14.0

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl unzip git xvfb mesa-vulkan-drivers xz-utils \
    libx11-6 libx11-xcb1 libxcursor1 libxinerama1 libxrandr2 libxi6 \
    libasound2t64 libpulse0 libgl1 libegl1 libfontconfig1 fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# Node (the project's engines floor is 22).
RUN ARCH="$(uname -m)" \
  && case "$ARCH" in x86_64) NODE_ARCH=x64 ;; aarch64|arm64) NODE_ARCH=arm64 ;; *) echo "unsupported arch $ARCH" >&2; exit 1 ;; esac \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1 \
  && node --version && npm --version

# Godot stable release, the compatibility floor and primary target.
ENV GODOT_BIN=/usr/local/bin/godot
RUN ARCH="$(uname -m)" \
  && case "$ARCH" in x86_64) GODOT_ARCH=x86_64 ;; aarch64|arm64) GODOT_ARCH=arm64 ;; *) echo "unsupported arch $ARCH" >&2; exit 1 ;; esac \
  && curl -sSL -o /tmp/godot.zip \
    "https://github.com/godotengine/godot-builds/releases/download/${GODOT_VERSION}/Godot_v${GODOT_VERSION}_linux.${GODOT_ARCH}.zip" \
  && unzip -q /tmp/godot.zip -d /tmp/godot-unzip \
  && mv "/tmp/godot-unzip/Godot_v${GODOT_VERSION}_linux.${GODOT_ARCH}" "$GODOT_BIN" \
  && chmod +x "$GODOT_BIN" \
  && rm -rf /tmp/godot.zip /tmp/godot-unzip \
  && "$GODOT_BIN" --version

WORKDIR /work
