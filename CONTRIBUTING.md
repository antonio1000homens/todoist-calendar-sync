# Contributing

Thanks for contributing to `todoist-calendar-sync`.

## Development requirements

- Node.js 22 or newer
- npm
- AWS SAM CLI for infrastructure validation/builds

Install dependencies:

```bash
npm ci
```

Run the complete local verification set before opening a pull request:

```bash
npm test
bash scripts/check-public-source.sh
sam validate --lint
PATH="$PWD/node_modules/.bin:$PATH" sam build
```

## Pull requests

Pull-request CI is intentionally credential-free. Do not require AWS credentials, production SSM access or protected GitHub environment configuration for normal tests.

Keep changes focused and include regression tests for behavior changes. Infrastructure changes should explain whether CloudFormation will update, replace, import or retain affected resources.

## Secrets and production configuration

Never commit production credentials or local secret/config files. In particular, do not commit:

- `.env` files;
- `config/bootstrap-ssm-migration.env`;
- `config/profile-config.env`;
- AWS access keys or private keys;
- Google/Todoist/Slack credentials;
- superseded Node-RED runtime or credential files;
- generated `dist/`, `.aws-sam/` or `node_modules/` content.

Production secrets belong in AWS SSM Parameter Store `SecureString` parameters. Environment-specific routing identifiers are supplied through the protected production environment, not source defaults.

## Production infrastructure changes

Do not combine an application change with a destructive production-state migration unless the migration has an explicit reviewed runbook and rollback path.

The legacy production-name migration is documented in `docs/production-rename.md`. Any operation that could replace/delete the DynamoDB state table or run a second active synchronizer requires an explicit production review.
