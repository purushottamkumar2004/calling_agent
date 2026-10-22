# One private repository per app: <prefix>/<app>. Tags are immutable (git SHA), images
# are scanned on push, and old images expire.

variable "repository_prefix" {
  type    = string
  default = "calling-agent"
}

variable "apps" {
  description = "App names, e.g. [\"api\", \"web\"]."
  type        = set(string)
}

variable "keep_tagged_images" {
  type    = number
  default = 30
}

resource "aws_ecr_repository" "app" {
  for_each             = var.apps
  name                 = "${var.repository_prefix}/${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  for_each   = aws_ecr_repository.app
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Drop untagged layers after 7 days"
        selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 7 }
        action       = { type = "expire" }
      },
      {
        rulePriority = 2
        description  = "Keep the newest ${var.keep_tagged_images} images"
        selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = var.keep_tagged_images }
        action       = { type = "expire" }
      },
    ]
  })
}

output "repository_urls" {
  description = "App name -> repository URL."
  value       = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}
