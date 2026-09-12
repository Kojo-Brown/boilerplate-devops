# Durability settings on the databases, by environment.
#
# Checkov checks encryption at rest on an RDS instance (CKV_AWS_16) and a few
# neighbours, because those are true everywhere. Multi-AZ, deletion protection
# and a backup window are not: they are correct in production and deliberately
# wrong in a preview environment, which exists for two hours and whose whole
# point is to be cheap and disposable. A checker with no notion of environment
# has to either fail the preview stack or pass production, and this repository
# has both in one `cdk synth`.
#
# The environment comes from the resource's own `Environment` tag — the same tag
# `tags.rego` holds to a fixed set of values, which is what makes it usable as a
# predicate here.
package cloudformation

database_types := {"AWS::RDS::DBInstance", "AWS::RDS::DBCluster"}

# Seven days is what `RdsStack` sets and what a Monday-morning discovery of a
# Friday-evening corruption needs. Zero is CDK's default when you say nothing,
# and it silently disables automated backups altogether.
minimum_production_backup_days := 7

# Encryption is not environment-dependent: a preview database holds a copy of
# something, and the copy is the part that leaks.
deny contains msg if {
	some resource in resources
	resource.type in database_types
	object.get(resource.properties, "StorageEncrypted", false) != true

	msg := sprintf(
		"[database-not-encrypted] %s %s does not set StorageEncrypted. Encryption at rest cannot be turned on in place — it needs a snapshot, a restore and a cutover — so a database created without it stays without it.",
		[resource.type, resource.id],
	)
}

deny contains msg if {
	some resource in resources
	resource.type in database_types
	in_environment(resource, "production")
	object.get(resource.properties, "MultiAZ", false) != true

	msg := sprintf(
		"[production-database-single-az] %s %s is tagged Environment=production and is single-AZ. An AZ failure is then an outage lasting as long as a restore, and the setting cannot be changed without a failover.",
		[resource.type, resource.id],
	)
}

deny contains msg if {
	some resource in resources
	resource.type in database_types
	in_environment(resource, "production")
	object.get(resource.properties, "DeletionProtection", false) != true

	msg := sprintf(
		"[production-database-deletable] %s %s is tagged Environment=production without DeletionProtection. A stack rename, a changed logical ID or a `cdk destroy` against the wrong profile then deletes it, and the only thing standing between those and the data is a snapshot policy nobody has tested.",
		[resource.type, resource.id],
	)
}

deny contains msg if {
	some resource in resources
	resource.type in database_types
	in_environment(resource, "production")

	retention := object.get(resource.properties, "BackupRetentionPeriod", 0)
	is_number(retention)
	retention < minimum_production_backup_days

	msg := sprintf(
		"[production-database-backup-window] %s %s is tagged Environment=production and retains backups for %v day(s), below the %v this repository deploys. Zero disables automated backups entirely, which is also CDK's default when the prop is omitted.",
		[resource.type, resource.id, retention, minimum_production_backup_days],
	)
}
