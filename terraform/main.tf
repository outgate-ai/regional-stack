terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "gatewise-terraform-state-eu-central-1"
    key            = "regional-stack/terraform.tfstate"
    region         = "eu-central-1"
    dynamodb_table = "gatewise-terraform-locks"
    encrypt        = true
  }
}

# ECR Public requires us-east-1
provider "aws" {
  region = "us-east-1"
}

locals {
  services = toset(["gatewise-region-agent", "gatewise-log-manager", "gatewise-guardrail"])
}

resource "aws_ecrpublic_repository" "services" {
  for_each        = local.services
  repository_name = each.key

  tags = {
    Project   = "gatewise"
    ManagedBy = "terraform"
  }
}
