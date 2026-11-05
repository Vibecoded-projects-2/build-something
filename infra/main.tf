terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = { Project = var.project }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "reviewgate"
}

variable "target_account" {
  description = "GitHub account or organization to monitor, in lowercase."
  type        = string
}

variable "image" {
  description = "Immutable image reference, for example repo@sha256:digest."
  type        = string
  default     = ""
}

variable "release" {
  description = "Unique value that forces a rollout of both services."
  type        = string
  default     = "initial"
}

variable "enable_services" {
  description = "False provisions supporting resources without starting services."
  type        = bool
  default     = false
}

variable "review_model" {
  type    = string
  default = "claude-opus-5-5"
}

variable "monthly_budget_usd" {
  type    = number
  default = 50
}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_caller_identity" "current" {}

locals {
  zones = slice(data.aws_availability_zones.available.names, 0, 2)

  shared_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "TARGET_ACCOUNT", value = var.target_account },
    { name = "REVIEW_MODEL", value = var.review_model },
    { name = "MONTHLY_BUDGET_USD", value = tostring(var.monthly_budget_usd) },
    { name = "SQS_QUEUE_URL", value = aws_sqs_queue.reviews.url },
    { name = "AWS_REGION", value = var.region },
    { name = "APP_CONFIG_SECRET_ARN", value = aws_secretsmanager_secret.runtime.arn },
    { name = "RELEASE", value = var.release },
  ]

  log_options = {
    awslogs-group         = aws_cloudwatch_log_group.app.name
    awslogs-region        = var.region
    awslogs-stream-prefix = "app"
  }
}

# Network: two zones, with one NAT gateway as a deliberate cost and availability tradeoff.

resource "aws_vpc" "main" {
  cidr_block           = "10.40.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  availability_zone       = local.zones[count.index]
  cidr_block              = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  map_public_ip_on_launch = false
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  availability_zone = local.zones[count.index]
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index + 10)
}

resource "aws_eip" "nat" {
  domain = "vpc"
}

resource "aws_nat_gateway" "main" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "app" {
  name_prefix = "${var.project}-app-"
  vpc_id      = aws_vpc.main.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "database" {
  name_prefix = "${var.project}-db-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

# Database

resource "aws_db_subnet_group" "main" {
  name_prefix = "${var.project}-"
  subnet_ids  = aws_subnet.private[*].id
}

resource "aws_db_instance" "main" {
  identifier_prefix           = "${var.project}-"
  engine                      = "postgres"
  engine_version              = "17"
  instance_class              = "db.t4g.micro"
  allocated_storage           = 20
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "reviewgate"
  username                    = "reviewgate_admin"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.main.name
  vpc_security_group_ids      = [aws_security_group.database.id]
  publicly_accessible         = false
  backup_retention_period     = 7
  deletion_protection         = true
  skip_final_snapshot         = false
  final_snapshot_identifier   = "${var.project}-final"

  lifecycle {
    prevent_destroy = true
  }
}

# Runtime configuration. Values are written by scripts, never by Terraform.

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${var.project}/runtime"
  recovery_window_in_days = 30
}

# Queues. SQS only wakes workers. PostgreSQL holds the record of work.

resource "aws_sqs_queue" "dead" {
  name                      = "${var.project}-dead"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "reviews" {
  name                       = "${var.project}-reviews"
  visibility_timeout_seconds = 300
  message_retention_seconds  = 1209600
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dead.arn
    maxReceiveCount     = 5
  })
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.project}/application"
  retention_in_days = 30
}

# No notification destination is configured yet. See docs/deployment.md.
resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${var.project}-queue-age"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  threshold           = 600
  comparison_operator = "GreaterThanThreshold"
  dimensions          = { QueueName = aws_sqs_queue.reviews.name }
}

# Images

resource "aws_ecr_repository" "app" {
  name                 = var.project
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the most recent 20 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 20 }
      action       = { type = "expire" }
    }]
  })
}

