# A container with `claude` installed, for proving HIVE-133 against a real one.
#
# This is the image `tests/live/container-conformance.test.ts` asks for by name
# in `HIVE_LIVE_CONTAINER_IMAGE`. The app never builds or names it — a container
# is the user's to bring — so it lives with the tests, not with the app.
#
# No credential is baked in. Authentication is supplied at `docker run` time
# through the same variable `claude` itself honours (`CLAUDE_CODE_OAUTH_TOKEN`
# or `ANTHROPIC_API_KEY`), so the image can be shared and the layer cache holds
# nothing secret.
#
#   docker build -t hive-claude:2.1.263 --build-arg CLAUDE_CODE_VERSION=2.1.263 .
#
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.263

# `curl` because the container-flavoured hook set's command hooks (`/done`) are
# `sh` strings that call it; `git` because `claude` reads the repo it is started
# in; `procps` for `ps`, which `claude` uses to find its own parent.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git bash procps \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# A headless, unattended `claude`: no auto-update racing a test, and the
# onboarding state pre-answered so `-p` never waits on a first-run prompt.
ENV DISABLE_AUTOUPDATER=1 \
    HOME=/root
RUN mkdir -p /root/.claude \
  && printf '{"hasCompletedOnboarding":true}\n' > /root/.claude.json

WORKDIR /workspace

CMD ["sleep", "infinity"]
