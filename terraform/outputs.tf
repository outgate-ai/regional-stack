output "ecr_repository_urls" {
  description = "ECR Public repository URIs for each service"
  value       = { for k, v in aws_ecrpublic_repository.services : k => v.repository_uri }
}
