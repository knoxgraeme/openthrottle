# OpenThrottle sandbox image.
#
# Build from the REPO ROOT (build context = repo root), not from sandbox/:
#   docker build -f sandbox/Dockerfile -t openthrottle .
#
# This is required because the image also bakes in `skills/` from the repo
# root (the Claude + Codex skill bodies), which lives as a sibling of
# `sandbox/`, not inside it. See sandbox/README.md.

FROM node:22-bookworm

# ---------------------------------------------------------------------------
# System packages: git curl jq ripgrep bats gh yq gosu
# ---------------------------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      curl \
      bats \
      ca-certificates \
      gnupg \
      jq \
      procps \
      ripgrep \
      util-linux \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# gosu — privilege drop from root to the `agent` user (root can't be trusted
# to just `su`; gosu avoids TTY/signal-forwarding issues su/sudo have in
# containers). Binary release, selected by architecture only.
ARG GOSU_VERSION=1.17
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    curl -fsSL -o /usr/local/bin/gosu "https://github.com/tianon/gosu/releases/download/${GOSU_VERSION}/gosu-${arch}"; \
    chmod +x /usr/local/bin/gosu; \
    gosu nobody true

# yq (mikefarah/yq, Go binary — NOT the python-yq apt package, which has a
# different, jq-incompatible CLI). entrypoint.sh relies on the mikefarah
# `-r '.foo // "default"'` jq-style filter syntax.
ARG YQ_VERSION=v4.44.3
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    curl -fsSL -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${arch}"; \
    chmod +x /usr/local/bin/yq; \
    yq --version

# pnpm + yarn via corepack (bundled with Node 22)
RUN corepack enable

# Coding agent CLIs. Pin the versions whose flags and stage contracts are
# covered by the smoke and runner tests; upgrade deliberately with those tests.
ARG CLAUDE_CODE_VERSION=2.1.201
ARG CODEX_VERSION=0.143.0
ARG OPENCODE_VERSION=1.18.3
RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
    && npm cache clean --force

# ---------------------------------------------------------------------------
# Non-root user the agent process runs as. Stays root-owned/root-run up to
# the point entrypoint.sh drops privileges via gosu, so root can seal
# .git/config etc.
# ---------------------------------------------------------------------------
RUN useradd --create-home --home-dir /home/agent --shell /bin/bash --user-group agent \
    && mkdir -p /home/agent/.ot /home/agent/.codex \
    && chown -R agent:agent /home/agent

# Native Compound Engineering plugin installation for both agent CLIs. Keep a
# single, exact marketplace checkout in the image and install it into both of
# the sandbox user's normal agent profiles. Updating CE is therefore one
# deliberate ref/version bump, and every target repository sees the same
# skill set from its first agent invocation.
ARG COMPOUND_ENGINEERING_REF=8163a96e86656a89797869ac61905fe4641f81be
ARG COMPOUND_ENGINEERING_VERSION=3.19.0
RUN set -eux; \
    ce_marketplace="/opt/openthrottle/compound-engineering-marketplace"; \
    install -d -m 0755 "$ce_marketplace"; \
    git -C "$ce_marketplace" init -q; \
    git -C "$ce_marketplace" remote add origin https://github.com/EveryInc/compound-engineering-plugin.git; \
    git -C "$ce_marketplace" fetch -q --depth=1 origin "$COMPOUND_ENGINEERING_REF"; \
    git -C "$ce_marketplace" checkout -q --detach FETCH_HEAD; \
    test "$(git -C "$ce_marketplace" rev-parse HEAD)" = "$COMPOUND_ENGINEERING_REF"; \
    gosu agent env HOME=/home/agent \
      claude plugin marketplace add "$ce_marketplace" --scope user; \
    gosu agent env HOME=/home/agent \
      claude plugin install compound-engineering@compound-engineering-plugin --scope user; \
    test "$(gosu agent env HOME=/home/agent claude plugin list --json \
      | jq -r '.[] | select(.id == "compound-engineering@compound-engineering-plugin" and .enabled == true) | .version')" \
      = "$COMPOUND_ENGINEERING_VERSION"; \
    codex_marketplace="$ce_marketplace/.agents/plugins/marketplace.json"; \
    jq --arg sha "$COMPOUND_ENGINEERING_REF" \
      '(.plugins[] | select(.name == "compound-engineering").source.sha) = $sha' \
      "$codex_marketplace" > "$codex_marketplace.tmp"; \
    mv "$codex_marketplace.tmp" "$codex_marketplace"; \
    test "$(jq -r '.plugins[] | select(.name == "compound-engineering").source.sha' "$codex_marketplace")" \
      = "$COMPOUND_ENGINEERING_REF"; \
    gosu agent env HOME=/home/agent CODEX_HOME=/home/agent/.codex \
      codex plugin marketplace add "$ce_marketplace" --json; \
    gosu agent env HOME=/home/agent CODEX_HOME=/home/agent/.codex \
      codex plugin add compound-engineering@compound-engineering-plugin --json; \
    test "$(gosu agent env HOME=/home/agent CODEX_HOME=/home/agent/.codex \
      codex plugin list --json | jq -r '.installed[] | select(.pluginId == "compound-engineering@compound-engineering-plugin") | .version')" \
      = "$COMPOUND_ENGINEERING_VERSION"

