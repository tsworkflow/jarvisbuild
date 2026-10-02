# D-253: voice-gateway sin EGEN image, atskilt fra api.Dockerfile sitt delte
# image (api/worker/migrate) - lokal STT/TTS (whisper.cpp/piper) trenger en
# C/C++-toolchain OG (for piper sin offisielle forhåndsbygde binær) et
# glibc-baseimage, som ville blåst opp de tre andre, rent Node-baserte
# tjenestene helt unødvendig. `node:XX-alpine` (musl libc) er BEVISST byttet
# ut med `node:XX-bookworm(-slim)` (Debian, glibc) her - KUN her - fordi
# Piper sin offisielle Linux-binær er glibc-lenket (onnxruntime-avhengighet)
# og ikke kjører på musl uten en kompatibilitetslag.
#
# whisper.cpp bygges derimot alltid fra kildekode (ingen offisiell Linux
# x86_64-forhåndsbygd binær finnes - kun kildekode-bygg er dokumentert,
# verifisert mot github.com/ggml-org/whisper.cpp, ikke gjettet) - portabelt
# på tvers av libc uansett, men bygges her i samme steg for én konsistent
# byggeprosess.
#
# Modell-/stemmevalg (BEGGE verifisert mot offisiell dokumentasjon, ALDRI
# gjettet - se D-253 i DECISIONS_AND_ASSUMPTIONS.md for kildene):
#   - whisper: `ggml-small.bin` (flerspråklig, ~466MB). D-272 (2026-09-26,
#     live NAS-funn): `ggml-base.bin` (den opprinnelige D-253-verdien, ~142MB)
#     produserte KONSEKVENT `text_length: 0` for korte norske ytringer -
#     kildekode-lest (D-41-disiplin) helt inn i whisper.cpp sin EGEN
#     `whisper_full()`-avkodingssløyfe (src/whisper.cpp) og bekreftet at
#     verken no-speech-/entropi-/logprob-tersklene (alle strukturelt
#     deaktivert/urørt av vår kode) eller output-rørledningen (D-270/D-271,
#     `stdout_raw_length: 0` bevist selv MED ekte, ikke-null dekodingstid)
#     var årsaken - modellens EGEN avkoding produserte rett og slett ingen
#     ordinære vokabular-token for disse ytringene, kun tidsstempel-/EOT-
#     token. `ggml-small.bin` er SAMME modell Tobias allerede bekreftet
#     fungerende norsk tale-gjenkjenning med på sin egen Windows-maskin
#     (D-223, 2026-09-22) - NAS-imaget sin D-253-nedgradering til `base`
#     (kun begrunnet i CPU-hastighet, aldri faktisk talegjenkjenning-testet
#     med `base` FØR nå) er dermed korrigert til å matche den allerede
#     bevist-fungerende modellstørrelsen. `ggml-medium.bin` (~1,5GB, enda
#     bedre norsk-nøyaktighet) forblir et fremtidig alternativ på bekostning
#     av latens/RAM - se models/README.md i whisper.cpp for alle navn,
#     samme nedlastings-URL-mønster.
#   - piper: `no_NO-talesyntese-medium` - eneste norske stemme i det
#     offisielle piper-voices-registeret (rhasspy/piper VOICES.md).

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS whisper-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --branch v1.9.4 --depth 1 https://github.com/ggml-org/whisper.cpp.git /build/whisper.cpp
WORKDIR /build/whisper.cpp
# D-255: build ONLY the `whisper-cli` target (examples/cli/CMakeLists.txt),
# NOT a full `cmake --build build` - the latter also builds
# examples/deprecation-warning/CMakeLists.txt, which compiles ITS OWN stub
# (always `fprintf`s a deprecation notice and `return EXIT_FAILURE`) to a
# binary literally named `main`. A prior version of this Dockerfile built
# everything and then did `find build -type f \( -name "whisper-cli" -o
# -name "main" \)`, which matched BOTH the real CLI and this always-failing
# stub and copied whichever `find` visited last - on the actual NAS build,
# the stub won, so voice-gateway silently ran a binary that unconditionally
# exits 1 for every request (`local_whisper_process_failed:1:`, no stderr -
# found live via D-254's new error logging, root-caused by building this
# exact pinned tag locally and reading examples/cli/CMakeLists.txt +
# examples/deprecation-warning/CMakeLists.txt directly, not guessed).
# Building only the named target makes the ambiguity structurally
# impossible - no `main`/`bench`/`stream`/`command` deprecation stubs are
# ever built in the first place. `test -x` below turns any FUTURE rename of
# this target (a version bump) into a loud build failure instead of another
# silent wrong-binary regression.
#
# D-257: `-DBUILD_SHARED_LIBS=OFF` is REQUIRED, not an optimization. By
# default this CMake project builds whisper-cli DYNAMICALLY linked against
# libwhisper.so.1/libggml*.so.0, with an ABSOLUTE RUNPATH baked in at link
# time pointing at THIS builder stage's own build directory
# (verified locally: `readelf -d` on a default build shows
# `RUNPATH: [/…/build/bin:]`, an absolute path, never `$ORIGIN`-relative).
# The runtime stage below copies ONLY the executable
# (`COPY --from=whisper-builder /build/whisper-bin ...`), never that
# directory - the runpath therefore points at a path that structurally
# cannot exist in the runtime image. Live symptom on the NAS after D-256
# (which for the first time actually surfaced the real STT error instead
# of crashing the process): `local_whisper_process_failed:127:
# /opt/whisper/whisper-cli: error while loading shared libraries:
# libwhisper.so.1: cannot open shared object file`. Root-caused by
# re-cloning this EXACT pinned tag locally, running `ldd`/`readelf -d` on
# the default dynamic build, then verifying a STATIC build's `ldd` output
# only lists ordinary system libraries (libgomp/libstdc++/libgcc_s/libm/
# libc) - confirmed by copying JUST the static binary to an empty
# directory, deleting the entire source/build tree, and re-running it
# successfully from that isolated copy (exit 0, real usage output).
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    && cmake --build build --config Release -j"$(nproc)" --target whisper-cli
RUN find build -type f -name "whisper-cli" -exec cp {} /build/whisper-bin \; && test -x /build/whisper-bin

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS runtime
# wget: docker-compose.yml sin healthcheck for denne tjenesten bruker wget -
# til stede by default på Alpine (busybox) men IKKE på Debian slim, uendret
# fra api.Dockerfile-æraen for minst mulig diff der.
# libgomp1 (D-257): den statisk-lenkede whisper-cli (se whisper-builder sin
# egen kommentar) bruker fortsatt OpenMP for tråding - `libgomp.so.1` er en
# ORDINÆR systembibliotek-avhengighet (`ldd` bekrefter dette lokalt), IKKE en
# whisper.cpp-spesifikk fil. Eksplisitt installert her i stedet for antatt
# til stede i base-imaget - denne sandboxen har ingen kjørende
# Docker-daemon å faktisk verifisere `node:22-bookworm-slim` sitt innhold
# mot, så D-41-disiplinen her er "gjør avhengigheten eksplisitt" fremfor "gjett
# at den allerede er der".
RUN apt-get update && apt-get install -y --no-install-recommends curl wget ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# D-275 (build-effektivitet, funnet mens D-275 sin VAD-fiks ble forberedt):
# whisper.cpp-binæren/modellen og Piper sin binær/stemme hentes nå FØR
# `COPY apps ./apps`/`pnpm install` under, IKKE etter (som tidligere) - disse
# nedlastingene (~466MB modell + Piper-binær/stemme) avhenger IKKE av
# appens kildekode i det hele tatt. Med den GAMLE rekkefølgen invaliderte
# ENHVER kildekodeendring i `apps/voice-gateway/src/*.ts` (f.eks. D-275 sin
# `vad.ts`-fiks) Docker-lagcachen fra `COPY apps ./apps` OG NEDOVER -
# inkludert modell-/stemme-nedlastingen, som dermed måtte lastes ned PÅ NYTT
# ved HVER eneste kodeendring, selv om selve modellen/stemmen er UENDRET.
# Nå invaliderer en kildekodeendring KUN de raske `COPY`/`pnpm install`-
# lagene lenger ned - modell-/binær-lagene forblir cachet på tvers av
# kode-iterasjoner.
# --- whisper.cpp: binær fra byggesteget + flerspråklig base-modell ---
COPY --from=whisper-builder /build/whisper-bin /opt/whisper/whisper-cli
RUN curl -fL --retry 3 -o /opt/whisper/ggml-small.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin

