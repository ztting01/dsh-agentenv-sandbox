FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends bash build-essential ca-certificates coreutils curl findutils gawk git grep libc-bin openssh-client procps python3 python3-pip ripgrep sed tar util-linux xz-utils && rm -rf /var/lib/apt/lists/*

ENV SHELL=/bin/bash
WORKDIR /workspace
