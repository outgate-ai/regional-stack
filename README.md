# outgate-ai/regional-stack

Docker images for Outgate region deployments — pushed to AWS ECR Public.

## Services

| Service | Image | Description |
|---------|-------|-------------|
| **region-agent** | `public.ecr.aws/s0x2o1c6/outgate-region-agent` | Command processor — polls SQS or accepts HTTP, manages Kong configuration |
| **log-manager** | `public.ecr.aws/s0x2o1c6/outgate-log-manager` | Request logging and metrics via Redis |
| **guardrail** | `public.ecr.aws/s0x2o1c6/outgate-guardrail` | Content validation and PII anonymization |

## Structure

```
region-agent/        # Standalone Node.js (JS) + Lua filters
services/
  log-manager/       # TypeScript, depends on packages/shared
  guardrail/         # TypeScript, standalone
packages/shared/     # Shared types and utilities
```

## Deploy

Push to `main` triggers `.github/workflows/build-push.yml`:

- Builds all 3 Docker images in parallel (matrix strategy)
- Pushes to ECR Public with `latest` + SHA tags
- No auth required to pull images

### Infrastructure

Terraform in `terraform/` manages ECR Public repositories (us-east-1).
