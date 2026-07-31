FROM ghcr.io/catthehacker/ubuntu:custom-latest

USER root
COPY bin/install-devtools.sh /tmp/install-devtools.sh
RUN sh /tmp/install-devtools.sh && rm /tmp/install-devtools.sh
