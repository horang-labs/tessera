FROM archlinux:latest AS runtime-base

RUN pacman -Syu --noconfirm \
  ca-certificates \
  github-cli \
  git \
  openssh \
  python \
  nodejs \
  npm  \
  base-devel && \
  pacman -Scc --noconfirm

FROM runtime-base AS build-deps

WORKDIR /build

COPY package.json package-lock.json ./

RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install

FROM build-deps AS tessera-build

COPY . .

RUN npm run npm:prepack

FROM runtime-base AS production-deps

WORKDIR /build

COPY package.json package-lock.json ./

# Only this production dependency tree is copied into the final image.
RUN npm install --omit=dev

FROM runtime-base AS runtime

RUN useradd -m -s /bin/bash tessera && \
  mkdir -p /opt/tessera /home/tessera/.npm-global /home/tessera/.local /home/tessera/.config /home/tessera/.ssh /home/tessera/go && \
  chown -R tessera:tessera /home/tessera

WORKDIR /opt/tessera

COPY --from=production-deps /build/node_modules ./node_modules
COPY --from=tessera-build /build/package.json ./package.json
COPY --from=tessera-build /build/next.config.mjs ./next.config.mjs
COPY --from=tessera-build /build/bin ./bin
COPY --from=tessera-build /build/dist-server ./dist-server
COPY --from=tessera-build /build/.next ./.next
COPY --from=tessera-build /build/public ./public
COPY --from=tessera-build /build/assets ./assets

RUN chmod +x /opt/tessera/bin/tessera.mjs && \
  chown -R root:root /opt/tessera

ENV NPM_CONFIG_PREFIX=/home/tessera/.npm-global
ENV PATH=/home/tessera/.bun/bin:/home/tessera/go/bin:${NPM_CONFIG_PREFIX}/bin:${PATH}

USER tessera

RUN npm config set prefix /home/tessera/.npm-global && \
  npm i -g \
  @openai/codex@latest \
  opencode-ai@latest

WORKDIR /home/tessera/workspaces

EXPOSE 32123

ENTRYPOINT ["node", "/opt/tessera/bin/tessera.mjs"]
