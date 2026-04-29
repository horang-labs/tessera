# Security Policy

## Supported Versions

Security fixes target the latest `main` branch unless otherwise noted.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting for this repository with:

- A clear description of the issue.
- Steps to reproduce or a proof of concept.
- Affected versions or commits, if known.
- Any logs, screenshots, or payloads with secrets removed.

We will acknowledge reports as quickly as possible and coordinate the fix before
public disclosure.

## Local Data and Secrets

Tessera is local-first and stores app data under `~/.tessera/` by default.
Do not share this directory publicly. It can contain session history, user
accounts, generated auth keys, and local configuration.
