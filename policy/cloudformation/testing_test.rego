# Shared helpers for the policy unit tests.
#
# `conftest verify` runs every `test_*` rule in this package. The rest of this
# file is support: extracting rule ids out of messages, and a compliant template
# each test mutates in exactly one way.
#
# Asserting on the *set of rule ids* rather than on a message count is the point
# of the `[rule-id]` prefix every rule carries. A test that only counts failures
# passes when the rule under test stops firing and an unrelated one starts —
# which is precisely the accident a policy refactor produces.
package cloudformation

rule_ids(messages) := {groups[1] |
	some msg in messages
	some groups in regex.find_all_string_submatch_n(`^\[([a-z-]+)\]`, msg, 1)
}

# A template every rule in this pack passes. Tests break one thing in it.
compliant_template := {"Resources": {
	"AppLogGroup": {
		"Type": "AWS::Logs::LogGroup",
		"Properties": {
			"RetentionInDays": 30,
			"Tags": [
				{"Key": "ManagedBy", "Value": "CDK"},
				{"Key": "Stack", "Value": "ExampleStack-Production"},
				{"Key": "Environment", "Value": "production"},
			],
		},
	},
	"AppTaskDef": {
		"Type": "AWS::ECS::TaskDefinition",
		"Properties": {
			"ContainerDefinitions": [{
				"Name": "app",
				"Image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/app@sha256:1111111111111111111111111111111111111111111111111111111111111111",
			}],
			"Tags": [
				{"Key": "ManagedBy", "Value": "CDK"},
				{"Key": "Stack", "Value": "ExampleStack-Production"},
				{"Key": "Environment", "Value": "production"},
			],
		},
	},
}}

# Replace one resource in the compliant template, leaving the rest alone.
with_resource(id, resource) := object.union(
	compliant_template,
	{"Resources": object.union(compliant_template.Resources, {id: resource})},
)

# The compliant template must actually be compliant, or every test below is
# asserting against a baseline that already fails and the assertions mean
# nothing. This is the first thing to check when a new rule is added.
test_baseline_template_is_clean if {
	messages := deny with input as compliant_template
	count(messages) == 0
}

test_empty_template_is_clean if {
	messages := deny with input as {"Resources": {}}
	count(messages) == 0
}

# A template with no `Resources` key at all — `cdk synth` never writes one, but
# conftest happily hands this pack any JSON it is pointed at, and a rule body
# that fails to bind stops evaluating silently.
test_template_without_resources_is_clean if {
	messages := deny with input as {"Description": "nothing here"}
	count(messages) == 0
}
