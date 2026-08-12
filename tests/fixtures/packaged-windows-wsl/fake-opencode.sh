#!/bin/sh
case "${1:-}" in
  --version) printf '%s\n' 'opencode 1.18.16' ;;
  *) printf '%s\n' 'fixture OpenCode' ;;
esac
