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

COPY entrypoint.sh run-builder.sh run-reviewer.sh task-adapter.sh agent-lib.sh /opt/openthrottle/
COPY hooks/ /opt/openthrottle/hooks/
COPY git-hooks/ /opt/openthrottle/git-hooks/
COPY skills/ /opt/openthrottle/skills/
COPY prompts/ /opt/openthrottle/prompts/

RUN chmod +x /opt/openthrottle/*.sh /opt/openthrottle/hooks/*.sh /opt/openthrottle/git-hooks/*

ENTRYPOINT ["/opt/openthrottle/entrypoint.sh"]