# Identity

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name_prefix        = "${var.project}-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "infrastructure" {
  name_prefix        = "${var.project}-infra-"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "infrastructure" {
  role       = aws_iam_role.infrastructure.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices"
}

resource "aws_iam_role" "runtime" {
  name_prefix        = "${var.project}-run-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "runtime" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn]
  }

  statement {
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [aws_sqs_queue.reviews.arn]
  }
}

resource "aws_iam_role_policy" "runtime" {
  role   = aws_iam_role.runtime.id
  policy = data.aws_iam_policy_document.runtime.json
}

resource "aws_iam_role" "bootstrap" {
  name_prefix        = "${var.project}-boot-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "bootstrap" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.runtime.arn,
      aws_db_instance.main.master_user_secret[0].secret_arn,
    ]
  }

  statement {
    actions   = ["secretsmanager:PutSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn]
  }
}

resource "aws_iam_role_policy" "bootstrap" {
  role   = aws_iam_role.bootstrap.id
  policy = data.aws_iam_policy_document.bootstrap.json
}

# Compute

resource "aws_ecs_cluster" "main" {
  name = var.project

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_task_definition" "bootstrap" {
  count                    = var.image == "" ? 0 : 1
  family                   = "${var.project}-bootstrap"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.bootstrap.arn

  container_definitions = jsonencode([{
    name      = "bootstrap"
    image     = var.image
    command   = ["--import", "tsx", "server/bootstrap.ts"]
    essential = true
    environment = [
      { name = "AWS_REGION", value = var.region },
      { name = "APP_CONFIG_SECRET_ARN", value = aws_secretsmanager_secret.runtime.arn },
      { name = "DB_MASTER_SECRET_ARN", value = aws_db_instance.main.master_user_secret[0].secret_arn },
      { name = "DATABASE_HOST", value = aws_db_instance.main.address },
    ]
    logConfiguration = { logDriver = "awslogs", options = local.log_options }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  count                    = var.image == "" ? 0 : 1
  family                   = "${var.project}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.runtime.arn

  container_definitions = jsonencode([{
    name                   = "worker"
    image                  = var.image
    command                = ["--import", "tsx", "server/worker-main.ts"]
    essential              = true
    readonlyRootFilesystem = true
    environment            = local.shared_environment
    logConfiguration       = { logDriver = "awslogs", options = local.log_options }
  }])
}

resource "aws_ecs_service" "worker" {
  count           = var.enable_services ? 1 : 0
  name            = "${var.project}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker[0].arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }
}

resource "aws_ecs_express_gateway_service" "web" {
  count                   = var.enable_services ? 1 : 0
  service_name            = "${var.project}-web"
  cluster                 = aws_ecs_cluster.main.name
  execution_role_arn      = aws_iam_role.execution.arn
  infrastructure_role_arn = aws_iam_role.infrastructure.arn
  task_role_arn           = aws_iam_role.runtime.arn
  cpu                     = "256"
  memory                  = "1024"
  health_check_path       = "/api/health"

  primary_container {
    image          = var.image
    container_port = 4310

    aws_logs_configuration {
      log_group         = aws_cloudwatch_log_group.app.name
      log_stream_prefix = "web"
    }

    dynamic "environment" {
      for_each = concat(local.shared_environment, [{ name = "RUN_WORKER", value = "false" }])

      content {
        name  = environment.value.name
        value = environment.value.value
      }
    }
  }

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.app.id]
  }

  scaling_target {
    min_task_count            = 1
    max_task_count            = 2
    auto_scaling_metric       = "AVERAGE_CPU"
    auto_scaling_target_value = 65
  }
}

output "cluster" {
  value = aws_ecs_cluster.main.name
}

output "ecr_repository" {
  value = aws_ecr_repository.app.repository_url
}

output "runtime_secret_arn" {
  value = aws_secretsmanager_secret.runtime.arn
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "app_security_group_id" {
  value = aws_security_group.app.id
}

output "bootstrap_task_definition" {
  value = one(aws_ecs_task_definition.bootstrap[*].arn)
}
