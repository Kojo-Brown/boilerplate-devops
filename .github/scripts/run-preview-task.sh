#!/usr/bin/env bash
#
# Run a one-off Fargate task and fail unless its container exits zero.
#
# `aws ecs run-task` returns as soon as the task is accepted, so on its own it
# reports that a seed was *scheduled*, not that it worked. A workflow that stops
# there marks the deploy green and hands over a preview with no fixtures in it —
# or worse, with half of them. This waits for the task to stop and then reads
# the container's exit code.
#
# The exit code is also absent (`None`) whenever the task never ran at all: an
# image that could not be pulled, a subnet with no route to ECR, a secret the
# execution role cannot read. Those are the failures worth catching precisely
# because nothing in the container's own logs explains them, so `stoppedReason`
# is printed for anything that is not a clean zero.
#
# Usage:
#   run-preview-task.sh <cluster> <task-definition> <subnets> <security-group> <overrides-json>
#
# <subnets> is the comma-separated list from the shared stack's output.

set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <cluster> <task-definition> <subnets> <security-group> <overrides-json>" >&2
  exit 2
fi

cluster="$1"
task_definition="$2"
subnets="$3"
security_group="$4"
overrides="$5"

task_arn=$(
  aws ecs run-task \
    --cluster "$cluster" \
    --task-definition "$task_definition" \
    --launch-type FARGATE \
    --count 1 \
    --network-configuration \
      "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${security_group}],assignPublicIp=DISABLED}" \
    --overrides "$overrides" \
    --query 'tasks[0].taskArn' \
    --output text
)

if [ -z "$task_arn" ] || [ "$task_arn" = "None" ]; then
  echo "::error::run-task returned no task ARN for ${task_definition}." >&2
  exit 1
fi

echo "Started ${task_arn}"

# `wait tasks-stopped` polls every 6 seconds up to 100 times, so a task still
# running after ten minutes falls through to the describe below and is reported
# as a failure with whatever status it is in. That is the right outcome: a seed
# that takes longer than ten minutes is a seed to go and look at.
aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn" || true

aws ecs describe-tasks --cluster "$cluster" --tasks "$task_arn" \
  --query 'tasks[0].{exitCode:containers[0].exitCode,reason:stoppedReason,status:lastStatus}' \
  --output json > task-result.json

exit_code=$(python3 -c 'import json;print(json.load(open("task-result.json")).get("exitCode"))')

if [ "$exit_code" != "0" ]; then
  echo "::error::Task ${task_arn} did not succeed (exit code: ${exit_code})." >&2
  cat task-result.json >&2
  exit 1
fi

echo "Task ${task_arn} exited 0."
