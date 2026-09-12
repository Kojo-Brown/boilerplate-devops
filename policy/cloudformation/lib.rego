# Shared helpers for the CloudFormation policy pack.
#
# Every rule in this package reads a *synthesised* CloudFormation template — the
# JSON `cdk synth` writes into `cdk.out/` — rather than the TypeScript that
# produced it. That is deliberate: a construct's props are what we asked for,
# and the template is what CloudFormation is actually given. Defaults, aspects,
# escape hatches and the L2 constructs' own opinions all resolve in between, so
# a rule written against the source can be satisfied by code that deploys
# something else.
package cloudformation

# Every resource in the template, flattened to the shape the rules want.
#
# `object.get` rather than direct field access throughout: a resource with no
# `Properties` is legal CloudFormation (`AWS::CDK::Metadata` is one), and a rule
# body that simply fails to bind on it would silently stop evaluating — the
# failure mode this whole pack exists to make impossible.
resources contains resource if {
	some id, declared in object.get(input, "Resources", {})
	resource := {
		"id": id,
		"type": object.get(declared, "Type", ""),
		"properties": object.get(declared, "Properties", {}),
	}
}

# Resources the CDK emits on our behalf and that we cannot configure.
#
# `CustomResourceProvider` is the minimal flavour of provider that predates the
# `Provider` framework: CDK synthesises the handler, its role and its inline
# code itself, exposes no props for any of it, and — the part that matters here
# — does not participate in `Tags.of()`, so a tag applied to the whole stack
# never reaches it. Every one of them in this repository is matched by the
# substring below: the CDK OIDC provider, the S3 auto-delete handler, the VPC
# default-security-group restrictor, and the EKS `CfnJson` evaluator.
#
# This is the same boundary `aws/cdk/lib/checkov-suppressions.ts` draws and for
# the same reason. Nothing this repository declares sits under that name.
cdk_generated(resource) if contains(resource.id, "CustomResourceProvider")

# A resource's `Tags` as CloudFormation's list-of-pairs form.
#
# Some resource types take a tag *map* instead. None of the types this pack
# governs do, and returning `[]` for one would silently exempt it, so
# `tag_shape_unsupported` in `tags.rego` denies that case rather than letting it
# through here.
tag_pairs(resource) := pairs if {
	pairs := object.get(resource.properties, "Tags", [])
	is_array(pairs)
} else := []

tag_keys(resource) := {key |
	some pair in tag_pairs(resource)
	key := pair.Key
	is_string(key)
}

# The value of one tag, if the resource carries it exactly once.
tag_value(resource, key) := value if {
	some pair in tag_pairs(resource)
	pair.Key == key
	value := pair.Value
}

# True when a resource is part of the environment named — read from the tag the
# stacks apply, not from the template's filename, which conftest does not put in
# `input` and which a consumer renaming a stack would change anyway.
in_environment(resource, environment) if tag_value(resource, "Environment") == environment

# A CloudFormation intrinsic (`{"Ref": …}`, `{"Fn::Sub": …}`) rather than a
# literal. Rules that reason about the *content* of a string skip these: the
# value is not known until deploy time, and asserting anything about the
# intrinsic itself asserts something about the template, not the deployment.
resolved_at_deploy_time(value) if not is_string(value)
