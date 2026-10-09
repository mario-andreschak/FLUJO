# Optional review engine, separate from the application/runtime Python.
# The vendor dependency graph is frozen; source distributions/build hooks are refused.
FROM ghcr.io/astral-sh/uv:0.12.24@sha256:3af4716e991d6956a41e573eab705d0ee08500cd829ed30293eb8472f372c65a AS uv
FROM python:3.12-slim-bookworm@sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b AS builder
COPY --from=uv /uv /usr/local/bin/uv
ADD --checksum=sha256:ea6f4e5d40d9ba0d73a801515772962f1c7cc8ab8932a4de41a573b46411070d https://codeload.github.com/NVIDIA/SkillSpector/tar.gz/c7958a3268d9498644b22edb75d0f051bbc8cbfc /tmp/vendor.tar.gz
ADD --checksum=sha256:62973f6254d30c871480246869f88a01e17dff6f12e9d43010962eb0d7e305f4 https://github.com/NVIDIA/SkillSpector/releases/download/v2.12.0/skillspector-2.12.0-py3-none-any.whl /tmp/skillspector-2.12.0-py3-none-any.whl
WORKDIR /opt/scanner
RUN tar -xzf /tmp/vendor.tar.gz --strip-components=1 \
    && uv sync --frozen --no-dev --no-install-project --no-build --no-cache \
    && uv pip install --python .venv/bin/python --no-deps /tmp/skillspector-2.12.0-py3-none-any.whl \
    && .venv/bin/python -c 'import skillspector; assert skillspector.__version__ == "2.12.0"'

FROM python:3.12-slim-bookworm@sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b
LABEL org.flujo.skillspector.version="2.12.0" \
      org.flujo.skillspector.revision="c7958a3268d9498644b22edb75d0f051bbc8cbfc" \
      org.flujo.skillspector.wheel-sha256="62973f6254d30c871480246869f88a01e17dff6f12e9d43010962eb0d7e305f4"
COPY --from=builder /opt/scanner/.venv /opt/scanner/.venv
RUN mkdir /input && chmod 0555 /input
ENV PATH="/opt/scanner/.venv/bin:/usr/local/bin:/usr/bin:/bin" \
    PYTHONDONTWRITEBYTECODE="1" \
    PYTHONIOENCODING="utf-8" \
    HOME="/tmp" \
    LANGSMITH_TRACING="false"
USER 1000:1000
WORKDIR /input
ENTRYPOINT ["/opt/scanner/.venv/bin/skillspector"]
