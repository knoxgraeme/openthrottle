# OpenThrottle sandbox image.
#
# Build from the REPO ROOT (build context = repo root), not from sandbox/:
#   docker build -f sandbox/Dockerfile -t openthrottle .
#
# This is required because the image also bakes in the platform fence from the
# repository-level `skills/` tree, which lives as a sibling of
# `sandbox/`, not inside it. See sandbox/README.md.

FROM node:22-bookworm@sha256:0557ac14e0d45d02ed563067b82856ca5e7aa3437fa28d98d4350ea9c3d9494a

LABEL org.opencontainers.image.source="https://github.com/knoxgraeme/openthrottle" \
      org.opencontainers.image.licenses="MIT"

# ---------------------------------------------------------------------------
# System packages used by the executor and repository command gates.
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      bats \
      bubblewrap \
      ca-certificates \
      gnupg \
      jq \
      procps \
      ripgrep \
      util-linux \
    && rm -rf /var/lib/apt/lists/*

# gosu — privilege drop from root to the `agent` user (root can't be trusted
# to just `su`; gosu avoids TTY/signal-forwarding issues su/sudo have in
# containers). Binary release, selected by architecture only.
ARG GOSU_VERSION=1.17
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) gosu_sha256="bbc4136d03ab138b1ad66fa4fc051bafc6cc7ffae632b069a53657279a450de3" ;; \
      arm64) gosu_sha256="c3805a85d17f4454c23d7059bcb97e1ec1af272b90126e79ed002342de08389b" ;; \
      *) echo "unsupported gosu architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /usr/local/bin/gosu "https://github.com/tianon/gosu/releases/download/${GOSU_VERSION}/gosu-${arch}"; \
    echo "${gosu_sha256}  /usr/local/bin/gosu" | sha256sum -c -; \
    chmod +x /usr/local/bin/gosu; \
    gosu nobody true

# pnpm + yarn via corepack (bundled with Node 22)
RUN corepack enable

# Coding agent CLIs. Pin the versions whose flags and stage contracts are
# covered by the smoke and runner tests; upgrade deliberately with those tests.
ARG CLAUDE_CODE_VERSION=2.1.201
ARG CODEX_VERSION=0.149.0
ARG OPENCODE_VERSION=1.18.3
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
    && test "$(codex --version)" = "codex-cli ${CODEX_VERSION}" \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Non-root user the agent process runs as. Stays root-owned/root-run up to
# the point entrypoint.sh drops privileges via gosu, so root can seal
# .git/config etc.
# ---------------------------------------------------------------------------
RUN useradd --create-home --home-dir /home/agent --shell /bin/bash --user-group agent \
    && mkdir -p /home/agent/.ot /home/agent/.claude /home/agent/.codex \
    && chown -R agent:agent /home/agent

# ---------------------------------------------------------------------------
# OpenThrottle payload. Build context is the repo root:
#   - entrypoint.sh, runner/, hooks/, and bin/ live under sandbox/
#   - the platform fence lives under skills/ at the repo root
# ---------------------------------------------------------------------------
RUN mkdir -p /opt/openthrottle
COPY sandbox/entrypoint.sh /opt/openthrottle/entrypoint.sh
COPY sandbox/runner /opt/openthrottle/runner
COPY sandbox/hooks /opt/openthrottle/hooks
COPY sandbox/bin/ot-activity.mjs /usr/local/bin/ot-activity
COPY sandbox/bin/ot-result.mjs /opt/openthrottle/bin/ot-result.mjs
COPY skills/codex/AGENTS-fragment.md /opt/openthrottle/skills/codex/AGENTS-fragment.md
COPY contracts/generated/runtime /opt/openthrottle/generated/runtime
COPY contracts/generated/provider-schemas /opt/openthrottle/generated/provider-schemas
COPY contracts/generated/artifact-set.json /opt/openthrottle/generated/artifact-set.json

RUN set -eux; \
    baseline="/opt/openthrottle/action-home-baseline"; \
    install -d -m 0755 "$baseline/claude" "$baseline/codex"; \
    cp /opt/openthrottle/skills/codex/AGENTS-fragment.md "$baseline/codex/AGENTS.md"; \
    chown -R root:root "$baseline"; \
    chmod -R a-w "$baseline"

# Skills are not installed globally for any engine. Each action reconstructs
# only its DefinitionBundle allowlist inside an executor-sealed private
# discovery root. Claude, Codex, and OpenCode therefore see the same catalog,
# and references remain native progressive-disclosure files rather than prompt
# text.
RUN chown -R root:root /opt/openthrottle/generated \
    && chmod -R a-w /opt/openthrottle/generated

RUN chmod 0755 /opt/openthrottle/entrypoint.sh \
    && chmod 0755 /opt/openthrottle/runner/*.mjs \
    && chmod 0755 /usr/local/bin/ot-activity \
    && chmod 0755 /opt/openthrottle/bin/ot-result.mjs \
    && ln -s /opt/openthrottle/bin/ot-result.mjs /usr/local/bin/ot-result \
    && chmod 0755 /opt/openthrottle/hooks/ot-inbox-drain.sh

WORKDIR /home/agent

# Daytona executes the image entrypoint as soon as a sandbox is provisioned.
# Keep that automatic session inert: the Fly supervisor must upload the latest
# Linear context and run credentials before it explicitly starts entrypoint.sh.
ENTRYPOINT ["/bin/true"]
