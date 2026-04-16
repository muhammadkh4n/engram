# Security Policy

## Supported Versions

Security updates are provided for the latest minor version of Engram. When a new minor version is released, security support for the previous minor version ends.

| Version | Status |
|---------|--------|
| 0.3.x   | Supported |
| 0.2.x   | Not supported |
| 0.1.x   | Not supported |

## Reporting a Vulnerability

Do not open a public GitHub issue for security vulnerabilities. Instead, email **muhammad@aithentic.com** with:

- Title of the vulnerability
- Description and impact
- Steps to reproduce (if applicable)
- Affected version(s)

## Response Timeline

We will:
1. Acknowledge receipt within **48 hours**
2. Provide an initial assessment within **1 week**
3. Coordinate a fix and release timeline

## What Qualifies as a Security Issue

- Authentication or authorization bypasses
- Data exposure or leakage
- SQL injection or code injection vulnerabilities
- Cryptographic weaknesses
- Denial of service attacks
- Privilege escalation

## Secure Storage of Credentials

Engram never stores API keys or secrets in code. All credentials must be provided via:
- Environment variables
- Configuration files outside version control
- Secret management services (Supabase, etc.)

If you discover hardcoded secrets, report them immediately to **muhammad@aithentic.com**.

## Thank You

Thank you for helping keep Engram secure.
