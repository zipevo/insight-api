FROM node:16-alpine

RUN apk add --update --no-cache \
                            git \
                            libzmq \
                            zeromq-dev \
                            python3 \
                            make \
                            g++

WORKDIR /insight

# Copy zipcore-node
RUN git clone --branch master --single-branch --depth 1 https://github.com/zipevo/zipcore-node.git .

# Copy config file
COPY zipcore-node.json .

ARG VERSION

# Install npm packages
RUN npm ci

# Install Insight API module
RUN bin/zipcore-node install @zipevo/insight-api@${VERSION}

FROM node:16-alpine

LABEL maintainer="Zip Developers <dev@zip.org>"
LABEL description="Dockerised Insight API"

WORKDIR /insight

# Copy project files
COPY --from=0 /insight/ .

EXPOSE 3001

CMD ["bin/zipcore-node", "start"]
