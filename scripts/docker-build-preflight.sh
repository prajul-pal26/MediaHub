#!/usr/bin/env bash
# Keep Docker Desktop's virtual disk from reaching the host's last free blocks
# during an image build. Builder cache is disposable; named volumes and images
# are deliberately outside this guard's scope.

ensure_docker_build_space() {
  local minimum_kib=$((8 * 1024 * 1024))
  local available_kib
  available_kib=$(df -Pk . | awk 'NR == 2 { print $4 }')

  if [[ ! "$available_kib" =~ ^[0-9]+$ ]]; then
    echo "ERROR: Could not determine available disk space."
    return 1
  fi
  if (( available_kib >= minimum_kib )); then
    return 0
  fi

  echo "Low host disk space before Docker build; clearing disposable builder cache..."
  docker builder prune -af
  available_kib=$(df -Pk . | awk 'NR == 2 { print $4 }')
  if [[ ! "$available_kib" =~ ^[0-9]+$ ]] || (( available_kib < minimum_kib )); then
    echo "ERROR: Docker build needs at least 8 GiB of host free space."
    echo "No containers, images in use, or named volumes were removed."
    return 1
  fi
}
