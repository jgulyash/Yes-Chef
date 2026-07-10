# Cross-builds a linux/amd64 whisper-cli for a consumer x86-64 NAS (AVX2).
# Built FROM debian:bookworm so the binary links the same glibc as the app's
# node:22-slim runtime image. Build:
#   docker buildx build --platform linux/amd64 --target artifact --output type=local,dest=./out .
FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git ca-certificates && rm -rf /var/lib/apt/lists/*
# Pin the release tag so the CLI interface and JSON output are deterministic.
RUN git clone --depth 1 --branch v1.9.1 https://github.com/ggml-org/whisper.cpp /w
WORKDIR /w
# GGML_NATIVE=OFF: never bake in the (emulated) build machine's CPU flags — the
# target is the NAS. Static ggml/whisper libs so the binary ships alone.
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
      -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
    && cmake --build build -j --target whisper-cli

FROM scratch AS artifact
COPY --from=build /w/build/bin/whisper-cli /whisper-cli
