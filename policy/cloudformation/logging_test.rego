package cloudformation

log_group(environment, properties) := {
	"Type": "AWS::Logs::LogGroup",
	"Properties": object.union(
		properties,
		{"Tags": [
			{"Key": "ManagedBy", "Value": "CDK"},
			{"Key": "Stack", "Value": "EcsStack"},
			{"Key": "Environment", "Value": environment},
		]},
	),
}

test_retention_unset_is_denied if {
	messages := deny with input as with_resource("Logs", log_group("staging", {}))

	rule_ids(messages) == {"log-retention-unset"}
}

test_retention_cloudwatch_rejects_is_denied if {
	messages := deny with input as with_resource("Logs", log_group("staging", {"RetentionInDays": 45}))

	rule_ids(messages) == {"log-retention-invalid"}
}

test_accepted_retention_passes if {
	messages := deny with input as log_group_template(90)

	count(messages) == 0
}

log_group_template(days) := with_resource("Logs", log_group("production", {"RetentionInDays": days}))

test_production_below_floor_is_denied if {
	messages := deny with input as log_group_template(7)

	rule_ids(messages) == {"production-log-retention-floor"}
}

# The floor is what production is held to. Staging deliberately is not: a short
# retention there is a cost decision, not an incident-review risk.
test_staging_below_production_floor_passes if {
	messages := deny with input as with_resource("Logs", log_group("staging", {"RetentionInDays": 3}))

	count(messages) == 0
}

test_production_at_the_floor_passes if {
	messages := deny with input as log_group_template(14)

	count(messages) == 0
}

# An unset retention on a production log group is both findings at once: it is
# not a valid retention *and* it is below the floor in the only sense that
# matters — except the floor rule cannot fire, because there is no number to
# compare. Reporting only `log-retention-unset` is correct; silently reporting
# neither is what a rule written with a bare field access would do.
test_production_retention_unset_reports_the_unset_rule_only if {
	messages := deny with input as with_resource("Logs", log_group("production", {}))

	rule_ids(messages) == {"log-retention-unset"}
	count(messages) == 1
}

# `RetentionInDays` given as a CloudFormation parameter reference. The value
# rules cannot read it, but the resource does set the property, so
# `log-retention-unset` must not fire either — a template that is checkable in
# principle should not be reported as if the property were missing.
test_intrinsic_retention_is_not_reported_as_unset if {
	messages := deny with input as with_resource(
		"Logs",
		log_group("staging", {"RetentionInDays": {"Ref": "RetentionParameter"}}),
	)

	count(messages) == 0
}
