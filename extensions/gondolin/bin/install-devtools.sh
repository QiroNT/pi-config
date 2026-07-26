#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  aria2 bat bzip2 ca-certificates cargo clang clangd cmake curl default-jdk-headless \
  direnv dnsutils fd-find file fzf g++ gcc gdb git golang-go hyperfine jq less \
  lldb luajit make nano neovim netcat-openbsd ninja-build nodejs npm \
  openssh-client pkg-config python3 python3-dev python3-pip python3-venv \
  ripgrep rsync rustc shellcheck shfmt socat sqlite3 strace tmux tree unzip \
  valgrind vim wget whois xxd xz-utils zip zsh \
  zstd

# Debian renames these executables to avoid package-name collisions.
ln -sf /usr/bin/fdfind /usr/local/bin/fd
ln -sf /usr/bin/batcat /usr/local/bin/bat

# JS tooling used across repositories. Keep this global so /root can remain a
# runtime tmpfs without hiding installed tools.
npm install --global \
  @ast-grep/cli @biomejs/biome bun dprint eslint markdownlint-cli pnpm prettier yarn

# The CI base image keeps its current Node toolchain under /opt. Expose its
# global executables through the stable system-wide path baked into the VM.
global_node_prefix=$(npm prefix --global)
for executable in "$global_node_prefix"/bin/*; do
  [ -f "$executable" ] || [ -L "$executable" ] || continue
  ln -sf "$executable" "/usr/local/bin/$(basename "$executable")"
done

# uv's installer supports a system-wide destination explicitly.
UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 \
  sh -c "$(curl -LsSf https://astral.sh/uv/install.sh)"

apt-get clean
rm -rf /var/lib/apt/lists/* /root/.npm /root/.cache
