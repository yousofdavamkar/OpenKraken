# Keep the native terminal module compatible with the Debian 13 acceptance image,
# even when the developer's host links newly versioned glibc symbols.
FROM docker.io/library/debian@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4

RUN rm -f /etc/apt/apt.conf.d/docker-clean \
    && printf 'Acquire::Retries "0";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' > /etc/apt/apt.conf.d/80-build-network \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 nodejs libnode-dev \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 CXXFLAGS=-DNAPI_VERSION=8
