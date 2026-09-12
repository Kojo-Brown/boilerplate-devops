# Log group retention.
#
# A log group created without `RetentionInDays` keeps everything forever. That
# is not a failure anybody notices: the logs are there, the queries work, and
# the bill grows by an amount too small to investigate until several years of
# several environments have accumulated in it. CDK's `logs.LogGroup` defaults to
# exactly this, and so does every log group CloudWatch auto-creates for a Lambda
# that was never given one.
package cloudformation

# CloudWatch Logs accepts only these values. Anything else is rejected at deploy
# time, which is a failed stack update at the end of a pipeline rather than a
# red check on the pull request that introduced it.
accepted_retention_days := {
	1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365,
	400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653,
}

# A floor, not a target: 14 days is the shortest retention any production log
# group in this repository currently sets, so the rule ratchets what is already
# true rather than demanding a change this item did not ask for. Raise it
# deliberately, with the cost in front of you.
minimum_production_retention_days := 14

deny contains msg if {
	some resource in resources
	resource.type == "AWS::Logs::LogGroup"
	not has_retention(resource)

	msg := sprintf(
		"[log-retention-unset] %s %s sets no RetentionInDays, so it retains logs forever. Nothing fails and nothing alerts; the cost simply never stops.",
		[resource.type, resource.id],
	)
}

deny contains msg if {
	some resource in resources
	resource.type == "AWS::Logs::LogGroup"
	retention := object.get(resource.properties, "RetentionInDays", null)
	is_number(retention)
	not retention in accepted_retention_days

	msg := sprintf(
		"[log-retention-invalid] %s %s asks for %v days, which CloudWatch Logs does not accept. The stack update fails at deploy time; the accepted values are %s.",
		[resource.type, resource.id, retention, concat(", ", [sprintf("%v", [days]) | some days in sort(accepted_retention_days)])],
	)
}

deny contains msg if {
	some resource in resources
	resource.type == "AWS::Logs::LogGroup"
	in_environment(resource, "production")
	retention := object.get(resource.properties, "RetentionInDays", null)
	is_number(retention)
	retention < minimum_production_retention_days

	msg := sprintf(
		"[production-log-retention-floor] %s %s is tagged Environment=production and retains %v day(s), below the %v this repository holds itself to. An incident review that starts on Monday cannot read a log that expired on Sunday.",
		[resource.type, resource.id, retention, minimum_production_retention_days],
	)
}

has_retention(resource) if {
	retention := object.get(resource.properties, "RetentionInDays", null)
	retention != null
}
