# Ownership and cost-allocation tags.
#
# Checkov has no check for this and cannot have one: which tags matter is an
# organisation's decision, not a property of CloudFormation. That is the whole
# reason this pack exists alongside the Checkov job rather than instead of it.
#
# An untagged resource is not a broken deployment. It is a working one that
# nobody can attribute: it does not appear under any environment in Cost
# Explorer, it is not selected by a tag-based backup or patch policy, and when
# it turns up in an account sweep two years later there is nothing on it saying
# which stack would recreate it if it were deleted. Every one of those is
# discovered long after the pull request that introduced it.
package cloudformation

# Resource types this pack governs.
#
# An explicit list rather than "every resource that supports tags": most
# CloudFormation types do not take tags at all (`AWS::IAM::Policy`,
# `AWS::Lambda::Permission`, `AWS::EC2::Route`), and a rule that cannot tell
# those apart either reports them — which trains readers to ignore it — or
# guesses from whether a `Tags` property happens to be present, which exempts
# exactly the untagged resources it is looking for.
#
# What is on the list is what costs money, holds data, or grants access.
governed_tag_types := {
	"AWS::AutoScaling::AutoScalingGroup",
	"AWS::CloudFront::Distribution",
	"AWS::DynamoDB::Table",
	"AWS::EC2::SecurityGroup",
	"AWS::EC2::VPC",
	"AWS::ECS::Cluster",
	"AWS::ECS::Service",
	"AWS::ECS::TaskDefinition",
	"AWS::EKS::Cluster",
	"AWS::ElastiCache::ReplicationGroup",
	"AWS::ElasticLoadBalancingV2::LoadBalancer",
	"AWS::Events::Rule",
	"AWS::IAM::Role",
	"AWS::KMS::Key",
	"AWS::Lambda::Function",
	"AWS::Logs::LogGroup",
	"AWS::RDS::DBCluster",
	"AWS::RDS::DBInstance",
	"AWS::S3::Bucket",
	"AWS::SNS::Topic",
	"AWS::SQS::Queue",
}

# `ManagedBy` says the resource is CDK's and must not be edited in the console;
# `Stack` says which stack would recreate it. Together they are what makes an
# orphan identifiable.
#
# `Environment` is deliberately *not* required. Three stacks here are
# account-scoped rather than environment-scoped — `AppConfigStack`,
# `DoraMetricsStack`, `FeatureFlagLifecycleStack` — and carry no `Environment`
# tag because there is no true value to give them. Requiring one would mean
# inventing a value like `shared`, which reads in Cost Explorer as a fourth
# environment rather than as "spans all of them". Where the tag *is* applied,
# `environment-tag-value` below holds it to the set the stacks actually use.
required_tag_keys := {"ManagedBy", "Stack"}

allowed_environments := {"staging", "production", "preview"}

deny contains msg if {
	some resource in resources
	resource.type in governed_tag_types
	not cdk_generated(resource)

	missing := required_tag_keys - tag_keys(resource)
	count(missing) > 0

	msg := sprintf(
		"[required-tags] %s %s carries no %s tag. An untagged resource is invisible to cost allocation and unattributable in an account sweep; apply the tag at stack level with cdk.Tags.of(this).add(...).",
		[resource.type, resource.id, concat(" or ", sort(missing))],
	)
}

# CloudFormation accepts a tag *map* on a handful of types instead of the
# list-of-pairs form every type this pack governs uses. `tag_pairs` returns `[]`
# for a map, which would make `required-tags` report a resource whose tags are
# fine — or, if the shape ever flipped the other way, exempt one whose tags are
# not. Neither is acceptable from a gate, so the shape itself is the finding.
deny contains msg if {
	some resource in resources
	resource.type in governed_tag_types
	not cdk_generated(resource)

	raw := object.get(resource.properties, "Tags", [])
	not is_array(raw)

	msg := sprintf(
		"[tag-shape-unsupported] %s %s declares Tags as %s rather than a list of {Key, Value} pairs. This pack cannot read that shape, so no tag rule applies to this resource at all.",
		[resource.type, resource.id, type_name(raw)],
	)
}

deny contains msg if {
	some resource in resources
	value := tag_value(resource, "Environment")
	is_string(value)
	not value in allowed_environments

	msg := sprintf(
		"[environment-tag-value] %s %s is tagged Environment=%q, which is not one of %s. Cost and access reports group on an exact string match, so a fourth spelling is a fourth environment.",
		[resource.type, resource.id, value, concat(", ", sort(allowed_environments))],
	)
}
