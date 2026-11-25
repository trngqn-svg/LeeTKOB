# The sandbox image (task Q6): g++ and a non-root user, nothing else of LeeTKOB.
# Build it from this folder alone, so no file of the repository (and never a .env)
# can be inside it:
#   docker build --tag leetkob-sandbox docker/sandbox
# The worker starts every container from it with the flags of src/judge/sandbox.ts:
# no network, a read-only root, a tmpfs at /work, limits, and this user.
FROM debian:bookworm-slim

# g++ for the C++17 the dev set uses (g++ -std=c++17 -O2), and the C library headers.
RUN apt-get update \
 && apt-get install --yes --no-install-recommends g++ libc6-dev \
 && rm -rf /var/lib/apt/lists/*

# The user every submission runs as. It owns no file of the image, has no shell to log
# in with, and its home is the tmpfs that the worker mounts at /work.
RUN useradd --uid 10001 --user-group --no-create-home --home-dir /work \
      --shell /usr/sbin/nologin runner

USER 10001:10001
WORKDIR /work

# PID 1 only waits. The worker compiles in one short container (it overrides this
# command), then starts a second one from this command and runs each test in it with
# docker exec.
CMD ["sleep", "infinity"]
