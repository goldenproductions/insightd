# Security Policy

## Supported Versions

Insightd is pre-1.0; we support the latest minor release of the hub and agent. Older versions are not patched — please upgrade before reporting an issue you've found on a stale build. The current Docker Hub `latest` tags track the most recent `hub-v*` / `agent-v*` GitHub releases.

## Reporting a Vulnerability

If you discover a security vulnerability in insightd, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email security concerns to the repository owner via GitHub private vulnerability reporting:

1. Go to the [Security tab](../../security) of this repository
2. Click **"Report a vulnerability"**
3. Provide a description of the vulnerability, steps to reproduce, and any potential impact

You can expect an initial response within 72 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

## Scope

The following are in scope:
- Authentication and session handling
- API key management
- MQTT message handling
- Container action authorization
- Cross-site scripting (XSS) in the web UI
- SQL injection in the SQLite layer
- Remote code execution

## Out of Scope

- Denial of service against self-hosted instances
- Issues requiring physical access to the host
- Social engineering
