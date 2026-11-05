# Deployment

Nothing here runs automatically. Provisioning creates recurring AWS charges, so review
every plan and get billing approval first. Rough cost for a low-traffic environment is
$100 to $130 a month plus model usage, from the handoff's October 2026 estimate.
Re-check current prices before provisioning.

`infra/` has not been validated with `terraform validate` or a plan. Do that first,
and expect to correct details such as the Express Mode resource schema and the
infrastructure role's managed policy name against your provider version.

## 1. Choose the environment

Decide the AWS account, region, GitHub target, names, and budget. Use a metadata-only
call to confirm your identity:

```sh
aws sts get-caller-identity --query Account --output text
```

## 2. Provision without services

For a brand-new environment the state bucket does not exist yet, so move
`infra/backend.tf` aside to start with local state. Keep that state private.

```sh
terraform -chdir=infra init
terraform -chdir=infra plan -var target_account=YOUR-ACCOUNT -out=bootstrap.tfplan
terraform -chdir=infra apply bootstrap.tfplan
```

`enable_services` defaults to false. That is right for this step only.

## 3. Move state to the encrypted bucket

Restore `infra/backend.tf`, then:

```sh
terraform -chdir=infra init -migrate-state \
  -backend-config=bucket=YOUR-BUILD-BUCKET \
  -backend-config=key=state/reviewgate.tfstate \
  -backend-config=region=YOUR-AWS-REGION \
  -backend-config=encrypt=true \
  -backend-config=use_lockfile=true
```

## 4. Build an immutable image

```sh
python3 scripts/cloud-build.py --bucket=YOUR-BUILD-BUCKET
```

Wait for that build, then find its digest in ECR. Never deploy a moving tag.

## 5. Set the image and bootstrap the database

Create `.deployment/production.tfvars.json`, which Git ignores:

```json
{
  "target_account": "YOUR-ACCOUNT",
  "image": "YOUR-ECR-REPOSITORY@sha256:YOUR-VERIFIED-DIGEST",
  "release": "YOUR-UNIQUE-RELEASE-ID",
  "enable_services": false
}
```

Apply a reviewed plan with that file. Then publish local admin and model values:

```sh
node --import tsx scripts/publish-secrets.ts \
  --secret=YOUR-RUNTIME-SECRET-ARN \
  --origin=https://pending.invalid
```

Run the `bootstrap_task_definition` output as a Fargate task in the private subnets
with the application security group. Confirm exit code 0 before continuing.

## 6. Start services and set the real origin

Set `enable_services` to true with a new `release`, then review and apply. Find the
real HTTPS endpoint from the service, then:

```sh
node --import tsx scripts/publish-secrets.ts \
  --secret=YOUR-RUNTIME-SECRET-ARN \
  --origin=https://YOUR-REAL-ORIGIN
```

Roll both services with another `release`. Secrets are read at startup only.

Use the variable file on every later plan. Without it, the defaults remove the
services:

```sh
terraform -chdir=infra plan -var-file=../.deployment/production.tfvars.json
```

## 7. Register and install the GitHub App

```sh
node --import tsx scripts/github-setup.ts --origin=https://YOUR-REAL-ORIGIN --owner-type=organization
```

Open http://localhost:4311 while signed in as an owner of the target. Install with
**All repositories** to cover every existing and future repository. Publish the new
credentials, then restart both services.

## 8. Prove the full flow

A working dashboard, a model smoke test, or another product's review is not proof.
Open a disposable PR in the target and confirm that a signed delivery is accepted, a
job runs, the App posts an inline comment on the intended line, and the same run and
comment IDs appear in the real dashboard. Then push a fix and confirm a new commit-pair
run. Do not merge a deliberately broken fixture.

## Before customers

- Add a real destination for the queue-age alarm.
- Define data retention and deletion. Findings can contain code excerpts.
- Give web and worker separate IAM roles.
- Review the in-memory login limiter before running more than one web task.

## Rollback

Reapply the previous image digest with a new `release`. Do not destroy the database,
runtime secret, or state to roll back application code. Check a run's remote marker
before retrying a stuck publication.
