# Postgres 17 + pgvector + pg_textsearch (BM25 lexical ranking).
#
# The base tag pins pgvector 0.8.2 on PostgreSQL 17 so the image matches an
# existing pgvector/pgvector:pg17 deployment exactly; only pg_textsearch is
# added. The source tarball is pinned by SHA-256, so a re-published release
# asset fails the build instead of changing what gets compiled.

ARG BASE_IMAGE=pgvector/pgvector:0.8.2-pg17

FROM ${BASE_IMAGE} AS build
ARG PG_TEXTSEARCH_VERSION=1.4.0
ARG PG_TEXTSEARCH_SHA256=313c231136f19ded24a7d6f4de3ca96f3840b10c55adbfc839cd0068042e2e40
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential postgresql-server-dev-17 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSL -o pg_textsearch.tar.gz \
      "https://github.com/timescale/pg_textsearch/releases/download/v${PG_TEXTSEARCH_VERSION}/pg_textsearch-${PG_TEXTSEARCH_VERSION}.tar.gz" \
 && echo "${PG_TEXTSEARCH_SHA256}  pg_textsearch.tar.gz" | sha256sum -c - \
 && mkdir pg_textsearch \
 && tar -xzf pg_textsearch.tar.gz -C pg_textsearch --strip-components=1 \
 && make -C pg_textsearch \
 && make -C pg_textsearch install DESTDIR=/staging

FROM ${BASE_IMAGE}
COPY --from=build /staging/ /
# The library must be loaded at server start; CREATE EXTENSION fails otherwise.
CMD ["postgres", "-c", "shared_preload_libraries=pg_textsearch"]
