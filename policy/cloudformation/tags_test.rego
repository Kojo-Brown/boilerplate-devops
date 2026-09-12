package cloudformation

tagged_role(tags) := {
	"Type": "AWS::IAM::Role",
	"Properties": {"Tags": tags},
}

test_missing_stack_tag_is_denied if {
	messages := deny with input as with_resource(
		"DeployRole",
		tagged_role([{"Key": "ManagedBy", "Value": "CDK"}]),
	)

	rule_ids(messages) == {"required-tags"}
	count(messages) == 1
}

test_missing_every_required_tag_is_reported_once if {
	messages := deny with input as with_resource("DeployRole", tagged_role([]))

	count(messages) == 1
	contains(messages[_], "carries no ManagedBy or Stack tag")
}

test_resource_with_no_tags_property_is_denied if {
	messages := deny with input as with_resource(
		"DeployRole",
		{"Type": "AWS::IAM::Role", "Properties": {}},
	)

	rule_ids(messages) == {"required-tags"}
}

test_resource_with_no_properties_is_denied if {
	messages := deny with input as with_resource("DeployRole", {"Type": "AWS::IAM::Role"})

	rule_ids(messages) == {"required-tags"}
}

# The exemption exists for CDK's own custom-resource providers, which
# `Tags.of()` does not reach. It is keyed on the construct name CDK gives them.
test_cdk_custom_resource_provider_is_exempt if {
	messages := deny with input as with_resource(
		"CustomS3AutoDeleteObjectsCustomResourceProviderRole3B1BD092",
		{"Type": "AWS::IAM::Role", "Properties": {}},
	)

	count(messages) == 0
}

# ...and only for those. A resource that merely mentions "Custom" is ours.
test_resource_named_custom_is_not_exempt if {
	messages := deny with input as with_resource(
		"CustomerImportRole",
		{"Type": "AWS::IAM::Role", "Properties": {}},
	)

	rule_ids(messages) == {"required-tags"}
}

# Untagged types this pack does not govern — an IAM policy takes no tags at all,
# so reporting it would be noise that trains readers to skim the output.
test_ungoverned_type_is_not_required_to_carry_tags if {
	messages := deny with input as with_resource(
		"DeployPolicy",
		{"Type": "AWS::IAM::Policy", "Properties": {}},
	)

	count(messages) == 0
}

test_tag_map_shape_is_denied_rather_than_silently_exempt if {
	messages := deny with input as with_resource(
		"DataBucket",
		{"Type": "AWS::S3::Bucket", "Properties": {"Tags": {"ManagedBy": "CDK", "Stack": "S"}}},
	)

	# Both rules fire: the shape is unreadable, and because it is unreadable the
	# required tags cannot be confirmed. Reporting only the second would send a
	# reader looking for a missing tag that is right there in the template.
	rule_ids(messages) == {"tag-shape-unsupported", "required-tags"}
}

test_unknown_environment_value_is_denied if {
	messages := deny with input as with_resource("AppTaskDef", {
		"Type": "AWS::ECS::TaskDefinition",
		"Properties": {
			"ContainerDefinitions": [{
				"Name": "app",
				"Image": "public.ecr.aws/nginx/nginx@sha256:2222222222222222222222222222222222222222222222222222222222222222",
			}],
			"Tags": [
				{"Key": "ManagedBy", "Value": "CDK"},
				{"Key": "Stack", "Value": "ExampleStack-Prod"},
				{"Key": "Environment", "Value": "prod"},
			],
		},
	})

	rule_ids(messages) == {"environment-tag-value"}
}

# The value rule is not restricted to governed types: an `Environment` tag on
# anything at all is a cost-allocation key, and a misspelling on a subnet splits
# the report exactly as badly as one on a database.
test_environment_value_is_checked_on_ungoverned_types_too if {
	messages := deny with input as with_resource("Subnet", {
		"Type": "AWS::EC2::Subnet",
		"Properties": {"Tags": [{"Key": "Environment", "Value": "Production"}]},
	})

	rule_ids(messages) == {"environment-tag-value"}
}

test_absent_environment_tag_is_allowed if {
	messages := deny with input as with_resource("SweepRule", {
		"Type": "AWS::Events::Rule",
		"Properties": {"Tags": [
			{"Key": "ManagedBy", "Value": "CDK"},
			{"Key": "Stack", "Value": "FeatureFlagLifecycleStack"},
		]},
	})

	count(messages) == 0
}
