FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    curl git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Clone and install hermes-agent from source
RUN git clone https://github.com/NousResearch/hermes-agent.git /hermes
WORKDIR /hermes
RUN uv pip install --system -e ".[all]"

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
COPY knowledge.md /knowledge.md

EXPOSE 8000
EXPOSE 8787

ENTRYPOINT ["/entrypoint.sh"]