# --- piper: offisiell forhåndsbygd Linux x86_64-binær + norsk stemme ---
RUN curl -fL --retry 3 -o /tmp/piper.tar.gz \
      https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
    && mkdir -p /opt/piper && tar -xzf /tmp/piper.tar.gz -C /opt/piper --strip-components=1 \
    && rm /tmp/piper.tar.gz
RUN mkdir -p /opt/piper/voices \
    && curl -fL --retry 3 -o /opt/piper/voices/no_NO-talesyntese-medium.onnx \
      https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/no/no_NO/talesyntese/medium/no_NO-talesyntese-medium.onnx \
    && curl -fL --retry 3 -o /opt/piper/voices/no_NO-talesyntese-medium.onnx.json \
      https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/no/no_NO/talesyntese/medium/no_NO-talesyntese-medium.onnx.json

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY modules ./modules
RUN pnpm install --frozen-lockfile --prod

ENV JARVIS_WHISPER_BIN=/opt/whisper/whisper-cli
ENV JARVIS_WHISPER_MODEL=/opt/whisper/ggml-small.bin
ENV JARVIS_PIPER_BIN=/opt/piper/piper
ENV JARVIS_PIPER_MODEL=/opt/piper/voices/no_NO-talesyntese-medium.onnx

# REMEDIERING DEL 2 (JARVIS-010): IKKE-ROOT (`node`, uid 1000 i node-imaget). Modeller/binærer under /opt er
# lesbare/kjørbare for alle (lastet ned som root); whisper skriver kun midlertidige filer til tmpfs (/tmp).
USER node

EXPOSE 3020
CMD ["node", "--experimental-transform-types", "apps/voice-gateway/src/main.ts"]
