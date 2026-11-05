# Private bucket for build sources (source/*) and remote state (state/*).

resource "aws_s3_bucket" "build" {
  bucket_prefix = "${var.project}-build-"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "build" {
  bucket                  = aws_s3_bucket.build.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "build" {
  bucket = aws_s3_bucket.build.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "build" {
  bucket = aws_s3_bucket.build.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "build_bucket" {
  statement {
    sid       = "RequireTls"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.build.arn, "${aws_s3_bucket.build.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "build" {
  bucket = aws_s3_bucket.build.id
  policy = data.aws_iam_policy_document.build_bucket.json
}

data "aws_iam_policy_document" "codebuild_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["codebuild.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "build" {
  name_prefix        = "${var.project}-build-"
  assume_role_policy = data.aws_iam_policy_document.codebuild_assume.json
}

# Deliberately narrow: this role cannot read state/* or any runtime secret.
data "aws_iam_policy_document" "build" {
  statement {
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.build.arn}/source/*"]
  }

  statement {
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/codebuild/${var.project}-image*"]
  }
}

resource "aws_iam_role_policy" "build" {
  role   = aws_iam_role.build.id
  policy = data.aws_iam_policy_document.build.json
}

resource "aws_codebuild_project" "image" {
  name          = "${var.project}-image"
  service_role  = aws_iam_role.build.arn
  build_timeout = 20

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    type            = "LINUX_CONTAINER"
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/standard:7.0"
    privileged_mode = true

    environment_variable {
      name  = "ECR_REPOSITORY"
      value = aws_ecr_repository.app.repository_url
    }
  }

  source {
    type      = "S3"
    location  = "${aws_s3_bucket.build.bucket}/source/"
    buildspec = "scripts/buildspec.yml"
  }
}

output "build_bucket" {
  value = aws_s3_bucket.build.bucket
}
