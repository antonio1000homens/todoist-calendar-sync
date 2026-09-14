# Security policy

## Reporting a vulnerability

Please do not publish production credentials, exploit details, private provider identifiers or sensitive logs in a public issue.

Use GitHub's private vulnerability reporting feature for this repository when available. If private vulnerability reporting is not available, contact the repository owner privately before disclosing technical details publicly.

Include enough information to reproduce and assess the issue, but redact credentials, authorization headers, provider tokens, webhook secrets and personal data.

## Secret handling

Production credentials are stored in AWS Systems Manager Parameter Store as `SecureString` values. GitHub Actions uses OIDC for AWS authentication; long-lived AWS access keys are not required by the deployment workflow.

A credential discovered in current or historical Git content must be treated as exposed and rotated/revoked. Removing or rewriting the Git object alone is not sufficient.

## Supported version

Security fixes target the current `master` branch unless a release-specific policy is introduced later.
