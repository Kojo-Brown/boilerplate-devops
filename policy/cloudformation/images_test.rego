package cloudformation

task_definition_running(image) := {
	"Type": "AWS::ECS::TaskDefinition",
	"Properties": {
		"ContainerDefinitions": [{"Name": "app", "Image": image}],
		"Tags": [
			{"Key": "ManagedBy", "Value": "CDK"},
			{"Key": "Stack", "Value": "ExampleStack-Production"},
			{"Key": "Environment", "Value": "production"},
		],
	},
}

test_tagged_image_is_denied if {
	messages := deny with input as with_resource(
		"AppTaskDef",
		task_definition_running("123456789012.dkr.ecr.us-east-1.amazonaws.com/app:v1.4.2"),
	)

	rule_ids(messages) == {"image-not-digest-pinned"}
}

test_latest_tag_is_denied if {
	messages := deny with input as with_resource(
		"AppTaskDef",
		task_definition_running("public.ecr.aws/nginx/nginx:latest"),
	)

	rule_ids(messages) == {"image-not-digest-pinned"}
}

test_digest_pinned_image_passes if {
	messages := deny with input as with_resource(
		"AppTaskDef",
		task_definition_running("public.ecr.aws/nginx/nginx@sha256:3333333333333333333333333333333333333333333333333333333333333333"),
	)

	count(messages) == 0
}

# Docker's combined form — tag *and* digest. The digest wins at pull time, so
# this is pinned; the tag is documentation. ECS does not accept it, which is why
# `lib/base-images.ts` stores digest-only, but the policy should not be the
# thing that rejects a pinned reference.
test_tag_and_digest_together_passes if {
	messages := deny with input as with_resource(
		"AppTaskDef",
		task_definition_running("public.ecr.aws/nginx/nginx:1.27@sha256:4444444444444444444444444444444444444444444444444444444444444444"),
	)

	count(messages) == 0
}

# Every container is checked, not just the first. A sidecar is the one that gets
# left on a floating tag, because it is the one nobody is deploying.
test_second_container_is_checked_too if {
	messages := deny with input as with_resource("AppTaskDef", {
		"Type": "AWS::ECS::TaskDefinition",
		"Properties": {
			"ContainerDefinitions": [
				{
					"Name": "app",
					"Image": "public.ecr.aws/nginx/nginx@sha256:5555555555555555555555555555555555555555555555555555555555555555",
				},
				{"Name": "xray", "Image": "public.ecr.aws/xray/aws-xray-daemon:latest"},
			],
			"Tags": [
				{"Key": "ManagedBy", "Value": "CDK"},
				{"Key": "Stack", "Value": "ExampleStack-Production"},
				{"Key": "Environment", "Value": "production"},
			],
		},
	})

	rule_ids(messages) == {"image-not-digest-pinned"}
	count(messages) == 1
	contains(messages[_], "\"xray\"")
}

test_intrinsic_image_is_reported_not_skipped if {
	messages := deny with input as with_resource(
		"AppTaskDef",
		task_definition_running({"Fn::Sub": "${Repo}:${Tag}"}),
	)

	rule_ids(messages) == {"image-resolved-at-deploy-time"}
}

# A container with no `Image` at all is invalid CloudFormation, and the
# intrinsic rule must not claim it as a deploy-time reference — that would
# report the wrong cause for a template that fails to deploy for a different
# reason entirely.
test_container_without_image_reports_nothing_from_this_file if {
	messages := deny with input as with_resource("AppTaskDef", {
		"Type": "AWS::ECS::TaskDefinition",
		"Properties": {
			"ContainerDefinitions": [{"Name": "app"}],
			"Tags": [
				{"Key": "ManagedBy", "Value": "CDK"},
				{"Key": "Stack", "Value": "ExampleStack-Production"},
				{"Key": "Environment", "Value": "production"},
			],
		},
	})

	count(messages) == 0
}
