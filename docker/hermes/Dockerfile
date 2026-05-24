FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    curl git ripgrep gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Clone and install hermes-agent from source
RUN git clone https://github.com/NousResearch/hermes-agent.git /hermes
WORKDIR /hermes
RUN uv pip install --system -e ".[all]"

# Install LiteLLM + RouteLLM for the per-agent model routing sidecar
RUN uv pip install --system litellm routellm

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY knowledge.md /knowledge.md
COPY BOOTSTRAP.md /agenthelm-templates/BOOTSTRAP.md
COPY MEMORY_POLICY.md /agenthelm-templates/MEMORY_POLICY.md
COPY skills/ /agenthelm-skills/
COPY hooks/ /agenthelm-hooks/

EXPOSE 8000
EXPOSE 8787

ENTRYPOINT ["/entrypoint.sh"]
