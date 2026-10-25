FROM node:24.22.1-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    procps \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g ${AGENT_GID} node \
  && usermod -o -u ${AGENT_UID} -g ${AGENT_GID} -d /home/agent -m -l agent node

ARG CLAUDE_CODE_VERSION=2.1.309
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

RUN git config --system safe.directory '*'

USER agent
WORKDIR /home/agent

ARG OPENCODE_VERSION=2.0.16
RUN curl -fsSL https://opencode.ai/v2/install | bash -s -- --version ${OPENCODE_VERSION} \
  && mkdir -p /home/agent/.local/share/opencode
ENV PATH="/home/agent/.opencode/bin:${PATH}"

RUN claude --version && opencode --version

ENTRYPOINT ["sleep", "infinity"]
