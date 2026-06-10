#!/usr/bin/env bash
# ============================================================
# start.sh — Bring the incident-status-platform back online
# Usage: bash start.sh
# ============================================================

set -e  # stop immediately if any command fails

AWS_ACCOUNT_ID="588738587198"
AWS_REGION="ap-south-1"
ECR_REPOSITORY="incident-status-platform"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TERRAFORM_DIR="$SCRIPT_DIR/infra/terraform"

echo ""
echo "========================================"
echo "  Starting incident-status-platform"
echo "========================================"
echo ""

# Step 1 — Create ECR repository
echo "[1/4] Creating ECR repository..."
cd "$TERRAFORM_DIR"
terraform apply -target=aws_ecr_repository.app -auto-approve
echo "✅ ECR repository ready"
echo ""

# Step 2 — Log in to ECR
echo "[2/4] Logging in to ECR..."
cd "$SCRIPT_DIR"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
echo "✅ Docker logged in to ECR"
echo ""

# Step 3 — Build and push Docker image
echo "[3/4] Building and pushing Docker image (this takes 2-3 mins)..."
docker build -t "${ECR_REPOSITORY}:latest" .
docker tag "${ECR_REPOSITORY}:latest" "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/${ECR_REPOSITORY}:latest"
docker push "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/${ECR_REPOSITORY}:latest"
echo "✅ Image pushed to ECR"
echo ""

# Step 4 — Deploy all infrastructure
echo "[4/4] Deploying full AWS infrastructure (this takes 5-10 mins)..."
cd "$TERRAFORM_DIR"
terraform apply -auto-approve
echo ""
echo "========================================"
echo "  ✅ App is live!"
terraform output app_url
echo "========================================"
echo ""
echo "Wait 2-3 minutes for ECS to start the container, then open the URL above."