# The Claude CLI's config-corruption recovery can move /home/agent/.claude.json
# into /home/agent/.claude/backups/.claude.json.backup.<ms> WITHOUT recreating
# it during the plugin bake above. A bake that flakes this way ships a snapshot
# where every `claude` launch fails at startup ("Claude configuration file not
# found ... A backup file exists at: ..."), which killed OPE-83 generation 3
# (OPE-87). Heal from the newest backup if the config is missing, then
# hard-assert a parseable config so a broken bake fails this build loudly
# instead of shipping. Finally clear the backup debris: entrypoint.sh removes
# ~/.claude.json at every stage boundary, and the CLI only regenerates a fresh
# config when no backups are present, so a baked-in backup file poisons every
# runtime launch even when the config itself survived the bake.
RUN set -eux; \
    claude_config="/home/agent/.claude.json"; \
    claude_backups="/home/agent/.claude/backups"; \
    if [ ! -f "$claude_config" ]; then \
      newest_backup="$(ls -1 "$claude_backups/.claude.json.backup."* 2>/dev/null | sort | tail -n 1)"; \
      if [ -n "$newest_backup" ]; then \
        cp "$newest_backup" "$claude_config"; \
        chown agent:agent "$claude_config"; \
      fi; \
    fi; \
    test -f "$claude_config"; \
    jq empty "$claude_config"; \
    rm -f "$claude_backups/.claude.json.backup."*

# ---------------------------------------------------------------------------
# OpenThrottle payload. Build context is the repo root:
#   - entrypoint.sh, runner/, safety/ live under sandbox/
#   - skills/ lives at the repo root (shared with the CLI's snapshot builder)
# ---------------------------------------------------------------------------
RUN mkdir -p /opt/openthrottle
COPY sandbox/entrypoint.sh /opt/openthrottle/entrypoint.sh
COPY sandbox/runner /opt/openthrottle/runner
COPY sandbox/lib /opt/openthrottle/lib
COPY sandbox/safety /opt/openthrottle/safety
COPY sandbox/hooks /opt/openthrottle/hooks
COPY sandbox/bin/ot-activity.mjs /usr/local/bin/ot-activity
COPY sandbox/bin/ot-stage-result.mjs /opt/openthrottle/bin/ot-stage-result.mjs
COPY sandbox/bin/ot-subject-post.mjs /opt/openthrottle/bin/ot-subject-post.mjs
COPY supervisor/pipelines/runtime-capabilities-v1.json /opt/openthrottle/runtime-capabilities.json
COPY skills /opt/openthrottle/skills

RUN set -eux; \
    baseline="/opt/openthrottle/action-home-baseline"; \
    install -d -m 0755 "$baseline/claude/skills" "$baseline/codex"; \
    cp -r /opt/openthrottle/compound-engineering-marketplace/skills/. "$baseline/claude/skills/"; \
    cp -r /opt/openthrottle/skills/tasks/. "$baseline/claude/skills/"; \
    for file in config.toml AGENTS.md installation_id models_cache.json; do \
      if [ -f "/home/agent/.codex/$file" ]; then cp "/home/agent/.codex/$file" "$baseline/codex/$file"; fi; \
    done; \
    chown -R root:root "$baseline"; \
    chmod -R a-w "$baseline"

# The canonical task skills (skills/tasks/<name>/SKILL.md, agents/openai.yaml)
# are the single source of truth. Claude loads CE from the root-owned pinned
# marketplace and gets only the OpenThrottle adapters copied into its runtime
# profile. Codex gets both the pinned CE skills and the adapters baked at admin
# scope (/etc/codex/skills), so mutable user plugin state is never executable
# across stage credentials. Each adapter's agents/openai.yaml sets
# policy.allow_implicit_invocation: false so a skill only runs when the
# entrypoint's prompt names it explicitly via `$<skill-name>`.
RUN mkdir -p /etc/codex/skills \
    && cp -r /opt/openthrottle/compound-engineering-marketplace/skills/. /etc/codex/skills/ \
    && cp -r /opt/openthrottle/skills/tasks/. /etc/codex/skills/ \
    && chown -R root:root /etc/codex/skills \
    && chmod -R a-w /etc/codex/skills

RUN chmod 0755 /opt/openthrottle/entrypoint.sh \
    && chmod 0755 /opt/openthrottle/lib/runtime.sh \
    && chmod 0755 /opt/openthrottle/runner/*.mjs \
    && chmod 0755 /usr/local/bin/ot-activity \
    && chmod 0755 /opt/openthrottle/bin/ot-stage-result.mjs \
    && ln -s /opt/openthrottle/bin/ot-stage-result.mjs /usr/local/bin/ot-stage-result \
    && chmod 0755 /opt/openthrottle/bin/ot-subject-post.mjs \
    && ln -s /opt/openthrottle/bin/ot-subject-post.mjs /usr/local/bin/ot-subject-post \
    && chmod 0755 /opt/openthrottle/safety/pre-push \
      /opt/openthrottle/safety/enforce-stage-push-policy \
      /opt/openthrottle/safety/seal.sh \
      /opt/openthrottle/hooks/ot-inbox-drain.sh

# The advertised runtime descriptor is generated independently by the
# supervisor catalog build. Refuse to publish an image whose installed
# executor registry does not match that pinned evidence exactly.
RUN node /opt/openthrottle/runner/capabilities.mjs \
      --verify /opt/openthrottle/runtime-capabilities.json

WORKDIR /home/agent

# Daytona executes the image entrypoint as soon as a sandbox is provisioned.
# Keep that automatic session inert: the Fly supervisor must upload the latest
# Linear context and run credentials before it explicitly starts entrypoint.sh.
ENTRYPOINT ["/bin/true"]
