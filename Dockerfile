FROM daytonaio/sandbox:0.6.0

# Base image includes: Chromium, Xvfb, xfce4, Node.js, Claude Code, Python, git, curl
# Build remotely: daytona snapshot create openthrottle --dockerfile ./Dockerfile --context .

ARG AGENT=claude

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
      gh jq gosu \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm agent-browser \
    && if [ "$AGENT" = "codex" ]; then npm install -g @openai/codex; fi \
    && if [ "$AGENT" = "aider" ]; then pip install --no-cache-dir aider-chat; fi \
    && curl -sL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64" \
       -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq

# Download Claude Code plugins at build time (pinned to current version)
# Rebuild the image to pick up updates.
RUN git clone --depth 1 https://github.com/EveryInc/compound-engineering-plugin.git \
      /opt/openthrottle/plugins/compound-engineering \
    && rm -rf /opt/openthrottle/plugins/compound-engineering/.git \
    && git clone --depth 1 --sparse https://github.com/anthropics/claude-code.git /tmp/claude-code \
    && cd /tmp/claude-code && git sparse-checkout set plugins/pr-review-toolkit \
    && cp -r /tmp/claude-code/plugins/pr-review-toolkit /opt/openthrottle/plugins/pr-review-toolkit \
    && rm -rf /tmp/claude-code

COPY entrypoint.sh run-builder.sh run-reviewer.sh task-adapter.sh agent-lib.sh /opt/openthrottle/
COPY hooks/ /opt/openthrottle/hooks/
COPY git-hooks/ /opt/openthrottle/git-hooks/
COPY skills/ /opt/openthrottle/skills/
COPY prompts/ /opt/openthrottle/prompts/

# Agent SDK orchestrator (TypeScript) — replaces claude -p for claude runtime
COPY orchestrator/ /opt/openthrottle/orchestrator/
RUN cd /opt/openthrottle/orchestrator && npm install --production && npm run build

RUN chmod +x /opt/openthrottle/*.sh /opt/openthrottle/hooks/*.sh /opt/openthrottle/git-hooks/*

ENTRYPOINT ["/opt/openthrottle/entrypoint.sh"]
