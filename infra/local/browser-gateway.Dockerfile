# D-339: browser-gateway sin EGEN image, atskilt fra api.Dockerfile sitt
# delte image (api/worker/migrate) og fra voice-gateway.Dockerfile - Playwright
# krever en Chromium-binær PLUSS et helt sett systemavhengigheter (fonter,
# codec-biblioteker osv.) som IKKE er trivielt å installere manuelt.
#
# Microsoft sitt eget, offisielle Playwright-image
# (`mcr.microsoft.com/playwright`) bygger nøyaktig dette FERDIG - Chromium +
# alle systemavhengigheter forhåndsinstallert for en gitt Playwright-versjon.
# Tag-en `v1.63.0-noble` er VERIFISERT å faktisk eksistere denne økten
# (`curl https://mcr.microsoft.com/v2/playwright/tags/list`, IKKE gjettet) -
# versjonen MÅ matche `apps/browser-gateway/package.json` sin
# `playwright`-avhengighet (`^1.63.0`) nøyaktig, ellers mismatcher den
# installerte npm-pakken sin forventede browser-binær-versjon mot den som
# faktisk ligger i imaget. `-noble` (Ubuntu 24.04) matcher CI sin
# `ubuntu-24.04`-runner - ingen grunn til en annen Ubuntu-linje her.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 AS runtime

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY modules ./modules
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: imaget har ALLEREDE riktig Chromium-
# versjon forhåndsinstallert (se filhodet over) - en ny nedlasting under
# `pnpm install` ville vært både unødvendig og ville sløst byggetid/-lag.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --prod

# REMEDIERING DEL 2 (JARVIS-008/010): IKKE-ROOT og AKTIV Chromium-sandbox. `pwuser` (uid 1000) er brukeren
# Microsofts Playwright-image allerede har for dette. Motoren starter Chromium med `chromiumSandbox: true`
# (ingen `--no-sandbox`); sandboxen krever user namespaces, som Docker sin standard seccomp-profil blokkerer -
# compose bruker derfor Microsofts offisielle seccomp-profil (`browser-gateway.seccomp.json`, se compose-kommentaren)
# i stedet for `SYS_ADMIN`/`privileged`. Starter ikke Chromium, feiler `/health` (503) - aldri en stille fallback.
USER pwuser
ENV HOME=/home/pwuser

EXPOSE 3030
CMD ["node", "--experimental-transform-types", "apps/browser-gateway/src/main.ts"]
