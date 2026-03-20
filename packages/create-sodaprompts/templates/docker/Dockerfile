FROM daytonaio/sandbox:0.54.0

# Base image includes: Chromium, Xvfb, xfce4, Node.js, Claude Code, Python, git, curl
# Build with: docker build --build-arg AGENT=claude|codex|aider

ARG AGENT=claude

RUN apt-get update && apt-get install -y --no-install-recommends \
      gh jq gosu \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm agent-browser \
    && if [ "$AGENT" = "codex" ]; then npm install -g @openai/codex; fi \
    && if [ "$AGENT" = "aider" ]; then pip install --no-cache-dir aider-chat; fi \
    && curl -sL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64" \
       -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq

COPY entrypoint.sh run-builder.sh run-reviewer.sh task-adapter.sh agent-lib.sh /opt/sodaprompts/
COPY hooks/ /opt/sodaprompts/hooks/
COPY git-hooks/ /opt/sodaprompts/git-hooks/

RUN chmod +x /opt/sodaprompts/*.sh /opt/sodaprompts/hooks/*.sh /opt/sodaprompts/git-hooks/*

ENTRYPOINT ["/opt/sodaprompts/entrypoint.sh"]
