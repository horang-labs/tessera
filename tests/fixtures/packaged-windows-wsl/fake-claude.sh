#!/bin/sh
case "${1:-}" in
  --version) printf '%s\n' 'Claude Code 2.1.222' ;;
  auth) printf '%s\n' '{"loggedIn":true,"fixture":true}' ;;
  *) printf '%s\n' 'fixture Claude Code' ;;
esac
